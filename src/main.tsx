// Phase 3 dev entry: playable stacker + live settings panel.
//
// Builds a self-contained standard 7-bag engine (via the adapter), runs the
// fixed-timestep 60 Hz game loop with keyboard input, and mounts a React
// settings panel whose handling (ARR/DAS/DCD/SDF) and key rebindings apply
// live to the engine and input bridge. Settings persist to localStorage.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createStandardEngine, type Engine } from "./engine/adapter";
import { KeyboardSource } from "./input/keyboard";
import { startGameLoop } from "./game/gameLoop";
import { computeStats } from "./game/stats";
import { StatsStore } from "./game/statsStore";
import { StatsPanel } from "./game/StatsPanel";
import {
  render,
  fallingBase,
  DEFAULT_LAYOUT,
  type RenderOverlay,
} from "./render/render";
import { sizeCanvas } from "./render/loop";
import { SettingsStore } from "./settings/store";
import { connectSettings } from "./settings/apply";
import { SettingsPanel } from "./settings/SettingsPanel";
import { ReplayPanel } from "./replay/ReplayPanel";
import { buildProEngine } from "./replay/proEngine";
import { TrainingSession } from "./session/trainingSession";
import { ComparisonStore } from "./session/comparisonStore";
import { ComparisonPanel } from "./session/ComparisonPanel";
import { toOccupancy, type PlacementRecord } from "./session/compare";
import type { ParsedReplay } from "./replay/parse";
import type { ReconstructionResult } from "./replay/reconstruct";

/**
 * A fresh random seed for the free-play board (the engine's Lehmer RNG wants
 * an integer in [1, 2^31 - 2]), so every page load and restart deals a new
 * bag. Replay sessions use the replay's own seed instead.
 */
const randomSeed = (): number =>
  1 + Math.floor(Math.random() * (2 ** 31 - 2));

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

const canvas = document.querySelector<HTMLCanvasElement>("#board");
const proCanvas = document.querySelector<HTMLCanvasElement>("#board-pro");
const proTitleEl = document.querySelector<HTMLElement>("#pro-title");
const proInfoEl = document.querySelector<HTMLElement>("#pro-info");
const learnerInfoEl = document.querySelector<HTMLElement>("#learner-info");
const statusEl = document.querySelector<HTMLElement>("#status");
const statsMount = document.querySelector<HTMLElement>("#stats-root");
const panelMount = document.querySelector<HTMLElement>("#settings-root");
const replayMount = document.querySelector<HTMLElement>("#replay-root");
const comparisonMount = document.querySelector<HTMLElement>("#comparison-root");
if (!canvas) throw new Error("#board canvas not found");

const proCtx = proCanvas?.getContext("2d") ?? null;
if (proCanvas) sizeCanvas(proCanvas, DEFAULT_LAYOUT, 10);

// An empty snapshot for the pro board's default state (no replay loaded yet):
// a fresh board with no active piece, hold, or queue.
function emptyProSnapshot(): import("./engine/adapter").EngineSnapshot {
  const snap = createStandardEngine({ seed: 0 }).snapshot();
  return {
    ...snap,
    falling: { ...snap.falling, symbol: undefined as never },
    hold: null,
    queue: { ...snap.queue, value: [] },
  };
}

/** Draw the pro board's placeholder empty board. */
function renderEmptyProBoard(): void {
  if (proCtx) render(proCtx, emptyProSnapshot(), DEFAULT_LAYOUT);
}

let engine = buildEngine();

// Active training session (dual-board pro-vs-learner), or null for free play.
let session: TrainingSession | null = null;
// Re-enters the active session from its window start (set by startSession).
// The Restart key uses this during a session: rebuilding the free-play engine
// instead would hand the learner a completely different piece queue.
let sessionRestart: (() => void) | null = null;
// "Stack like the pro" comparison state, shown in the ComparisonPanel.
const comparisonStore = new ComparisonStore();
// The pro index the learner's currently-falling piece is being compared against
// (captured before it locks, since the lock advances the piece count).
let pendingTargetIndex = 0;

if (import.meta.env.DEV) {
  Object.defineProperty(window, "__engine", { get: () => engine });
  Object.defineProperty(window, "__session", { get: () => session });
}

