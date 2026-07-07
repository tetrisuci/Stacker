// The trainer's imperative bootstrap, extracted verbatim from the old
// src/main.tsx module scope so <TrainerView> can run it inside a useEffect:
// startTrainer() wires the engine, input bridge, settings, and game loop to
// the DOM nodes the view rendered, and returns the stores/callbacks the React
// panels need plus a dispose() that tears everything down on route leave.
//
// This module deliberately does NOT touch React — it is the same
// engine/session/render/input/settings orchestration as before, behind a
// function boundary.

import { createStandardEngine, type Engine, type EngineSnapshot } from "../engine/adapter";
import { KeyboardSource } from "../input/keyboard";
import { startGameLoop } from "../game/gameLoop";
import { KeyTape } from "../game/keyTape";
import { computeStats } from "../game/stats";
import { StatsStore } from "../game/statsStore";
import { fallingBase, type RenderOverlay } from "../render/render";
import { SettingsStore } from "../settings/store";
import { connectSettings } from "../settings/apply";
import { buildProEngine } from "../replay/proEngine";
import { TrainingSession } from "../session/trainingSession";
import { ComparisonStore } from "../session/comparisonStore";
import { KeyHintsStore } from "../session/keyHintsStore";
import { toOccupancy, type PlacementRecord } from "../session/compare";
import type { ParsedReplay } from "../replay/parse";
import type { ReconstructionResult } from "../replay/reconstruct";

/**
 * A fresh random seed for the free-play board (the engine's Lehmer RNG wants
 * an integer in [1, 2^31 - 2]), so every page load and restart deals a new
 * bag. Replay sessions use the replay's own seed instead.
 */
const randomSeed = (): number => 1 + Math.floor(Math.random() * (2 ** 31 - 2));

function buildEngine(): Engine {
  const engine = createStandardEngine({
    width: 10,
    height: 20,
    kickTable: "SRS+",
    seed: randomSeed(),
    bagType: "7-bag",
  });
  engine.tick([]); // spawn the first piece
  return engine;
}

export interface TrainerElements {
  canvas: HTMLCanvasElement;
  learnerInfoEl: HTMLElement | null;
  statusEl: HTMLElement | null;
}

/** Everything the trainer view's React panels need from the live trainer. */
export interface TrainerController {
  settingsStore: SettingsStore;
  statsStore: StatsStore;
  comparisonStore: ComparisonStore;
  keyHintsStore: KeyHintsStore;
  startSession: (
    replay: ParsedReplay,
    result: ReconstructionResult,
    window: { start: number; end: number },
  ) => void;
  endSession: () => void;
  retryPiece: () => void;
  onReviewSnapshot: (snapshot: EngineSnapshot | null) => void;
  /** Stop the loop, detach input, unsubscribe settings. */
  dispose: () => void;
}

