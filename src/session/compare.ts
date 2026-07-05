// Pure "stack exactly like the pro" comparison logic.
//
// Everything here is a pure function of plain data (placements + board grids) so
// it is trivially unit-testable and independent of the engine/DOM. The session
// feeds it the pro's placement (from the reconstruction track) and the learner's
// placement (captured at lock time) and gets back a match verdict; at window end
// it computes holes/bumpiness deltas vs. the pro.

/** A single placement to compare (learner or pro). */
export interface PlacementRecord {
  /** Lowercase mino symbol, e.g. "t". */
  piece: string;
  /** Column of the piece's anchor (board x). */
  x: number;
  /** Row of the piece's anchor (board y, bottom-up). */
  y: number;
  /** Rotation state 0..3. */
  rot: number;
  /** Spin type: "none" | "mini" | "normal". */
  spin: string;
  /** Lines cleared by this placement. */
  clears: number;
  /**
   * The post-lock board as a boolean occupancy grid, `board[y][x]` bottom-up.
   * Only occupancy matters for the exact-match; colors are ignored.
   */
  board: boolean[][];
}

/** Which aspects of a placement diverged from the pro. */
export interface MatchResult {
  /** True when column, rotation, and resulting cells all match. */
  match: boolean;
  /** The placed piece type differs (e.g. a different hold decision). */
  pieceMismatch: boolean;
  /** Anchor column differs. */
  columnMismatch: boolean;
  /** Rotation differs. */
  rotationMismatch: boolean;
  /** Resulting board cells differ (the strongest signal). */
  cellsMismatch: boolean;
  /** Spin type differs (flagged, does not by itself fail the match). */
  spinMismatch: boolean;
  /** Lines cleared differ (flagged). */
  clearMismatch: boolean;
}

/** Convert an engine snapshot board (`{mino}|null`) to a boolean grid. */
export function toOccupancy(
  board: ReadonlyArray<ReadonlyArray<unknown | null>>,
): boolean[][] {
  return board.map((row) => row.map((cell) => cell != null));
}

/** Do two boolean boards have identical occupancy? */
export function boardsEqual(a: boolean[][], b: boolean[][]): boolean {
  if (a.length !== b.length) return false;
  for (let y = 0; y < a.length; y++) {
    const ra = a[y];
    const rb = b[y];
    if (ra.length !== rb.length) return false;
    for (let x = 0; x < ra.length; x++) {
      if (ra[x] !== rb[x]) return false;
    }
  }
  return true;
}

/**
 * Compare a learner placement to the pro's placement at the same piece index.
 *
 * The resulting board cells are the ground truth for a match: if the learner's
 * post-lock occupancy is identical to the pro's, they stacked the same way and
 * it counts as a match — full stop. Anchor column and rotation *state* are NOT
 * reliable on their own, because the same physical placement can be reached via
 * different engine coordinates: an I piece laid flat occupies the same 4 cells
 * whether the engine reports rotation 0 or 2 (with the anchor x offset by one),
 * and S/Z pieces have the same redundancy. Flagging those as "wrong column /
 * wrong rotation" when the cells are identical is a false negative (the bug that
 * showed an I piece as mismatched even though it was placed exactly like the
 * pro). So column/rotation are only *reported* when the cells actually differ,
 * to help explain a genuine mismatch — they never fail a cell-identical stack.
 */
export function comparePlacement(
  learner: PlacementRecord,
  pro: PlacementRecord,
): MatchResult {
  const pieceMismatch = learner.piece !== pro.piece;
  const cellsMismatch = !boardsEqual(learner.board, pro.board);
  const spinMismatch = learner.spin !== pro.spin;
  const clearMismatch = learner.clears !== pro.clears;

  // The resulting cells decide the match. Column/rotation are reported only to
  // explain a real mismatch, and are meaningless (redundant coordinates) when
  // the cells already agree, so we suppress them in that case.
  const columnMismatch = cellsMismatch && learner.x !== pro.x;
  const rotationMismatch = cellsMismatch && learner.rot !== pro.rot;

  const match = !cellsMismatch;
  return {
    match,
    pieceMismatch,
    columnMismatch,
    rotationMismatch,
    cellsMismatch,
    spinMismatch,
    clearMismatch,
  };
}

