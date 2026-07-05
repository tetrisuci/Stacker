import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseReplay, checkReconstructionSupport } from "./parse";
import { reconstructReplay, type Placement } from "./reconstruct";
import { capReconstruction, detectDriftCap, DRIFT_CLEARLESS_RUN } from "./zenith";

const dataPath = (name: string) =>
  fileURLToPath(new URL(`../../test_data/${name}`, import.meta.url));

/** A minimal synthetic placement with the given index and clear count. */
function placement(pieceIndex: number, clears: number): Placement {
  return {
    pieceIndex,
    piece: "t",
    frame: pieceIndex * 10,
    x: 4,
    y: 0,
    rot: 0,
    wasHold: false,
    spin: "none",
    clears,
    snapshot: {} as Placement["snapshot"],
  };
}

/** A track where every `period`-th placement clears one line. */
function trackWithClearsEvery(period: number, length: number): Placement[] {
  return Array.from({ length }, (_, i) =>
    placement(i, i % period === period - 1 ? 1 : 0),
  );
}

describe("detectDriftCap", () => {
  it("returns null for a track that keeps clearing lines", () => {
    expect(detectDriftCap(trackWithClearsEvery(4, 500))).toBeNull();
  });

  it("returns null for a clearless run shorter than the threshold", () => {
    const track = [
      ...trackWithClearsEvery(4, 100),
      ...Array.from({ length: DRIFT_CLEARLESS_RUN - 1 }, (_, i) =>
        placement(100 + i, 0),
      ),
    ];
    expect(detectDriftCap(track)).toBeNull();
  });

  it("returns the start of the first long clearless run", () => {
    const track = [
      ...trackWithClearsEvery(4, 100), // last clear at piece 99
      ...Array.from({ length: DRIFT_CLEARLESS_RUN }, (_, i) =>
        placement(100 + i, 0),
      ),
    ];
    expect(detectDriftCap(track)).toBe(100);
  });
});

describe("capReconstruction", () => {
  it("truncates the track and recomputes totals", () => {
    const track = trackWithClearsEvery(2, 10); // clears at odd indexes
    const garbageAt = (beforePiece: number, amount: number) => ({
      beforePiece,
      amount,
      rows: [{ column: 4, amount, size: 1, id: beforePiece }],
    });
    const result = {
      track,
      pieces: 10,
      lines: 5,
      frame: 90,
      garbage: [garbageAt(2, 1), garbageAt(7, 3)],
      engine: null as never,
    };
    const capped = capReconstruction(result, 6);
    expect(capped.track.length).toBe(6);
    expect(capped.pieces).toBe(6);
    expect(capped.lines).toBe(3); // clears at 1, 3, 5
    expect(capped.frame).toBe(50);
    expect(capped.garbage).toEqual([garbageAt(2, 1)]);
  });
});

describe("zenith replay end-to-end (real file)", () => {
  it("reconstructs with 7-bag and detects a drift cap", () => {
    const parsed = parseReplay(
      readFileSync(dataPath("promooooooo_zenith.ttr"), "utf8"),
    );
    if (!parsed.ok) throw new Error("parse failed");
    expect(parsed.replay.metadata.bagtype).toBe("zenith");
    expect(parsed.replay.options.bagtype).toBe("7-bag");

    const check = checkReconstructionSupport(parsed.replay);
    expect(check.supported).toBe(true);
    expect(check.partial).toBeTruthy();

    const result = reconstructReplay(parsed.replay);
    const cap = detectDriftCap(result.track);
    // The 7-bag stand-in tracks this run for ~340 pieces before drifting; the
    // exact cap may shift with engine versions, so assert a sane range.
    expect(cap).not.toBeNull();
    expect(cap!).toBeGreaterThan(100);
    expect(cap!).toBeLessThan(result.track.length);

    const capped = capReconstruction(result, cap!);
    expect(capped.track.length).toBe(cap);
    // The kept prefix must still be real play: it clears lines regularly.
    expect(capped.lines).toBeGreaterThan(50);
  });
});
