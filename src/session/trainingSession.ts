// Training session: a side-by-side comparison of the pro's reconstructed run
// (left) and a live learner (right) over a chosen window of the replay.
//
// Starting a session seeds the learner engine from the pro's exact board state
// at the window's start (`fromSnapshot(track[start].snapshot)`), so the learner
// begins where the pro was and plays the *same* upcoming pieces forward (the
// engine's queue is part of the snapshot). The pro board is shown from the
// placement track, advancing in lockstep with how many pieces the learner has
// placed — a true race over the same window.

import type { Engine, EngineSnapshot } from "../engine/adapter";
import type { GarbageEvent, Placement } from "../replay/reconstruct";
import {
  comparePlacement,
  computeDivergence,
  summarize,
  toOccupancy,
  type DivergenceState,
  type IndexedMatch,
  type MatchResult,
  type PlacementRecord,
  type WindowSummary,
} from "./compare";
import type { TargetGhost } from "../render/render";

export interface WindowSelection {
  /** Inclusive start placement index (0-based). */
  start: number;
  /** Inclusive end placement index (0-based). */
  end: number;
}

export interface BoardStatus {
  /** Piece index within the window (0-based), and the window length. */
  pieceInWindow: number;
  windowLength: number;
  /** Absolute placement index in the full replay. */
  absoluteIndex: number;
  /**
   * Elapsed seconds. The pro board reports the *absolute* replay time (a
   * window starting at piece 60 starts at that piece's replay timestamp);
   * the learner reports live time since the window start.
   */
  elapsedSec: number;
  /** Whether this board has finished the window. */
  done: boolean;
}

export class TrainingSession {
  readonly track: Placement[];
  readonly window: WindowSelection;

  /** Learner frame at which the session started (for elapsed time). */
  private learnerStartFrame: number;
  /**
   * Pieces the learner has placed since the session started. The session owns
   * this counter (incremented by the learner's lock event, adjusted by
   * {@link undo}/{@link redo}) because no engine counter survives both
   * undo/redo and long windows: `stats.pieces` comes back off-by-one from
   * restored snapshots, and the undo stack — the previous source — is capped
   * at 100 entries, which froze the count (and the target ghost) at piece 100.
   */
  private placed = 0;
  /** Garbage the pro's board gained, filtered to this window (tank boundaries). */
  private garbageSchedule: GarbageEvent[];
  /** Index into `garbageSchedule` of the next un-inserted garbage event. */
  private nextGarbage = 0;
  /** The last comparison result (for the retry prompt), or null. */
  private lastMatch: MatchResult | null = null;
  /**
   * Every placement's comparison result, keyed by its absolute pro index. Undo
   * pops the last placement off the board without re-running any comparison, and
   * redo restores it the same way — neither fires the lock hooks. So we remember
   * each result here and re-select the one for whichever piece is on top of the
   * stack after an undo/redo (see `matchResultAt`).
   */
  private readonly matchHistory = new Map<number, MatchResult>();
  /**
   * The pristine (empty-board) snapshot from the freshly-built learner engine,
   * used as "the board before piece 0" when the window starts at piece 0. The
   * placement track only stores post-lock snapshots, so there is no track entry
   * for the empty board before the very first piece.
   */
  private readonly emptySnapshot: EngineSnapshot;

  private constructor(
    track: Placement[],
    window: WindowSelection,
    learner: Engine,
    garbage: GarbageEvent[],
  ) {
    this.track = track;
    this.window = window;
    // Only garbage that enters the board within this window matters; rows with
    // beforePiece <= start are already part of the seed snapshot. Keep ordered.
    this.garbageSchedule = garbage
      .filter((g) => g.beforePiece > window.start && g.beforePiece <= window.end)
      .sort((a, b) => a.beforePiece - b.beforePiece);
    // Capture the pristine empty board before seeding (used as "before piece 0").
    this.emptySnapshot = learner.snapshot() as EngineSnapshot;
    // Seed the learner from the board state *before* the window's first piece was
    // placed, so the window starts with an empty stack and the learner places the
    // start piece themselves (rather than starting with it already on the board).
    const startSnap = this.snapshotBefore(window.start);
    learner.fromSnapshot(startSnap);
    learner.tick([]); // spawn/settle after loading
    // The pro snapshot carries a null undo baseline (the pro never used undo),
    // so establish the seeded state as the undo floor. Without this, undoing the
    // first placed piece restores `null` and crashes. Guard for engines built
    // without undo enabled (no `practice`/`snapshot` overload assumptions).
    if (learner.practice) {
      learner.practice.lastPiece = learner.snapshot({ isUndoRedo: true });
      learner.practice.undo = [];
      learner.practice.redo = [];
    }
    this.learnerStartFrame = learner.frame;
    // Count placements from the engine's lock event (registered after the
    // seeding tick so nothing spurious is counted).
    learner.events.on("falling.lock", () => {
      this.placed++;
    });
  }