/** The pro's target-ghost overlay for the learner board during a session. */
function sessionOverlay(): RenderOverlay | undefined {
  const s = session;
  if (!s) return undefined;
  // `lookahead` counts ghost pieces shown, the current target first: 0 = none,
  // 1 = the target only, 2+ = the target plus that many upcoming placements.
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

/** Start a dual-board session: seed the learner from the pro's window start. */
function startSession(
  replay: ParsedReplay,
  result: ReconstructionResult,
  window: { start: number; end: number },
): void {
  reviewSnapshot = null;
  // Learner uses the SAME options as the pro (seed/bagtype/handling), then gets
  // the user's handling/gravity applied on top, then is seeded from the pro's
  // board state at the window start.
  // Undo/redo are learner practice aids; the replay may not permit them, and
  // the engine wires its undo hooks at construction from `can_undo`, so we must
  // enable them via the options up-front (not by mutating misc afterward).
  engine = buildProEngine(replay, { can_undo: true, can_retry: true });
  settings.applyEngineSettings(engine);
  loop.bindEngine(engine);
  const activeSession = TrainingSession.start(
    result.track,
    window,
    engine,
    result.garbage,
  );
  session = activeSession;

  // Capture each learner placement at lock and compare it to the pro's. We read
  // the falling piece's floored anchor at lock.pre (still the active piece) and
  // the post-lock board + spin/clears at lock.
  let pendingPiece: { piece: string; x: number; y: number; rot: number } | null =
    null;
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
    pendingPiece = null;
    publishComparison();
  });

  comparisonStore.reset();
  // The player's username labels the pro board and replaces "the pro" in the
  // comparison panel's text.
  const proName = replay.metadata.username || "PRO";
  comparisonStore.set({ active: true, proName });
  if (proTitleEl) {
    proTitleEl.textContent = proName;
    proTitleEl.classList.remove("placeholder");
  }
  sessionRestart = () => startSession(replay, result, window);
  setStatus("");
}

/** Leave session mode and go back to free play. */
function endSession(): void {
  session = null;
  sessionRestart = null;
  comparisonStore.reset();
  // Reset the pro board label to the no-replay placeholder.
  if (proTitleEl) {
    proTitleEl.textContent = "No replay selected";
    proTitleEl.classList.add("placeholder");
  }
  renderEmptyProBoard(); // reset the pro board to empty
  if (proInfoEl) proInfoEl.textContent = "load a replay to begin";
  if (learnerInfoEl) learnerInfoEl.textContent = "";
  restart();
}

/**
 * Re-sync the comparison panel after an undo or redo: the displayed message now
 * reflects the piece on top of the learner's stack (cleared if the stack is
 * empty, or the redone piece's stored mismatch if it was in the wrong spot).
 */
function afterUndoRedo(): void {
  if (!session) return;
  // The restored board snapshot may lack garbage rows inserted while the
  // undone piece was falling; rewind the mirror so they get re-inserted.
  session.resyncGarbage();
  session.mirrorGarbage(engine);
  session.syncLastMatch();
  publishComparison();
}

/**
 * Retry the current piece after a mismatch: undo the learner's last placement so
 * they can re-attempt it against the same target ghost. This shares the undo
 * sync path, so the mismatch message clears (or falls back to the now-top piece).
 */
function retryPiece(): void {
  if (!session) return;
  session.undo(engine);
  afterUndoRedo();
}

// Live stats store, fed by the loop each frame and shown in the StatsPanel.
const statsStore = new StatsStore();

const setStatus = (text: string) => {
  if (statusEl) statusEl.textContent = text;
};

// Restart from scratch — works at any time, not only after a topout. During a
// session this re-enters the session at its window start (same seed/queue);
// rebuilding the free-play engine would desync the learner from the replay.
// Defined before the input bridge so its "restart" app-key can call it.
const restart = () => {
  if (sessionRestart) {
    sessionRestart();
    return;
  }
  reviewSnapshot = null; // leave replay review, if active
  engine = buildEngine();
  settings.applyEngineSettings(engine);
  loop.bindEngine(engine);
  statsStore.set(computeStats(engine.snapshot()));
  setStatus("");
};

// Toggle the target-ghost display: off (0) ↔ the last non-zero count. Bound to
// a key so the learner can flip ghosts mid-session without reaching for the
// slider; the slider in the replay panel reflects the change live.
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

