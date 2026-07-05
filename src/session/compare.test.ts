import { describe, it, expect } from "vitest";
import {
  comparePlacement,
  boardsEqual,
  toOccupancy,
  columnHeights,
  countHoles,
  bumpiness,
  boardMetrics,
  computeDivergence,
  summarize,
  type PlacementRecord,
} from "./compare";

// Build a small boolean board from an array of strings (top row first, "#"=filled).
// Returned bottom-up (board[0] is the bottom) to match the engine convention.
function grid(rows: string[]): boolean[][] {
  const bottomUp = [...rows].reverse();
  return bottomUp.map((r) => [...r].map((c) => c === "#"));
}

function place(over: Partial<PlacementRecord>): PlacementRecord {
  return {
    piece: "t",
    x: 4,
    y: 1,
    rot: 0,
    spin: "none",
    clears: 0,
    board: grid(["....", "...."]),
    ...over,
  };
}

describe("boardsEqual / toOccupancy", () => {
  it("compares occupancy grids", () => {
    expect(boardsEqual(grid(["#."]), grid(["#."]))).toBe(true);
    expect(boardsEqual(grid(["#."]), grid([".#"]))).toBe(false);
    expect(boardsEqual(grid(["#"]), grid(["#", "."]))).toBe(false);
  });

  it("converts an engine-style board to booleans", () => {
    const board = [
      [null, { mino: "t" }],
      [{ mino: "i" }, null],
    ];
    expect(toOccupancy(board)).toEqual([
      [false, true],
      [true, false],
    ]);
  });
});

describe("comparePlacement", () => {
  const proBoard = grid(["....", "#.#."]);
  const pro = place({ piece: "t", x: 4, rot: 0, spin: "none", clears: 0, board: proBoard });

  it("matches an identical placement", () => {
    const r = comparePlacement(place({ board: proBoard }), pro);
    expect(r.match).toBe(true);
    expect(r.columnMismatch).toBe(false);
    expect(r.rotationMismatch).toBe(false);
    expect(r.cellsMismatch).toBe(false);
  });

  it("flags a wrong column when the cells also differ", () => {
    // A genuinely different column produces different cells, so column is
    // reported alongside the cell mismatch.
    const r = comparePlacement(
      place({ x: 2, board: grid(["....", ".#.#"]) }),
      pro,
    );
    expect(r.match).toBe(false);
    expect(r.columnMismatch).toBe(true);
  });

  it("flags a wrong rotation when the cells also differ", () => {
    const r = comparePlacement(
      place({ rot: 2, board: grid(["....", "###."]) }),
      pro,
    );
    expect(r.match).toBe(false);
    expect(r.rotationMismatch).toBe(true);
  });

  it("treats a cell-identical placement as a match even if the reported column/rotation differ", () => {
    // Regression: an I piece laid flat occupies the same 4 cells whether the
    // engine reports rotation 0 or 2 (anchor x offset by one). The pro and the
    // learner reached the same physical placement via different coordinates, so
    // it must count as a match — not "wrong column, wrong rotation".
    const r = comparePlacement(
      place({ x: 5, rot: 2, board: proBoard }),
      pro,
    );
    expect(r.match).toBe(true);
    expect(r.cellsMismatch).toBe(false);
    // Column/rotation are suppressed when the cells already agree.
    expect(r.columnMismatch).toBe(false);
    expect(r.rotationMismatch).toBe(false);
  });

  it("flags mismatched resulting cells", () => {
    const r = comparePlacement(place({ board: grid(["....", "##.."]) }), pro);
    expect(r.match).toBe(false);
    expect(r.cellsMismatch).toBe(true);
  });

  it("flags spin and clear mismatches without failing on them alone", () => {
    const spin = comparePlacement(
      place({ board: proBoard, spin: "normal" }),
      pro,
    );
    expect(spin.spinMismatch).toBe(true);
    expect(spin.match).toBe(true); // cells still match

    const clr = comparePlacement(place({ board: proBoard, clears: 1 }), pro);
    expect(clr.clearMismatch).toBe(true);
    expect(clr.match).toBe(true);
  });

  it("flags a different piece type", () => {
    const r = comparePlacement(place({ piece: "l", board: proBoard }), pro);
    expect(r.pieceMismatch).toBe(true);
  });
});

