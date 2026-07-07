// TETR.IO's `no_szo` option (first piece may not be S, Z, or O). The bag
// deals the raw seeded shuffle; buildProEngine applies the swap correction.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseReplay } from "./parse";
import { noSzoCorrection } from "./proEngine";
import { reconstructReplay } from "./reconstruct";

// The engine has already spawned the raw first piece when the correction
// runs, so the function sees (falling, rest-of-queue) rather than the bag.
// The offender rotates to the BACK of the opening bag (verified against the
// nuewink.ttr ground truth below).
describe("noSzoCorrection", () => {
  it("rotates a forbidden spawned piece to the back of the opening bag", () => {
    // Raw bag s l i j o t z (+ next bag) → falling s, queue is the rest.
    const queue = ["l", "i", "j", "o", "t", "z", "z", "i"];
    expect(noSzoCorrection("s", queue)).toBe("l");
    // Played order: l i j o t z s, then the next bag continues.
    expect(queue).toEqual(["i", "j", "o", "t", "z", "s", "z", "i"]);
  });

  it("keeps rotating while forbidden pieces lead", () => {
    // Raw bag z s o t i l j → falling z, queue s o t i l j.
    const queue = ["s", "o", "t", "i", "l", "j"];
    expect(noSzoCorrection("z", queue)).toBe("t");
    // Played order: t i l j z s o.
    expect(queue).toEqual(["i", "l", "j", "z", "s", "o"]);
  });

  it("leaves an allowed spawn untouched", () => {
    const queue = ["z", "s", "o", "i", "l", "j"];
    expect(noSzoCorrection("t", queue)).toBeNull();
    expect(queue).toEqual(["z", "s", "o", "i", "l", "j"]);
  });

  it("gives up when no allowed piece exists (not reachable with real bags)", () => {
    const queue = ["s", "z", "o"];
    expect(noSzoCorrection("s", queue)).toBeNull();
    expect(queue).toEqual(["s", "z", "o"]);
  });
});

// Integration: a real 40L replay whose seed deals S first with no_szo on.
// Without the correction the whole run reconstructs against a shifted queue
// and the line count comes out wrong; with it, the run completes exactly.
const SAMPLE = fileURLToPath(
  new URL("../../test_data/nuewink.ttr", import.meta.url),
);

describe.skipIf(!existsSync(SAMPLE))("no_szo integration (nuewink.ttr)", () => {
  it("reconstructs the full 40-line run once the first piece is corrected", () => {
    const parsed = parseReplay(readFileSync(SAMPLE, "utf8"));
    if (!parsed.ok) throw new Error(parsed.error);
    const result = reconstructReplay(parsed.replay);
    expect(result.track.length).toBe(101); // piecesplaced in results
    expect(result.lines).toBe(40); // it's a finished 40L run
  });
});