// ---- board metrics (for the end-of-window summary) ----

/** Per-column surface height (index 0 = leftmost). Bottom-up board. */
export function columnHeights(board: boolean[][]): number[] {
  const rows = board.length;
  const cols = board[0]?.length ?? 0;
  const heights = new Array<number>(cols).fill(0);
  for (let x = 0; x < cols; x++) {
    for (let y = rows - 1; y >= 0; y--) {
      if (board[y][x]) {
        heights[x] = y + 1;
        break;
      }
    }
  }
  return heights;
}

/** Covered empty cells (a hole is an empty cell with a filled cell above it). */
export function countHoles(board: boolean[][]): number {
  const rows = board.length;
  const cols = board[0]?.length ?? 0;
  let holes = 0;
  for (let x = 0; x < cols; x++) {
    let seenBlock = false;
    for (let y = rows - 1; y >= 0; y--) {
      if (board[y][x]) seenBlock = true;
      else if (seenBlock) holes++;
    }
  }
  return holes;
}

/** Sum of absolute height differences between adjacent columns. */
export function bumpiness(board: boolean[][]): number {
  const h = columnHeights(board);
  let sum = 0;
  for (let i = 1; i < h.length; i++) sum += Math.abs(h[i] - h[i - 1]);
  return sum;
}

export interface BoardMetrics {
  holes: number;
  bumpiness: number;
  aggregateHeight: number;
}

export function boardMetrics(board: boolean[][]): BoardMetrics {
  const heights = columnHeights(board);
  return {
    holes: countHoles(board),
    bumpiness: bumpiness(board),
    aggregateHeight: heights.reduce((a, b) => a + b, 0),
  };
}

// ---- running divergence + summary ----

export interface DivergenceState {
  /** Pieces compared so far in the window. */
  compared: number;
  /** Pieces that matched exactly. */
  matched: number;
  /** Absolute piece index of the first divergence, or null if none yet. */
  firstDivergence: number | null;
}

export const initialDivergence = (): DivergenceState => ({
  compared: 0,
  matched: 0,
  firstDivergence: null,
});

/** A single placement's comparison result tagged with its absolute pro index. */
export interface IndexedMatch {
  index: number;
  result: MatchResult;
}

/**
 * Compute the divergence state from the placements currently on the board (pure).
 *
 * This is a *derivation*, not an accumulator: it is recomputed from the current
 * set of results every time, so undo, redo, and retry (which overwrite or drop a
 * placement's result) are reflected correctly. A stateful fold that only ever
 * added would double-count a retried piece and latch `firstDivergence` on a
 * mismatch even after the piece was corrected.
 *
 * `matches` need not be sorted; `firstDivergence` is the smallest index whose
 * result did not match.
 */
export function computeDivergence(
  matches: readonly IndexedMatch[],
): DivergenceState {
  let matched = 0;
  let firstDivergence: number | null = null;
  for (const { index, result } of matches) {
    if (result.match) {
      matched++;
    } else if (firstDivergence === null || index < firstDivergence) {
      firstDivergence = index;
    }
  }
  return { compared: matches.length, matched, firstDivergence };
}

export interface WindowSummary {
  piecesMatched: number;
  piecesCompared: number;
  firstDivergence: number | null;
  /** Learner metrics minus pro metrics (0 = identical stacks). */
  holesDelta: number;
  bumpinessDelta: number;
}

/** Summarize a finished window (pure): match stats + holes/bumpiness delta. */
export function summarize(
  state: DivergenceState,
  learnerBoard: boolean[][],
  proBoard: boolean[][],
): WindowSummary {
  const learner = boardMetrics(learnerBoard);
  const pro = boardMetrics(proBoard);
  return {
    piecesMatched: state.matched,
    piecesCompared: state.compared,
    firstDivergence: state.firstDivergence,
    holesDelta: learner.holes - pro.holes,
    bumpinessDelta: learner.bumpiness - pro.bumpiness,
  };
}
