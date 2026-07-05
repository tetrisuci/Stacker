import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseReplay } from "../replay/parse";
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

  it("starts both boards empty when the window starts at piece 0", () => {
    const { replay, result } = loadTrack();
    const learner = buildProEngine(replay);
    const session = TrainingSession.start(result.track, { start: 0, end: 10 }, learner);
    // No pieces placed yet -> the learner board and the pro board are both empty.
    expect(learner.snapshot().board.flat().filter(Boolean).length).toBe(0);
    expect(
      session.proSnapshotFor().board.flat().filter(Boolean).length,
    ).toBe(0);
  });

  it("advances the pro board in lockstep with the learner's placements", () => {
    const { replay, result } = loadTrack();
    const learner = buildProEngine(replay);
    const session = TrainingSession.start(result.track, { start: 10, end: 30 }, learner);

    // Before any placement the pro board shows the board before piece 10 (empty
    // window), so its last-placed index sits at the window start.
    expect(session.proIndexFor()).toBe(10);
    learner.press("hardDrop");
    learner.tick([]);
    expect(session.learnerPiecesPlaced()).toBe(1);
    // After one placement the pro board shows the board with piece 10 placed.
    expect(session.proIndexFor()).toBe(10);
    // And the board it renders now includes that piece (before piece 11).
    expect(
      session.proSnapshotFor().board.flat().filter(Boolean).length,
    ).toBe(result.track[10].snapshot.board.flat().filter(Boolean).length);
  });

  it("reports piece index and elapsed time for both boards", () => {
    const { replay, result } = loadTrack();
    const learner = buildProEngine(replay);
    const session = TrainingSession.start(result.track, { start: 5, end: 15 }, learner);

    const ls0 = session.learnerStatus(learner);
    expect(ls0.pieceInWindow).toBe(0);
    expect(ls0.windowLength).toBe(11);
    expect(ls0.elapsedSec).toBe(0);

    // Advance a few learner frames + a placement.
    for (let i = 0; i < 30; i++) learner.tick([]);
    learner.press("hardDrop");
    learner.tick([]);
    const ls1 = session.learnerStatus(learner);
    expect(ls1.pieceInWindow).toBe(1);
    expect(ls1.elapsedSec).toBeGreaterThan(0);

    const ps = session.proStatus();
    expect(ps.pieceInWindow).toBe(1);
    expect(ps.absoluteIndex).toBe(6);
    // The pro clock is absolute replay time: piece 6's replay timestamp, not
    // time since the window start.
    expect(ps.elapsedSec).toBeCloseTo(result.track[6].frame / 60, 6);
    expect(session.proStatus().elapsedSec).toBeGreaterThan(0);
  });

  it("starts the pro clock at the start piece's replay time", () => {
    const { replay, result } = loadTrack();
    const learner = buildProEngine(replay);
    const session = TrainingSession.start(result.track, { start: 20, end: 40 }, learner);
    expect(session.proStatus().elapsedSec).toBeCloseTo(
      result.track[20].frame / 60,
      6,
    );
  });

  it("clamps the pro board to the window end and marks done", () => {
    const { replay, result } = loadTrack();
    const learner = buildProEngine(replay);
    const session = TrainingSession.start(result.track, { start: 0, end: 3 }, learner);

    // Place more pieces than the 4-piece window.
    for (let i = 0; i < 10; i++) {
      learner.press("hardDrop");
      learner.tick([]);
    }
    expect(session.proIndexFor()).toBe(3); // clamped to end
    expect(session.learnerStatus(learner).done).toBe(true);
    expect(session.proStatus().done).toBe(true);
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

describe("TrainingSession garbage mirroring", () => {
  /** Number of garbage cells on the learner's board (each row has 9). */
  const garbageCells = (learner: ReturnType<typeof buildProEngine>) =>
    learner
      .snapshot()
      .board.flat()
      .filter((t) => (t as { mino?: string } | null)?.mino === "gb").length;

  const garbageAt = (beforePiece: number, amount: number, column = 4) => ({
    beforePiece,
    amount,
    rows: [{ column, amount, size: 1, id: beforePiece }],
  });

  it("inserts the pro's garbage rows at the same piece boundary", () => {
    const { replay, result } = loadTrack();
    const learner = buildProEngine(replay);
    // Synthetic schedule: 4 rows under piece 12, 2 more under piece 14.
    const garbage = [garbageAt(12, 4), garbageAt(14, 2)];
    const session = TrainingSession.start(
      result.track,
      { start: 10, end: 20 },
      learner,
      garbage,
    );

    // At the window start (piece 10 falling) nothing is due yet.
    session.mirrorGarbage(learner);
    expect(garbageCells(learner)).toBe(0);

    // Place 2 pieces -> piece 12 falling -> the first rows are on the board.
    learner.press("hardDrop");
    learner.tick([]);
    learner.press("hardDrop");
    learner.tick([]);
    session.mirrorGarbage(learner);
    expect(garbageCells(learner)).toBe(4 * 9);

    // Place 2 more -> piece 14 falling -> the second rows (cumulative 6).
    learner.press("hardDrop");
    learner.tick([]);
    learner.press("hardDrop");
    learner.tick([]);
    session.mirrorGarbage(learner);
    expect(garbageCells(learner)).toBe(6 * 9);
  });

  it("puts the hole in the recorded column", () => {
    const { replay, result } = loadTrack();
    const learner = buildProEngine(replay);
    const session = TrainingSession.start(
      result.track,
      { start: 10, end: 20 },
      learner,
      [garbageAt(11, 2, 7)],
    );
    learner.press("hardDrop");
    learner.tick([]);
    session.mirrorGarbage(learner);
    const board = learner.snapshot().board;
    for (const y of [0, 1]) {
      for (let x = 0; x < 10; x++) {
        const cell = board[y][x] as { mino?: string } | null;
        if (x === 7) expect(cell).toBeNull();
        else expect(cell?.mino).toBe("gb");
      }
    }
  });

  it("does not double-insert garbage across repeated frames", () => {
    const { replay, result } = loadTrack();
    const learner = buildProEngine(replay);
    const session = TrainingSession.start(
      result.track,
      { start: 0, end: 10 },
      learner,
      [garbageAt(1, 3)],
    );
    learner.press("hardDrop");
    learner.tick([]);
    session.mirrorGarbage(learner);
    session.mirrorGarbage(learner);
    session.mirrorGarbage(learner);
    expect(garbageCells(learner)).toBe(3 * 9); // exactly once, not thrice
  });

  it("ignores garbage scheduled outside the window", () => {
    const { replay, result } = loadTrack();
    const learner = buildProEngine(replay);
    const session = TrainingSession.start(
      result.track,
      { start: 10, end: 20 },
      learner,
      [
        garbageAt(5, 4), // before window: already part of the seed board
        garbageAt(30, 4), // after window: never needed
      ],
    );
    // Advance well past the window; out-of-window garbage never arrives.
    for (let i = 0; i < 15; i++) {
      learner.press("hardDrop");
      learner.tick([]);
      session.mirrorGarbage(learner);
    }
    expect(garbageCells(learner)).toBe(0);
  });

  it("re-inserts garbage that an undo rolled back", () => {
    const { replay, result } = loadTrack();
    const learner = buildProEngine(replay, { can_undo: true, can_retry: true });
    const session = TrainingSession.start(
      result.track,
      { start: 10, end: 20 },
      learner,
      [garbageAt(12, 2)],
    );
    learner.press("hardDrop");
    learner.tick([]);
    learner.press("hardDrop");
    learner.tick([]);
    session.mirrorGarbage(learner);
    expect(garbageCells(learner)).toBe(2 * 9);

    // Undo piece 11: the restored spawn snapshot predates the insertion.
    session.undo(learner);
    session.resyncGarbage();
    session.mirrorGarbage(learner);
    expect(garbageCells(learner)).toBe(0);

    // Re-place it: the rows come back at the same boundary.
    learner.press("hardDrop");
    learner.tick([]);
    session.mirrorGarbage(learner);
    expect(garbageCells(learner)).toBe(2 * 9);
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

  it("keeps the piece count and pro board in sync through undo/redo", () => {
    const { learner, session } = sessionWithUndo();
    const start = session.window.start; // 10

    // Each drop advances placed count and pro index by exactly one.
    learner.press("hardDrop");
    learner.tick([]);
    learner.press("hardDrop");
    learner.tick([]);
    learner.press("hardDrop");
    learner.tick([]);
    expect(session.learnerPiecesPlaced()).toBe(3);
    // proIndexFor is the pro board's *last-placed* index, one behind the piece
    // being worked toward: after placing 3 pieces it shows piece start+2.
    expect(session.proIndexFor()).toBe(start + 2);

    // Undo removes exactly one piece from the count/index each time.
    session.undo(learner);
    expect(session.learnerPiecesPlaced()).toBe(2);
    expect(session.proIndexFor()).toBe(start + 1);

    session.undo(learner);
    expect(session.learnerPiecesPlaced()).toBe(1);
    expect(session.proIndexFor()).toBe(start + 0);

    // Redo restores exactly one.
    session.redo(learner);
    expect(session.learnerPiecesPlaced()).toBe(2);
    expect(session.proIndexFor()).toBe(start + 1);

    // A fresh drop after redo continues cleanly.
    learner.press("hardDrop");
    learner.tick([]);
    expect(session.learnerPiecesPlaced()).toBe(3);
    expect(session.proIndexFor()).toBe(start + 2);
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
    expect(session.proIndexFor()).toBe(session.window.start + 2);
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
    expect(match.match).toBe(true);
    expect(session.divergenceState().matched).toBe(1);
    expect(session.divergenceState().firstDivergence).toBeNull();
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
    expect(match.match).toBe(false);
    expect(session.divergenceState().firstDivergence).toBe(idx);
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
});