// Settings store (loads persisted values) and input bridge seeded from it.
// The bound "restart" action fires `restart()` (never enters the engine input).
const store = new SettingsStore();
const input = new KeyboardSource({
  keymap: store.keymap,
  onAppKey: (key) => {
    if (key === "restart") restart();
    else if (key === "toggleGhosts") toggleGhosts();
    else if (key === "undo") {
      // In a session, go through the session so its piece counter stays in
      // sync; undoing clears the mismatch prompt for the piece just removed
      // and re-surfaces the stored result for whatever piece is now on top.
      if (session) session.undo(engine);
      else engine.undo();
      afterUndoRedo();
    } else if (key === "redo") {
      // Redoing re-surfaces the restored piece's stored result — if that piece
      // was in the wrong spot, its mismatch message reappears.
      if (session) session.redo(engine);
      else engine.redo();
      afterUndoRedo();
    }
  },
});
input.attach();

// Live-apply handling + keymap from the store to the engine and input.
const settings = connectSettings(store, () => engine, input);
if (import.meta.env.DEV) {
  Object.defineProperty(window, "__store", { get: () => store });
}

// Replay-review override: when set, the loop renders this snapshot (a
// reconstructed placement) instead of the live engine, and pauses simulation.
let reviewSnapshot: import("./engine/adapter").EngineSnapshot | null = null;

let summaryShown = false;

const loop = startGameLoop(canvas, () => engine, input, {
  reviewSnapshot: () => reviewSnapshot,
  overlay: sessionOverlay,
  onRender: () => {
    // Update the live stats panel from whatever is currently shown.
    statsStore.set(computeStats(reviewSnapshot ?? engine.snapshot()));

    // During a session, render the pro board (left) advancing in lockstep with
    // the learner, and update both boards' piece-index / elapsed-time lines.
    if (session && proCtx) {
      // Mirror the pro's received garbage onto the learner at the same index.
      session.mirrorGarbage(engine);
      const proSnap = session.proSnapshotFor();
      render(proCtx, proSnap, DEFAULT_LAYOUT);
      const ps = session.proStatus();
      const ls = session.learnerStatus(engine);
      // Piece counters show absolute replay indexes: a window starting at
      // piece 60 counts from 60, out of the piece after the window's end.
      const winStart = session.window.start;
      const total = session.window.end + 1;
      if (proInfoEl)
        proInfoEl.textContent = `piece ${winStart + ps.pieceInWindow}/${total} · ${fmtTime(ps.elapsedSec)}`;
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
    }
  },
  onGameOver: () => {
    setStatus("Game over — press Restart");
  },
});

statsStore.set(computeStats(engine.snapshot()));

// Show an empty pro board by default (before any replay is loaded).
renderEmptyProBoard();
if (proInfoEl) proInfoEl.textContent = "load a replay to begin";

// Mount the live stats panel (Pieces/PPS, Attack/APM).
if (statsMount) {
  createRoot(statsMount).render(
    <StrictMode>
      <StatsPanel store={statsStore} />
    </StrictMode>,
  );
}

// Mount the React settings panel.
if (panelMount) {
  createRoot(panelMount).render(
    <StrictMode>
      <SettingsPanel store={store} />
    </StrictMode>,
  );
}

// Mount the "stack like the pro" comparison panel (shown during a session).
if (comparisonMount) {
  createRoot(comparisonMount).render(
    <StrictMode>
      <ComparisonPanel store={comparisonStore} onRetry={retryPiece} />
    </StrictMode>,
  );
}

// Mount the replay loader + metadata panel. Building the pro engine is enough
// for this phase; ticking the replay comes later. Expose it in dev.
if (replayMount) {
  createRoot(replayMount).render(
    <StrictMode>
      <ReplayPanel
        onReviewSnapshot={(snapshot) => {
          // Enter/leave review mode: the loop reads `reviewSnapshot` each frame.
          reviewSnapshot = snapshot;
          setStatus(
            snapshot
              ? "Reviewing reconstruction — click the board and press Restart to resume live"
              : "",
          );
        }}
        onStartSession={startSession}
        onEndSession={endSession}
        comparison={comparisonStore}
      />
    </StrictMode>,
  );
}
