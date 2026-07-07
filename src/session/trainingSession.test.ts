import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseReplay } from "../replay/parse";
import { parseMatch, buildGameReplay } from "../replay/ttrm";
import { reconstructReplay } from "../replay/reconstruct";
import { buildProEngine } from "../replay/proEngine";
import { TrainingSession } from "./trainingSession";

const dataPath = (name: string) =>
  fileURLToPath(new URL(`../../test_data/${name}`, import.meta.url));

function loadTrack() {
  const parsed = parseReplay(readFileSync(dataPath("promooooooo_40l.ttr"), "utf8"));
  if (!parsed.ok) throw new Error("parse failed");
  const replay = parsed.replay;
  const result = reconstructReplay(replay);
  return { replay, result };
}

/** Load round 1, player 0 of the bundled Tetra League match (has garbage). */
function loadMatchTrack() {
  const res = parseMatch(readFileSync(dataPath("promooooooo_tr.ttrm"), "utf8"));
  if (!res.ok) throw new Error("match parse failed");
  const built = buildGameReplay(res.match, 0, 0);
  if (!built.ok) throw new Error("game build failed");
  const result = reconstructReplay(built.replay);
  return { replay: built.replay, result };
}

const countGarbageRows = (board: readonly unknown[][]): number =>
  board.filter((row) =>
    row.some((c) => !!c && ((c as { mino?: string }).mino ?? c) === "gb"),
  ).length;