describe("board metrics", () => {
  it("computes column heights", () => {
    // columns: 0 -> height 2, 1 -> 0, 2 -> 1
    const b = grid(["#..", "#.#"]);
    expect(columnHeights(b)).toEqual([2, 0, 1]);
  });

  it("counts holes (covered empties)", () => {
    // col 0: filled top, empty below -> 1 hole
    const b = grid(["#", ".", "#"]);
    expect(countHoles(b)).toBe(1);
    expect(countHoles(grid(["#", "#"]))).toBe(0);
  });

  it("computes bumpiness", () => {
    // heights [2,0,1] -> |2-0| + |0-1| = 3
    expect(bumpiness(grid(["#..", "#.#"]))).toBe(3);
    expect(bumpiness(grid(["##", "##"]))).toBe(0);
  });

  it("aggregates metrics", () => {
    const m = boardMetrics(grid(["#..", "#.#"]));
    expect(m.aggregateHeight).toBe(3); // 2+0+1
    expect(m.bumpiness).toBe(3);
    expect(m.holes).toBe(0);
  });
});

describe("computeDivergence + summary", () => {
  const match = { match: true } as any;
  const miss = { match: false } as any;

  it("counts matched pieces and the first (smallest-index) divergence", () => {
    const s = computeDivergence([
      { index: 10, result: match },
      { index: 11, result: miss }, // first divergence at 11
      { index: 12, result: miss },
    ]);
    expect(s.compared).toBe(3);
    expect(s.matched).toBe(1);
    expect(s.firstDivergence).toBe(11);
  });

  it("stays null when everything matches", () => {
    const s = computeDivergence([
      { index: 0, result: match },
      { index: 1, result: match },
    ]);
    expect(s.firstDivergence).toBeNull();
    expect(s.matched).toBe(2);
  });

  it("takes the smallest mismatched index regardless of input order", () => {
    // Deriving from a set (not folding in order) must still pin firstDivergence
    // to the lowest mismatched index even if results arrive out of order.
    const s = computeDivergence([
      { index: 5, result: miss },
      { index: 3, result: miss },
      { index: 4, result: match },
    ]);
    expect(s.firstDivergence).toBe(3);
  });

  it("does not double-count a re-placed (deduped) piece", () => {
    // The session stores results in a Map keyed by index; a retried piece
    // overwrites its entry, so computeDivergence only ever sees one result per
    // index. A corrected retry therefore yields 1/1, not 1/2.
    const results = new Map<number, any>();
    results.set(0, miss); // first (wrong) attempt
    results.set(0, match); // retry, corrected — overwrites
    const s = computeDivergence(
      [...results].map(([index, result]) => ({ index, result })),
    );
    expect(s.compared).toBe(1);
    expect(s.matched).toBe(1);
    expect(s.firstDivergence).toBeNull(); // no longer diverged
  });

  it("summarizes with holes/bumpiness deltas vs the pro", () => {
    const s = computeDivergence([
      { index: 0, result: match },
      { index: 1, result: miss },
    ]);
    // learner has a hole and more bumpiness than the pro's flat board.
    const learner = grid(["#", ".", "#"]); // 1 hole, heights [3]
    const pro = grid(["#", "#", "#"]); // 0 holes
    const sum = summarize(s, learner, pro);
    expect(sum.piecesMatched).toBe(1);
    expect(sum.piecesCompared).toBe(2);
    expect(sum.firstDivergence).toBe(1);
    expect(sum.holesDelta).toBe(1); // learner 1 - pro 0
  });
});
