import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseReplay, checkReconstructionSupport } from "./parse";
import { reconstructReplay, groupEventsByFrame } from "./reconstruct";

const dataPath = (name: string) =>
  fileURLToPath(new URL(`../../test_data/${name}`, import.meta.url));

function loadReplay(name: string) {
  const text = readFileSync(dataPath(name), "utf8");
  const parsed = parseReplay(text);
  if (!parsed.ok) throw new Error(`parse failed: ${parsed.error}`);
  return parsed.replay;
}

describe("groupEventsByFrame", () => {
  it("buckets events by their integer frame", () => {
    const events = [
      { frame: 0, type: "start", data: {} },
      { frame: 0, type: "keydown", data: { subframe: 0.5 } },
      { frame: 2, type: "keydown", data: { subframe: 0 } },
    ];
    const grouped = groupEventsByFrame(events);
    expect(grouped.get(0)).toHaveLength(2);
    expect(grouped.get(2)).toHaveLength(1);
    expect(grouped.get(1)).toBeUndefined();
  });
});

describe("40L golden reconstruction (promooooooo_40l.ttr)", () => {
  // Known values from the replay's own results block:
  //   stats.piecesplaced = 101, stats.lines = 40 (10 quads).
  const EXPECTED_PIECES = 101;
  const EXPECTED_LINES = 40;

  it("parses and is reconstruction-supported", () => {
    const replay = loadReplay("promooooooo_40l.ttr");
    expect(replay.gamemode).toBe("40l");
    expect(replay.metadata.bagtype).toBe("7-bag");
    expect(checkReconstructionSupport(replay).supported).toBe(true);
  });

  it("reproduces the known piece and line counts", () => {
    const replay = loadReplay("promooooooo_40l.ttr");
    const result = reconstructReplay(replay);

    expect(result.pieces).toBe(EXPECTED_PIECES);
    expect(result.lines).toBe(EXPECTED_LINES);
    // One placement recorded per locked piece.
    expect(result.track).toHaveLength(EXPECTED_PIECES);
  });

  it("records well-formed placements in order", () => {
    const replay = loadReplay("promooooooo_40l.ttr");
    const { track } = reconstructReplay(replay);

    track.forEach((p, i) => {
      expect(p.pieceIndex).toBe(i);
      expect(p.piece).toMatch(/^[iojlstz]$/);
      expect(typeof p.frame).toBe("number");
      expect(typeof p.wasHold).toBe("boolean");
      expect(p.snapshot.board).toHaveLength(40); // 20 visible + 20 buffer
    });

    // The results report 30 holds and 10 line-clearing placements (quads).
    expect(track.filter((p) => p.wasHold)).toHaveLength(30);
    const clearing = track.filter((p) => p.clears > 0);
    expect(clearing).toHaveLength(10);
    expect(clearing.every((p) => p.clears === 4)).toBe(true);

    // Frames are non-decreasing across the track.
    for (let i = 1; i < track.length; i++) {
      expect(track[i].frame).toBeGreaterThanOrEqual(track[i - 1].frame);
    }
  });

  it("is deterministic across runs", () => {
    const a = reconstructReplay(loadReplay("promooooooo_40l.ttr"));
    const b = reconstructReplay(loadReplay("promooooooo_40l.ttr"));
    expect(b.pieces).toBe(a.pieces);
    expect(b.lines).toBe(a.lines);
    expect(b.track.map((p) => [p.piece, p.x, p.y, p.rot])).toEqual(
      a.track.map((p) => [p.piece, p.x, p.y, p.rot]),
    );
  });
});

describe("Zenith replay is partially supported (promooooooo_zenith.ttr)", () => {
  it("parses and is reconstruction-supported with a partial caption", () => {
    const replay = loadReplay("promooooooo_zenith.ttr");
    expect(replay.gamemode).toBe("zenith");
    const support = checkReconstructionSupport(replay);
    expect(support.supported).toBe(true);
    expect(support.partial).toMatch(/Zenith/i);
  });
});