  /**
   * Begin a session: seed `learner` from `track[start]` and return the session.
   * `start`/`end` are clamped to the track bounds; `end` must be >= `start`.
   * `garbage` is the pro's received-garbage schedule (optional; empty by default).
   */
  static start(
    track: Placement[],
    window: WindowSelection,
    learner: Engine,
    garbage: GarbageEvent[] = [],
  ): TrainingSession {
    const start = clamp(window.start, 0, track.length - 1);
    const end = clamp(window.end, start, track.length - 1);
    return new TrainingSession(track, { start, end }, learner, garbage);
  }

  /**
   * Insert any garbage rows the learner's board is now due for, exactly as
   * they entered the pro's board: same piece boundary, same hole columns. The
   * rows go straight into the board (bypassing the learner's garbage queue)
   * because the queue tanks on a *frame* clock — a learner playing at a
   * different speed would tank at a different piece, vertically offsetting
   * every subsequent placement (and the target ghost) from the pro's.
   * Call once per frame.
   */
  mirrorGarbage(learner: Engine): void {
    const absoluteIndex = this.window.start + this.placed;
    while (
      this.nextGarbage < this.garbageSchedule.length &&
      this.garbageSchedule[this.nextGarbage].beforePiece <= absoluteIndex
    ) {
      insertGarbageRows(learner, this.garbageSchedule[this.nextGarbage++]);
    }
  }

  /**
   * Re-align the garbage pointer after an undo/redo. The engine restores a
   * board snapshot taken at the current piece's *spawn* — which contains all
   * garbage inserted strictly before that piece (boundary < its index) and
   * none inserted while it was falling. Rewinding the pointer accordingly
   * lets `mirrorGarbage` re-insert what the restored snapshot lacks.
   */
  resyncGarbage(): void {
    const absoluteIndex = this.window.start + this.placed;
    let n = 0;
    while (
      n < this.garbageSchedule.length &&
      this.garbageSchedule[n].beforePiece < absoluteIndex
    ) {
      n++;
    }
    this.nextGarbage = n;
  }

  get windowLength(): number {
    return this.window.end - this.window.start + 1;
  }

  /**
   * The board state *before* piece `index` was placed. The track stores only
   * post-lock snapshots, so the board before piece `index` is the snapshot after
   * piece `index - 1` (`track[index - 1]`), or the pristine empty board when
   * `index` is 0 (there is no piece before the first). `index` is clamped so that
   * asking for a piece past the window end returns the final board.
   */
  private snapshotBefore(index: number): EngineSnapshot {
    const i = clamp(index, 0, this.track.length);
    if (i <= 0) return this.emptySnapshot;
    return this.track[i - 1].snapshot as EngineSnapshot;
  }

  /** Pieces the learner has placed since the session started (see `placed`). */
  learnerPiecesPlaced(): number {
    return this.placed;
  }

  /**
   * Undo the learner's last placement, keeping the session's piece counter in
   * sync. Returns false when nothing was undone (empty stack or undo
   * disabled) — detected via the undo-stack depth, since `Engine.undo()`
   * returns no success signal.
   */
  undo(learner: Engine): boolean {
    const before = learner.practice?.undo?.length ?? 0;
    learner.undo();
    const ok = (learner.practice?.undo?.length ?? 0) < before;
    if (ok) this.placed = Math.max(0, this.placed - 1);
    return ok;
  }