export function startTrainer({
  canvas,
  learnerInfoEl,
  statusEl,
}: TrainerElements): TrainerController {
  let engine = buildEngine();

  // Active training session (dual-board pro-vs-learner), or null for free play.
  let session: TrainingSession | null = null;
  // Re-enters the active session from its window start (set by startSession).
  // The Restart key uses this during a session: rebuilding the free-play engine
  // instead would hand the learner a completely different piece queue.
  let sessionRestart: (() => void) | null = null;
  // "Stack like the pro" comparison state, shown in the ComparisonPanel.
  const comparisonStore = new ComparisonStore();
  // Live key-hint sequence (presses to reach the target), shown below the board.
  const keyHintsStore = new KeyHintsStore();
  // The pro index the learner's currently-falling piece is being compared
  // against (captured before it locks, since the lock advances the count).
  let pendingTargetIndex = 0;
  // Press-count-per-placement history: undo/redo restore the keys stat along
  // with the board (the keys spent on an undone piece don't stay counted).
  const keyTape = new KeyTape();

  /** Record the press count at every lock on this engine (call per engine —
   * they're rebuilt on restart and session start). */
  function trackKeyTape(target: Engine): void {
    target.events.on("falling.lock", () => keyTape.record(input.pressCount));
  }

  /** New game: zero the live counter and the per-placement history. */
  function resetKeyCount(): void {
    input.resetPressCount();
    keyTape.reset();
  }

  /**
   * Undo/redo one placement with the key counter restored alongside the
   * board. The engine call may be a no-op (empty/capped undo stack, window
   * edge), and `Engine.undo()` returns no success signal — so success is
   * detected via the practice-stack depth, the same technique
   * TrainingSession.undo uses (whose boolean we reuse in-session).
   */
  function undoOnce(): void {
    let didUndo: boolean;
    if (session) {
      didUndo = session.undo(engine);
    } else {
      const before = engine.practice?.undo?.length ?? 0;
      engine.undo();
      didUndo = (engine.practice?.undo?.length ?? 0) < before;
    }
    if (didUndo) {
      const count = keyTape.undo();
      if (count !== null) input.pressCount = count;
    }
    afterUndoRedo();
  }
  function redoOnce(): void {
    let didRedo: boolean;
    if (session) {
      didRedo = session.redo(engine);
    } else {
      const before = engine.practice?.redo?.length ?? 0;
      engine.redo();
      didRedo = (engine.practice?.redo?.length ?? 0) < before;
    }
    if (didRedo) {
      const count = keyTape.redo();
      if (count !== null) input.pressCount = count;
    }
    afterUndoRedo();
  }

  if (import.meta.env.DEV) {
    // configurable so a route remount (or StrictMode) can redefine them.
    Object.defineProperty(window, "__engine", {
      get: () => engine,
      configurable: true,
    });
    Object.defineProperty(window, "__session", {
      get: () => session,
      configurable: true,
    });
    Object.defineProperty(window, "__comparison", {
      get: () => comparisonStore,
      configurable: true,
    });
  }

  /** The pro's target-ghost overlay for the learner board during a session. */
  function sessionOverlay(): RenderOverlay | undefined {
    const s = session;
    if (!s) return undefined;
    // `lookahead` counts ghost pieces shown, the current target first: 0 =
    // none, 1 = the target only, 2+ = the target plus upcoming placements.
    const lookahead = comparisonStore.getSnapshot().lookahead;
    if (lookahead <= 0) return undefined;
    return {
      targetGhost: s.targetGhost(),
      nextTargetGhosts: Array.from({ length: lookahead - 1 }, (_, i) =>
        s.targetGhost(i + 1),
      ),
    };
  }

  /** Push the session's current comparison state into the store. */
  function publishComparison(): void {
    if (!session) return;
    comparisonStore.set({
      active: true,
      divergence: session.divergenceState(),
      lastMatch: session.lastMatchResult(),
    });
  }

  const fmtTime = (sec: number): string => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s.toFixed(2).padStart(5, "0")}`;
  };

  /** Start a dual-board session: seed the learner from the window start. */
  function startSession(
    replay: ParsedReplay,
    result: ReconstructionResult,
    window: { start: number; end: number },
  ): void {
    reviewSnapshot = null;
    resetKeyCount(); // a session (re)start is a new game

    // Learner uses the SAME options as the pro (seed/bagtype/handling), then
    // gets the user's handling/gravity applied on top, then is seeded from
    // the pro's board state at the window start.
    // Undo/redo are learner practice aids; the replay may not permit them,
    // and the engine wires its undo hooks at construction from `can_undo`, so
    // we must enable them via the options up-front.
    engine = buildProEngine(replay, { can_undo: true, can_retry: true });
    trackKeyTape(engine);
    settings.applyEngineSettings(engine);
    loop.bindEngine(engine);
    const activeSession = TrainingSession.start(result.track, window, engine);
    session = activeSession;

    // Capture each learner placement at lock and compare it to the pro's. We
    // read the falling piece's floored anchor at lock.pre (still the active
    // piece) and the post-lock board + spin/clears at lock.
    let pendingPiece: {
      piece: string;
      x: number;
      y: number;
      rot: number;
    } | null = null;
    engine.events.on("falling.lock.pre", () => {
      const f = engine.falling;
      const [bx, by] = fallingBase(f.location);
      pendingPiece = {
        piece: String(f.symbol),
        x: bx,
        y: by,
        rot: f.rotation,
      };
      // The index this piece corresponds to (before the count advances).
      pendingTargetIndex = activeSession.currentTargetIndex();
    });
    engine.events.on("falling.lock", (res) => {
      if (!pendingPiece) return;
      const board = toOccupancy(engine.snapshot().board);
      const learnerPlacement: PlacementRecord = {
        piece: pendingPiece.piece,
        x: pendingPiece.x,
        y: pendingPiece.y,
        rot: pendingPiece.rot,
        spin: res.spin,
        clears: res.lines,
        board,
      };
      activeSession.recordLearnerPlacement(learnerPlacement, pendingTargetIndex);
      // Only *after* the just-locked piece is compared (against the pro's board,
      // which is garbage-free for it at this moment) do we deliver the garbage the
      // pro received before the next piece — so the next piece is placed on the
      // same terrain the pro had, while this piece's comparison stays honest.
      activeSession.deliverIncomingGarbage(engine);
      pendingPiece = null;
      publishComparison();
    });

    comparisonStore.reset();
    // The player's username replaces "the pro" in the comparison panel text.
    const proName = replay.metadata.username || "PRO";
    comparisonStore.set({ active: true, proName });
    sessionRestart = () => startSession(replay, result, window);
    setStatus("");
  }

  /** Leave session mode and go back to free play. */
  function endSession(): void {
    session = null;
    sessionRestart = null;
    comparisonStore.reset();
    keyHintsStore.set(null);
    if (learnerInfoEl) learnerInfoEl.textContent = "";
    restart();
  }

  /**
   * Re-sync the comparison panel after an undo or redo: the displayed message
   * now reflects the piece on top of the learner's stack (cleared if the
   * stack is empty, or the redone piece's stored mismatch).
   */
  function afterUndoRedo(): void {
    if (!session) return;
    session.syncLastMatch();
    publishComparison();
  }

  /**
   * Retry the current piece after a mismatch: undo the learner's last
   * placement so they can re-attempt it against the same target ghost.
   */
  function retryPiece(): void {
    if (!session) return;
    undoOnce();
  }

  // Live stats store, fed by the loop each frame and shown in the StatsPanel.
  const statsStore = new StatsStore();

  const setStatus = (text: string) => {
    if (statusEl) statusEl.textContent = text;
  };

  // Restart from scratch — works at any time, not only after a topout. During
  // a session this re-enters the session at its window start (same seed and
  // queue); rebuilding the free-play engine would desync from the replay.
  const restart = () => {
    if (sessionRestart) {
      sessionRestart();
      return;
    }
    reviewSnapshot = null; // leave replay review, if active
    resetKeyCount();
    engine = buildEngine();
    trackKeyTape(engine);
    settings.applyEngineSettings(engine);
    loop.bindEngine(engine);
    statsStore.set(computeStats(engine.snapshot(), input.pressCount));
    setStatus("");
  };

  // Toggle the target-ghost display: off (0) ↔ the last non-zero count.
  let lastGhostCount = 1;
  const toggleGhosts = () => {
    const current = comparisonStore.getSnapshot().lookahead;
    if (current > 0) {
      lastGhostCount = current;
      comparisonStore.set({ lookahead: 0 });
    } else {
      comparisonStore.set({ lookahead: lastGhostCount });
    }
  };

  // Settings store (loads persisted values) + input bridge seeded from it.
  const settingsStore = new SettingsStore();
  const input = new KeyboardSource({
    keymap: settingsStore.keymap,
    onAppKey: (key) => {
      if (key === "restart") restart();
      else if (key === "toggleGhosts") toggleGhosts();
      else if (key === "undo") {
        // In a session, go through the session so its piece counter stays in
        // sync; undoing clears the mismatch prompt for the removed piece.
        // Both paths also restore the keys stat to the undone piece's spawn.
        undoOnce();
      } else if (key === "redo") {
        redoOnce();
      }
    },
  });
  input.attach();
  // The engines built later (restart, session start) attach their own tape
  // listener; cover the initial free-play engine too.
  trackKeyTape(engine);

  // Live-apply handling + keymap from the store to the engine and input.
  const settings = connectSettings(settingsStore, () => engine, input);
  if (import.meta.env.DEV) {
    Object.defineProperty(window, "__store", {
      get: () => settingsStore,
      configurable: true,
    });
  }

  // Replay-review override: when set, the loop renders this snapshot (a
  // reconstructed placement) instead of the live engine.
  let reviewSnapshot: EngineSnapshot | null = null;

  let summaryShown = false;

  const loop = startGameLoop(canvas, () => engine, input, {
    reviewSnapshot: () => reviewSnapshot,
    overlay: sessionOverlay,
    onRender: () => {
      // Update the live stats panel from whatever is currently shown. The key
      // counter is the learner's regardless of what board is displayed.
      // During a session the piece count comes from the session's own
      // counter, not the engine's — engine `stats.pieces` drifts across
      // undo/redo snapshot restores (the piece counter under the board uses
      // the same source, so the two always agree).
      statsStore.set(
        computeStats(
          reviewSnapshot ?? engine.snapshot(),
          input.pressCount,
          session && !reviewSnapshot
            ? session.learnerPiecesPlaced()
            : undefined,
        ),
      );

      // During a session, update the learner's piece/elapsed-time line.
      if (session) {
        const ls = session.learnerStatus(engine);
        // Piece counter shows absolute replay indexes: a window starting at
        // piece 60 counts from 60, out of the piece after the window's end.
        const winStart = session.window.start;
        const total = session.window.end + 1;
        if (learnerInfoEl)
          learnerInfoEl.textContent = `piece ${winStart + ls.pieceInWindow}/${total} · ${fmtTime(ls.elapsedSec)}`;
        // At window end, publish the summary once.
        if (ls.done && !summaryShown) {
          summaryShown = true;
          comparisonStore.set({ summary: session.summary(engine) });
          setStatus("Window complete!");
        } else if (!ls.done) {
          summaryShown = false;
        }
        // Key hints: the pro's actual keydown finesse for the current target
        // piece, so the learner drills the exact inputs. Static per piece (the
        // store dedupes, so this only re-renders when the target advances).
        // Suppressed at window end (no target) or when the option is off.
        keyHintsStore.set(
          comparisonStore.getSnapshot().keyHints && !ls.done
            ? session.targetInputs(0)
            : null,
        );
      }
    },
    onGameOver: () => {
      setStatus("Game over — press Restart");
    },
  });

  statsStore.set(computeStats(engine.snapshot(), input.pressCount));

  return {
    settingsStore,
    statsStore,
    comparisonStore,
    keyHintsStore,
    startSession,
    endSession,
    retryPiece,
    onReviewSnapshot: (snapshot) => {
      // Enter/leave review mode: the loop reads `reviewSnapshot` each frame.
      reviewSnapshot = snapshot;
      setStatus(
        snapshot
          ? "Reviewing reconstruction — click the board and press Restart to resume live"
          : "",
      );
    },
    dispose: () => {
      loop.stop();
      input.detach();
      settings.dispose();
    },
  };
}