/**
 * Place a piece the way the live trainer does: hard-drop, settle, then deliver
 * the next piece's incoming garbage — the same compare-then-deliver order the
 * bootstrap lock handler uses (garbage for piece i+1 lands only after piece i is
 * placed, so piece i's board stays garbage-consistent with the pro at compare).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function placeAndDeliver(learner: any, session: TrainingSession): void {
  learner.press("hardDrop");
  learner.tick([]);
  session.deliverIncomingGarbage(learner);
}

describe("TrainingSession", () => {
  it("seeds the learner from the board *before* the window's first piece", () => {
    const { replay, result } = loadTrack();
    const learner = buildProEngine(replay);
    const start = 20;
    const session = TrainingSession.start(result.track, { start, end: 40 }, learner);

    // The window must start with an empty stack: the learner begins from the
    // board *before* piece `start` (i.e. the post-lock snapshot of `start - 1`),
    // then places piece `start` themselves — not with piece `start` already down.
    const beforeStart = result.track[start - 1].snapshot;
    const learnerSnap = learner.snapshot();
    expect(learnerSnap.board.flat().filter(Boolean).length).toBe(
      beforeStart.board.flat().filter(Boolean).length,
    );
    // The pro's upcoming piece (its NEXT queue head at `start - 1`) is the one the
    // learner is about to place, so the queues line up.
    expect(learner.queue.slice(0, 5)).toEqual(
      (beforeStart.queue.value ?? []).slice(0, 5),
    );
    void session;
  });

  it("starts the board empty when the window starts at piece 0", () => {
    const { replay, result } = loadTrack();
    const learner = buildProEngine(replay);
    const session = TrainingSession.start(result.track, { start: 0, end: 10 }, learner);
    // No pieces placed yet -> the learner board is empty.
    expect(learner.snapshot().board.flat().filter(Boolean).length).toBe(0);
    void session;
  });

  it("reports piece index and elapsed time for the learner", () => {
    const { replay, result } = loadTrack();
    const learner = buildProEngine(replay);
    const session = TrainingSession.start(result.track, { start: 5, end: 15 }, learner);

    const ls0 = session.learnerStatus(learner);
    expect(ls0.pieceInWindow).toBe(0);
    expect(ls0.windowLength).toBe(11);
    expect(ls0.elapsedSec).toBe(0);
    expect(ls0.absoluteIndex).toBe(5);

    // Advance a few learner frames + a placement.
    for (let i = 0; i < 30; i++) learner.tick([]);
    learner.press("hardDrop");
    learner.tick([]);
    const ls1 = session.learnerStatus(learner);
    expect(ls1.pieceInWindow).toBe(1);
    expect(ls1.absoluteIndex).toBe(6);
    expect(ls1.elapsedSec).toBeGreaterThan(0);
  });

  it("clamps the learner status to the window end and marks done", () => {
    const { replay, result } = loadTrack();
    const learner = buildProEngine(replay);
    const session = TrainingSession.start(result.track, { start: 0, end: 3 }, learner);

    // Place more pieces than the 4-piece window.
    for (let i = 0; i < 10; i++) {
      learner.press("hardDrop");
      learner.tick([]);
    }
    const ls = session.learnerStatus(learner);
    expect(ls.pieceInWindow).toBe(4); // clamped to window length
    expect(ls.done).toBe(true);
  });

  it("preserves a learner handling override across seeding", () => {
    const { replay, result } = loadTrack();
    const learner = buildProEngine(replay);
    learner.handling.das = 2;
    learner.handling.arr = 0;
    TrainingSession.start(result.track, { start: 8, end: 20 }, learner);
    expect(learner.handling.das).toBe(2);
    expect(learner.handling.arr).toBe(0);
  });

  it("clamps an out-of-range window", () => {
    const { replay, result } = loadTrack();
    const learner = buildProEngine(replay);
    const last = result.track.length - 1;
    const session = TrainingSession.start(
      result.track,
      { start: -5, end: last + 100 },
      learner,
    );
    expect(session.window.start).toBe(0);
    expect(session.window.end).toBe(last);
  });
});

describe("TrainingSession undo/redo", () => {
  const filled = (learner: ReturnType<typeof buildProEngine>) =>
    learner.snapshot().board.flat().filter(Boolean).length;

  function sessionWithUndo() {
    const { replay, result } = loadTrack();
    // The learner must be built with undo enabled (hooks wire at construction).
    const learner = buildProEngine(replay, { can_undo: true, can_retry: true });
    const session = TrainingSession.start(
      result.track,
      { start: 10, end: 30 },
      learner,
    );
    return { learner, session };
  }

  it("undoes and redoes placed pieces during a session", () => {
    const { learner, session } = sessionWithUndo();
    const seed = filled(learner);
    learner.press("hardDrop");
    learner.tick([]);
    learner.press("hardDrop");
    learner.tick([]);
    const twoDrops = filled(learner);
    expect(twoDrops).toBeGreaterThan(seed);

    session.undo(learner);
    expect(filled(learner)).toBeLessThan(twoDrops);
    session.undo(learner);
    expect(filled(learner)).toBe(seed); // back to the window-start state

    session.redo(learner);
    session.redo(learner);
    expect(filled(learner)).toBe(twoDrops);
  });

  it("keeps the piece count in sync through undo/redo", () => {
    const { learner, session } = sessionWithUndo();

    // Each drop advances the placed count by exactly one.
    learner.press("hardDrop");
    learner.tick([]);
    learner.press("hardDrop");
    learner.tick([]);
    learner.press("hardDrop");
    learner.tick([]);
    expect(session.learnerPiecesPlaced()).toBe(3);

    // Undo removes exactly one piece from the count each time.
    session.undo(learner);
    expect(session.learnerPiecesPlaced()).toBe(2);

    session.undo(learner);
    expect(session.learnerPiecesPlaced()).toBe(1);

    // Redo restores exactly one.
    session.redo(learner);
    expect(session.learnerPiecesPlaced()).toBe(2);

    // A fresh drop after redo continues cleanly.
    learner.press("hardDrop");
    learner.tick([]);
    expect(session.learnerPiecesPlaced()).toBe(3);
  });

  it("keeps counting past the engine's undo-stack cap", () => {
    const { learner, session } = sessionWithUndo();
    learner.press("hardDrop");
    learner.tick([]);
    learner.press("hardDrop");
    learner.tick([]);
    learner.press("hardDrop");
    learner.tick([]);
    // The engine caps practice.undo at 100 entries, silently evicting the
    // oldest. Deriving the placed count from the stack depth froze it at 100
    // and desynced the target ghost; the session's own counter must not care.
    learner.practice?.undo.shift();
    learner.practice?.undo.shift();
    expect(session.learnerPiecesPlaced()).toBe(3);
  });

  it("does not crash when undoing past the seeded window start", () => {
    const { learner, session } = sessionWithUndo();
    const seed = filled(learner);
    learner.press("hardDrop");
    learner.tick([]);
    // Undo more times than pieces placed — must be a safe no-op at the floor.
    expect(() => {
      session.undo(learner);
      session.undo(learner);
      session.undo(learner);
    }).not.toThrow();
    expect(filled(learner)).toBe(seed);
  });
});

describe("TrainingSession stack-like-the-pro comparison", () => {
  it("exposes the pro's upcoming placement as a target ghost", () => {
    const { replay, result } = loadTrack();
    const learner = buildProEngine(replay, { can_undo: true });
    const session = TrainingSession.start(result.track, { start: 5, end: 12 }, learner);

    const g = session.targetGhost();
    const pro = result.track[5];
    expect(g).toEqual({ piece: pro.piece, x: pro.x, y: pro.y, rotation: pro.rot });
  });

  it("exposes the piece one ahead as a look-ahead target ghost", () => {
    const { replay, result } = loadTrack();
    const learner = buildProEngine(replay, { can_undo: true });
    const session = TrainingSession.start(result.track, { start: 5, end: 12 }, learner);

    const next = session.targetGhost(1);
    const proNext = result.track[6];
    expect(next).toEqual({
      piece: proNext.piece,
      x: proNext.x,
      y: proNext.y,
      rotation: proNext.rot,
    });
  });

  it("returns null for look-ahead beyond the window end", () => {
    const { replay, result } = loadTrack();
    const learner = buildProEngine(replay, { can_undo: true });
    // 2-piece window; after placing one, the current is the last piece and the
    // look-ahead is beyond the window.
    const session = TrainingSession.start(result.track, { start: 5, end: 6 }, learner);
    learner.press("hardDrop");
    learner.tick([]);
    expect(session.targetGhost(0)).not.toBeNull();
    expect(session.targetGhost(1)).toBeNull();
  });

  it("targets pro index start (not start+1) for the first locking piece", () => {
    // Regression: at `falling.lock.pre` the engine has already counted the
    // locking piece (undo entry pushed / stats.pieces incremented before the
    // lock hook), so the raw placed-count is one too high. currentTargetIndex
    // must still map the *first* locking piece to the window's first pro index —
    // otherwise it compares piece 0 against the pro's piece 1 and reports a
    // bogus "different piece" mismatch.
    const { replay, result } = loadTrack();
    const learner = buildProEngine(replay, { can_undo: true, can_retry: true });
    const session = TrainingSession.start(result.track, { start: 0, end: 5 }, learner);

    let target = -1;
    learner.events.on("falling.lock.pre", () => {
      target = session.currentTargetIndex();
    });
    learner.press("hardDrop");
    learner.tick([]);
    expect(target).toBe(0);

    // The second locking piece targets index 1, and so on.
    learner.press("hardDrop");
    learner.tick([]);
    expect(target).toBe(1);
  });

  it("reports a full match when the learner replays the pro's placement", () => {
    const { replay, result } = loadTrack();
    const learner = buildProEngine(replay, { can_undo: true });
    const session = TrainingSession.start(result.track, { start: 5, end: 12 }, learner);

    // Feed the pro's own placement back as the learner's.
    const idx = session.currentTargetIndex();
    const pro = result.track[idx];
    const learnerPlacement = {
      piece: pro.piece,
      x: pro.x,
      y: pro.y,
      rot: pro.rot,
      spin: pro.spin,
      clears: pro.clears,
      board: pro.snapshot.board.map((row) => row.map((c) => c != null)),
    };
    const match = session.recordLearnerPlacement(learnerPlacement, idx);
    expect(match?.match).toBe(true);
    // The result is stored under its pro index for later derivation/redo.
    expect(session.matchResultAt(idx)?.match).toBe(true);
  });

  it("flags a divergence and records the first divergence index", () => {
    const { replay, result } = loadTrack();
    const learner = buildProEngine(replay, { can_undo: true });
    const session = TrainingSession.start(result.track, { start: 5, end: 12 }, learner);

    const idx = session.currentTargetIndex();
    const pro = result.track[idx];
    // Same piece, wrong column + different cells.
    const wrong = {
      piece: pro.piece,
      x: pro.x + 2,
      y: pro.y,
      rot: pro.rot,
      spin: pro.spin,
      clears: pro.clears,
      board: pro.snapshot.board.map((row, y) =>
        row.map((c, x) => (y === 0 && x === 0 ? !c : c != null)),
      ),
    };
    const match = session.recordLearnerPlacement(wrong, idx);
    expect(match?.match).toBe(false);
    expect(session.matchResultAt(idx)?.match).toBe(false);
    expect(session.lastMatchResult()?.match).toBe(false);
  });

  it("clears the message on undo and re-surfaces it on redo", () => {
    const { replay, result } = loadTrack();
    const learner = buildProEngine(replay, { can_undo: true, can_retry: true });
    const session = TrainingSession.start(result.track, { start: 0, end: 10 }, learner);

    // Wire the same capture-at-lock flow main.tsx uses, so each real placement is
    // compared and its result stored in the session's match history.
    let pending: { piece: string; x: number; y: number; rot: number } | null = null;
    let pendingIdx = 0;
    learner.events.on("falling.lock.pre", () => {
      const f = learner.falling;
      pending = {
        piece: String(f.symbol),
        x: Math.floor(f.location[0]),
        y: Math.floor(f.location[1]),
        rot: f.rotation,
      };
      pendingIdx = session.currentTargetIndex();
    });
    learner.events.on("falling.lock", (res: { spin: string; lines: number }) => {
      if (!pending) return;
      session.recordLearnerPlacement(
        {
          ...pending,
          spin: res.spin,
          clears: res.lines,
          board: learner.snapshot().board.map((row) => row.map((c) => c != null)),
        },
        pendingIdx,
      );
      pending = null;
    });

    // Place the first piece somewhere the pro did NOT (shove it left), forcing a
    // mismatch, then place a second piece.
    learner.press("moveLeft");
    for (let i = 0; i < 5; i++) learner.tick([]);
    learner.press("hardDrop");
    learner.tick([]);
    const firstResult = session.matchResultAt(0);
    expect(firstResult).not.toBeNull();

    learner.press("hardDrop");
    learner.tick([]);
    expect(session.learnerPiecesPlaced()).toBe(2);

    // Undo the second piece: the message reflects the piece now on top (piece 0).
    session.undo(learner);
    expect(session.topPieceIndex()).toBe(0);
    expect(session.syncLastMatch()).toEqual(session.matchResultAt(0));

    // Undo the first piece too: empty stack -> message clears.
    session.undo(learner);
    expect(session.topPieceIndex()).toBeNull();
    expect(session.syncLastMatch()).toBeNull();
    expect(session.lastMatchResult()).toBeNull();

    // Redo the first piece: its stored result (a mismatch) is re-surfaced.
    session.redo(learner);
    expect(session.topPieceIndex()).toBe(0);
    const redone = session.syncLastMatch();
    expect(redone).toEqual(firstResult);
    expect(redone?.match).toBe(false);
  });

  // Wire main.tsx's capture-at-lock flow onto a learner so real placements are
  // compared and stored, exactly as production does.
  function wireCapture(
    session: TrainingSession,
    learner: ReturnType<typeof buildProEngine>,
  ): void {
    let pending: { piece: string; x: number; y: number; rot: number } | null =
      null;
    let pendingIdx = 0;
    learner.events.on("falling.lock.pre", () => {
      const f = learner.falling;
      pending = {
        piece: String(f.symbol),
        x: Math.floor(f.location[0]),
        y: Math.floor(f.location[1]),
        rot: f.rotation,
      };
      pendingIdx = session.currentTargetIndex();
    });
    learner.events.on("falling.lock", (res: { spin: string; lines: number }) => {
      if (!pending) return;
      session.recordLearnerPlacement(
        {
          ...pending,
          spin: res.spin,
          clears: res.lines,
          board: learner.snapshot().board.map((row) => row.map((c) => c != null)),
        },
        pendingIdx,
      );
      pending = null;
    });
  }

  it("does not double-count divergence when a mismatched piece is retried", () => {
    const { replay, result } = loadTrack();
    const learner = buildProEngine(replay, { can_undo: true, can_retry: true });
    const session = TrainingSession.start(result.track, { start: 0, end: 10 }, learner);
    wireCapture(session, learner);

    // Misplace the first piece (shove left), producing a mismatch.
    learner.press("moveLeft");
    for (let i = 0; i < 5; i++) learner.tick([]);
    learner.press("hardDrop");
    learner.tick([]);
    expect(session.matchResultAt(0)?.match).toBe(false);
    expect(session.divergenceState()).toEqual({
      compared: 1,
      matched: 0,
      firstDivergence: 0,
    });

    // Retry: undo the mistake (the piece drops out of the derivation) …
    session.undo(learner);
    expect(session.divergenceState().compared).toBe(0);

    // … then place the piece exactly where the pro put it. The real lock flow
    // re-records index 0, overwriting matchHistory[0] with a match.
    const pro = result.track[0];
    const learnerX = Math.floor(learner.falling.location[0]);
    const dx = pro.x - learnerX;
    for (let i = 0; i < Math.abs(dx); i++) {
      learner.press(dx > 0 ? "moveRight" : "moveLeft");
      learner.tick([]);
    }
    while (learner.falling.rotation !== pro.rot) {
      learner.press("rotateCW");
      learner.tick([]);
    }
    learner.press("hardDrop");
    learner.tick([]);

    const d = session.divergenceState();
    // Exactly one piece on the board — the retry must NOT leave compared:2.
    expect(d.compared).toBe(1);
    // It landed on the pro's spot, so it matches and no divergence remains.
    expect(session.matchResultAt(0)?.match).toBe(true);
    expect(d.matched).toBe(1);
    expect(d.firstDivergence).toBeNull();
  });

  it("ignores placements made after the window is complete", () => {
    const { replay, result } = loadTrack();
    const learner = buildProEngine(replay, { can_undo: true, can_retry: true });
    // A 2-piece window; the learner keeps stacking past it.
    const session = TrainingSession.start(result.track, { start: 0, end: 1 }, learner);
    wireCapture(session, learner);

    for (let i = 0; i < 5; i++) {
      learner.press("hardDrop");
      learner.tick([]);
    }
    expect(session.learnerPiecesPlaced()).toBe(5);
    const d = session.divergenceState();
    // Only the 2 in-window pieces are ever compared, no matter how many extra
    // pieces were placed afterward.
    expect(d.compared).toBeLessThanOrEqual(2);
    expect(session.matchResultAt(2)).toBeNull(); // piece past the window: never recorded
    expect(session.matchResultAt(5)).toBeNull();
  });

  it("summarizes the window with match stats and holes/bumpiness deltas", () => {
    const { replay, result } = loadTrack();
    const learner = buildProEngine(replay, { can_undo: true });
    const session = TrainingSession.start(result.track, { start: 5, end: 8 }, learner);
    const summary = session.summary(learner);
    expect(summary.piecesCompared).toBe(0);
    // Identical boards at window start -> zero deltas initially isn't meaningful,
    // but the shape is correct.
    expect(typeof summary.holesDelta).toBe("number");
    expect(typeof summary.bumpinessDelta).toBe("number");
  });

  // ---- multiplayer garbage injection ----

  it("seeds a window's first piece with the garbage the pro faced", () => {
    // If the window's first piece arrived with garbage already on the pro's
    // board (tanked while placing it), the learner — seeded from the board
    // *before* it — must get that garbage too, or the target ghost floats above
    // an empty base. Piece 32 tanked 4 rows; a window starting there seeds them.
    const { replay, result } = loadMatchTrack();
    expect(result.track[32].garbage).toEqual([{ column: 9, amount: 4, size: 1 }]);

    const learner = buildProEngine(replay, { can_undo: true, can_retry: true });
    TrainingSession.start(result.track, { start: 32, end: 40 }, learner);
    learner.tick([]);
    expect(countGarbageRows(learner.snapshot().board)).toBe(4);
  });

  it("delivers garbage mid-window when the pro received it between pieces", () => {
    // The real bug: garbage that arrives *within* a window. Window [30,40] seeds
    // from track[29] (no garbage). Pieces 30, 31 have none; piece 32 tanked 4
    // rows. After the learner places 30 and 31, facing piece 32, those 4 rows
    // must appear — so the learner builds on the same terrain as the ghost.
    const { replay, result } = loadMatchTrack();
    const learner = buildProEngine(replay, { can_undo: true, can_retry: true });
    const session = TrainingSession.start(
      result.track,
      { start: 30, end: 40 },
      learner,
    );
    learner.tick([]);
    expect(countGarbageRows(learner.snapshot().board)).toBe(0);

    placeAndDeliver(learner, session); // placed piece 30, now facing 31
    expect(countGarbageRows(learner.snapshot().board)).toBe(0);

    placeAndDeliver(learner, session); // placed piece 31, facing 32 -> its 4 rows
    expect(session.learnerPiecesPlaced()).toBe(2);
    expect(countGarbageRows(learner.snapshot().board)).toBe(4);
  });

  it("does not double-inject garbage across an undo/redo of the boundary", () => {
    // The lock event fires again when a piece is redone; garbage for a given
    // piece must be injected only once, or a redo would stack duplicate rows.
    const { replay, result } = loadMatchTrack();
    const learner = buildProEngine(replay, { can_undo: true, can_retry: true });
    const session = TrainingSession.start(
      result.track,
      { start: 30, end: 40 },
      learner,
    );
    learner.tick([]);
    placeAndDeliver(learner, session);
    placeAndDeliver(learner, session); // facing 32, 4 rows injected
    expect(countGarbageRows(learner.snapshot().board)).toBe(4);

    // Undo back past the boundary, then redo forward across it again.
    session.undo(learner);
    session.redo(learner);
    // Still exactly 4 rows — not 8.
    expect(countGarbageRows(learner.snapshot().board)).toBe(4);
  });

  it("re-injects garbage after undoing across the boundary and re-placing", () => {
    // The reported bug: undo back over the garbage boundary (which removes the
    // rows), then place the previous piece *fresh* rather than redoing. This
    // clears the redo stack, so the boundary piece is reached by a genuine new
    // placement — and its garbage must be laid down again. A once-per-index
    // "already injected" guard would wrongly skip it, leaving the board (and the
    // target ghost) garbage-free.
    const { replay, result } = loadMatchTrack();
    const learner = buildProEngine(replay, { can_undo: true, can_retry: true });
    const session = TrainingSession.start(
      result.track,
      { start: 30, end: 40 },
      learner,
    );
    learner.tick([]);
    placeAndDeliver(learner, session);
    placeAndDeliver(learner, session); // facing 32 -> 4 rows
    expect(countGarbageRows(learner.snapshot().board)).toBe(4);

    // Undo to before the boundary: the rows come off with the board restore.
    session.undo(learner);
    expect(countGarbageRows(learner.snapshot().board)).toBe(0);

    // Re-place that piece somewhere else (a fresh placement, not a redo), which
    // re-crosses into the boundary piece — the 4 rows must return.
    learner.press("moveLeft");
    for (let i = 0; i < 5; i++) learner.tick([]);
    placeAndDeliver(learner, session);
    expect(session.learnerPiecesPlaced()).toBe(2);
    expect(countGarbageRows(learner.snapshot().board)).toBe(4);
  });

  it("re-injects garbage after undoing to the window start and replaying", () => {
    // Undo all the way back to the seed, then play forward again: the mid-window
    // garbage must reappear at the same piece (the watermark fully rewinds).
    const { replay, result } = loadMatchTrack();
    const learner = buildProEngine(replay, { can_undo: true, can_retry: true });
    const session = TrainingSession.start(
      result.track,
      { start: 30, end: 40 },
      learner,
    );
    learner.tick([]);
    for (let i = 0; i < 3; i++) placeAndDeliver(learner, session);
    expect(countGarbageRows(learner.snapshot().board)).toBe(4);

    while (session.learnerPiecesPlaced() > 0) session.undo(learner);
    expect(countGarbageRows(learner.snapshot().board)).toBe(0);

    for (let i = 0; i < 2; i++) placeAndDeliver(learner, session);
    expect(countGarbageRows(learner.snapshot().board)).toBe(4);
  });

  it("keeps a garbage-free piece's board matching the pro (delivery is deferred)", () => {
    // The comparison bug: delivering piece i+1's garbage on piece i's lock put
    // the rows on the board before piece i was compared, so a garbage-free piece
    // (e.g. 31) spuriously mismatched the pro's garbage-free board. Delivery must
    // happen only *after* the compare. Here: after placing piece 31 like the pro
    // and delivering, the board has the pro's incoming garbage — but the compare
    // for 31 already ran against a 0-garbage board (mirrored by the ordering in
    // placeAndDeliver, which delivers last).
    const { replay, result } = loadMatchTrack();
    expect(countGarbageRows(result.track[31].snapshot.board)).toBe(0);
    expect(countGarbageRows(result.track[32].snapshot.board)).toBe(4);

    const learner = buildProEngine(replay, { can_undo: true, can_retry: true });
    const session = TrainingSession.start(
      result.track,
      { start: 30, end: 40 },
      learner,
    );
    learner.tick([]);
    placeAndDeliver(learner, session); // piece 30
    // Right after placing piece 31 (before delivery) the board must still be
    // garbage-free — matching pro track[31]. Assert at that exact instant.
    learner.press("hardDrop");
    learner.tick([]);
    expect(countGarbageRows(learner.snapshot().board)).toBe(0);
    // Now deliver: the next piece (32) gets its 4 rows.
    session.deliverIncomingGarbage(learner);
    expect(countGarbageRows(learner.snapshot().board)).toBe(4);
  });

  it("clears the inherited garbage queue so garbage isn't delivered twice", () => {
    // The pro's seed snapshot carries a pending garbage queue (garbage the engine
    // would tank on its own as frames advance). If left in place, near an arrival
    // it tanks natively AND our injection fires — 8 rows instead of 4. The session
    // clears the queue at seed so our per-piece injection is the only source.
    const { replay, result } = loadMatchTrack();
    const learner = buildProEngine(replay, { can_undo: true, can_retry: true });
    const session = TrainingSession.start(
      result.track,
      { start: 31, end: 40 },
      learner,
    );
    learner.tick([]);
    // The inherited queue is emptied at seed.
    const gq = (learner as unknown as { garbageQueue?: { queue?: unknown[] } })
      .garbageQueue;
    expect(gq?.queue?.length ?? 0).toBe(0);

    // Place piece 31 and let MANY frames pass (as the RAF loop would) before
    // delivering — the engine must NOT tank anything on its own, so after delivery
    // there are exactly 4 rows (piece 32's arrival), never 8.
    learner.press("hardDrop");
    for (let i = 0; i < 60; i++) learner.tick([]);
    expect(countGarbageRows(learner.snapshot().board)).toBe(0);
    session.deliverIncomingGarbage(learner);
    expect(countGarbageRows(learner.snapshot().board)).toBe(4);
  });
});