  /** Redo a previously undone placement; counterpart of {@link undo}. */
  redo(learner: Engine): boolean {
    const before = learner.practice?.redo?.length ?? 0;
    learner.redo();
    const ok = (learner.practice?.redo?.length ?? 0) < before;
    if (ok) this.placed++;
    return ok;
  }

  /**
   * The pro snapshot to render: the pro board shown in lockstep with the learner.
   * Both boards begin empty (before the window's first piece); after the learner
   * has placed `n` pieces the pro board shows the board with the pro's pieces
   * `start … start+n-1` placed — i.e. the board *before* piece `start+n`. At the
   * window end it settles on the final board (after piece `end`).
   */
  proSnapshotFor(): EngineSnapshot {
    return this.snapshotBefore(this.proNextIndex());
  }

  /**
   * The absolute index of the pro piece the learner is currently working toward
   * (the next piece to place). Ranges over `start … end+1`; at `end+1` the window
   * is complete and both boards show the final state.
   */
  private proNextIndex(): number {
    return clamp(
      this.window.start + this.placed,
      this.window.start,
      this.window.end + 1,
    );
  }

  /**
   * The pro board's last-placed absolute index (mirrors the learner). This is the
   * index of the most recent piece shown on the pro board, i.e. one behind the
   * piece being worked toward; equals `window.start` before any piece is placed.
   */
  proIndexFor(): number {
    return clamp(
      this.proNextIndex() - 1,
      this.window.start,
      this.window.end,
    );
  }

  proStatus(): BoardStatus {
    // Pieces the pro board has completed within the window (matches the learner's
    // placed count, clamped to the window length).
    const placed = Math.min(this.placed, this.windowLength);
    const idx = clamp(this.window.start + placed, this.window.start, this.window.end);
    return {
      pieceInWindow: placed,
      windowLength: this.windowLength,
      absoluteIndex: idx,
      // Absolute replay time of the piece the pro board currently shows.
      elapsedSec: this.track[idx].frame / 60,
      done: placed >= this.windowLength,
    };
  }

  learnerStatus(learner: Engine): BoardStatus {
    const placed = this.placed;
    const pieceInWindow = Math.min(placed, this.windowLength);
    return {
      pieceInWindow,
      windowLength: this.windowLength,
      absoluteIndex: this.window.start + pieceInWindow,
      elapsedSec: (learner.frame - this.learnerStartFrame) / 60,
      done: placed >= this.windowLength,
    };
  }

  // ---- "stack exactly like the pro" comparison ----

  /**
   * The pro's placement as a target ghost for the learner board, `ahead` pieces
   * past the one the learner is about to place (0 = the current target, 1 = the
   * next piece). Returns null when that placement is beyond the window.
   */
  targetGhost(ahead = 0): TargetGhost | null {
    const placed = this.placed + ahead;
    if (placed >= this.windowLength) return null;
    const p = this.track[this.window.start + placed];
    return { piece: p.piece, x: p.x, y: p.y, rotation: p.rot };
  }

  /**
   * Compare a just-placed learner piece against the pro's placement at the same
   * index and store the result, keyed by the absolute pro index. `atIndex` is
   * that index (captured at `falling.lock.pre`, before the count advanced).
   *
   * Storing into `matchHistory` — rather than folding into a running counter —
   * is what makes retry correct: re-placing a piece overwrites its entry, and
   * `divergenceState()` derives the stats fresh from the on-board placements, so
   * a corrected retry no longer double-counts or leaves a stale first-divergence.
   *
   * Placements past the window end are ignored: the learner may keep stacking
   * after the window is complete, but those pieces have no pro counterpart to
   * compare against and must not corrupt the finished window's stats. Returns
   * null in that case.
   */
  recordLearnerPlacement(
    learnerPlacement: PlacementRecord,
    atIndex: number,
  ): MatchResult | null {
    if (atIndex < this.window.start || atIndex > this.window.end) return null;
    const pro = this.track[atIndex];
    const proRecord: PlacementRecord = {
      piece: pro.piece,
      x: pro.x,
      y: pro.y,
      rot: pro.rot,
      spin: pro.spin,
      clears: pro.clears,
      board: toOccupancy(pro.snapshot.board),
    };
    const result = comparePlacement(learnerPlacement, proRecord);
    this.lastMatch = result;
    this.matchHistory.set(atIndex, result);
    return result;
  }

  /**
   * The stored comparison result for the pro piece at absolute `index`, or null
   * if that piece hasn't been placed (compared) yet. Used by redo to re-surface
   * the message for the piece it just restored to the top of the stack.
   */
  matchResultAt(index: number): MatchResult | null {
    return this.matchHistory.get(index) ?? null;
  }

  /**
   * The absolute pro index of the piece currently on top of the learner's stack
   * (the last placed one). Returns null when the stack is empty (no pieces
   * placed in the window yet): `placed` pieces means the top piece is
   * `start + placed - 1`.
   */
  topPieceIndex(): number | null {
    if (this.placed <= 0) return null;
    return clamp(
      this.window.start + this.placed - 1,
      this.window.start,
      this.window.end,
    );
  }

  /**
   * The absolute pro index the piece that is *currently locking* corresponds to.
   * Call this from the `falling.lock.pre` handler: the session's own counter
   * increments on `falling.lock` (which fires after `.pre`), so at `.pre` time
   * `placed` still excludes the locking piece — making it the piece at
   * `start + placed`.
   *
   * NOT clamped to the window: when the learner keeps stacking past the window
   * end this returns an index > `window.end`, so `recordLearnerPlacement` can
   * recognise the placement as out-of-window and skip it rather than mis-attribute
   * it to the final pro piece.
   */
  currentTargetIndex(): number {
    return this.window.start + this.placed;
  }

  /**
   * The running "stack like the pro" divergence, derived fresh from the results
   * of the pieces currently on the learner's board (indices `start … start +
   * placed - 1`). Deriving — rather than accumulating — means undo, redo, and
   * retry are all reflected automatically: a re-placed piece overwrote its entry
   * in `matchHistory`, and undone pieces fall outside the on-board range.
   */
  divergenceState(): DivergenceState {
    const onBoard: IndexedMatch[] = [];
    for (let i = 0; i < this.placed; i++) {
      const index = this.window.start + i;
      if (index > this.window.end) break;
      const result = this.matchHistory.get(index);
      if (result) onBoard.push({ index, result });
    }
    return computeDivergence(onBoard);
  }

  lastMatchResult(): MatchResult | null {
    return this.lastMatch;
  }

  /**
   * Re-select the displayed match result to reflect the piece now on top of the
   * learner's stack, after an undo or redo. Undoing to an empty stack (or below a
   * compared piece) clears the message; redoing a piece back onto the stack
   * re-surfaces its stored result — so a redone piece that was in the wrong spot
   * shows its mismatch again. Returns the newly-selected result (or null).
   */
  syncLastMatch(): MatchResult | null {
    const top = this.topPieceIndex();
    this.lastMatch = top === null ? null : this.matchResultAt(top);
    return this.lastMatch;
  }

  /** End-of-window summary: match stats + holes/bumpiness delta vs. the pro. */
  summary(learner: Engine): WindowSummary {
    const learnerBoard = toOccupancy(learner.snapshot().board);
    const proBoard = toOccupancy(this.track[this.window.end].snapshot.board);
    return summarize(this.divergenceState(), learnerBoard, proBoard);
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/**
 * Insert a recorded garbage event's rows into the learner's board, mirroring
 * the engine's own tank loop (same chunk grouping via isBeginning/isEnd).
 */
function insertGarbageRows(learner: Engine, event: GarbageEvent): void {
  const rows = event.rows;
  for (let i = 0; i < rows.length; i++) {
    const g = rows[i];
    learner.board.insertGarbage({
      amount: g.amount,
      size: g.size,
      column: g.column,
      bombs: learner.garbageQueue.options.bombs,
      isBeginning: i === 0 || rows[i - 1].id !== g.id,
      isEnd: i === rows.length - 1 || rows[i + 1].id !== g.id,
    });
  }
}
