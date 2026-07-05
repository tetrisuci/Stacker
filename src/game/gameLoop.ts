// Fixed-timestep game loop.
//
// TETR.IO logic runs at 60 Hz. This loop advances the engine by exactly one
// tick per 1/60 s of real time (using an accumulator so logic stays
// frame-rate-independent), and renders once per animation frame reading the
// latest snapshot(). Buffered keyboard transitions are fed to the engine as
// per-frame tick events, so the engine's own handling drives movement.

import type { Engine, EngineSnapshot } from "../engine/adapter";
import type { InputTransition, KeyboardSource } from "../input/keyboard";
import {
  render,
  DEFAULT_LAYOUT,
  type RenderLayout,
  type RenderOverlay,
} from "../render/render";
import { sizeCanvas } from "../render/loop";

export const LOGIC_HZ = 60;
export const MS_PER_TICK = 1000 / LOGIC_HZ;
/** Cap accumulated catch-up so a long stall can't freeze the tab. */
const MAX_TICKS_PER_FRAME = 8;

/**
 * Turn buffered input transitions into engine tick events for `frame`. Ordering
 * within a frame is preserved via ascending subframe values in [0, 1).
 */
export function transitionsToEvents(
  transitions: InputTransition[],
  frame: number,
): Array<{
  type: "keydown" | "keyup";
  data: { key: string; subframe: number };
  frame: number;
}> {
  return transitions.map((t, i) => ({
    type: t.type,
    data: { key: t.key, subframe: i / Math.max(transitions.length, 1) },
    frame,
  }));
}

export interface GameLoopOptions {
  layout?: RenderLayout;
  /** Called once when the engine reports topout (game over). */
  onGameOver?: () => void;
  /** Called after every piece lock, with the engine's LockRes. */
  onLock?: (lines: number) => void;
  /**
   * Called once per rendered frame with the number of logic frames elapsed, for
   * updating live UI (e.g. PPS/APM). Runs after render.
   */
  onRender?: (logicFrames: number) => void;
  /**
   * Optional review override: when it returns a snapshot, the loop renders that
   * snapshot and pauses live simulation (used to scrub a reconstructed replay).
   * Return null to resume normal live play.
   */
  reviewSnapshot?: () => EngineSnapshot | null;
  /** Optional per-frame overlay (e.g. the pro's target ghost) drawn on the board. */
  overlay?: () => RenderOverlay | undefined;
}

export interface GameLoopHandle {
  stop: () => void;
  /** Current logic-frame count advanced by this loop. */
  frames: () => number;
  /** Re-arm game-over/lock listeners on a freshly built engine (after restart). */
  bindEngine: (engine: Engine) => void;
}

/**
 * Start the loop. `getEngine` is a getter so the caller can swap the engine
 * (e.g. on restart) without tearing the loop down.
 */
export function startGameLoop(
  canvas: HTMLCanvasElement,
  getEngine: () => Engine,
  input: KeyboardSource,
  options: GameLoopOptions = {},
): GameLoopHandle {
  const layout = options.layout ?? DEFAULT_LAYOUT;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get 2D context from canvas");

  const cols =
    (getEngine().snapshot() as EngineSnapshot).board[0]?.length ?? 10;
  sizeCanvas(canvas, layout, cols);

  let raf = 0;
  let stopped = false;
  let gameOver = false;
  let logicFrames = 0;
  let accumulator = 0;
  let prev = performance.now();

  // Game-over and line-clear detection ride on the engine's own `falling.lock`
  // event (which carries `topout` and `lines`). Re-armed per engine on restart.
  const bindEngine = (engine: Engine): void => {
    gameOver = false;
    engine.events.on("falling.lock", (res) => {
      options.onLock?.(res.lines);
      if (res.topout && !gameOver) {
        gameOver = true;
        options.onGameOver?.();
      }
    });
  };

  const step = (engine: Engine): void => {
    // Drain input accumulated since the last logic frame into this frame's
    // events. All transitions land on the current engine frame; subframe order
    // preserves press/release ordering within the frame.
    const events = transitionsToEvents(input.drain(), engine.frame);
    engine.tick(events as Parameters<Engine["tick"]>[0]);
    logicFrames++;
  };

  const frame = (now: number): void => {
    if (stopped) return;
    const engine = getEngine();

    let delta = now - prev;
    prev = now;
    if (delta > 250) delta = MS_PER_TICK; // tab was backgrounded; don't fast-forward

    // In review mode, render the provided snapshot and pause live simulation.
    const review = options.reviewSnapshot?.() ?? null;
    if (review) {
      accumulator = 0; // don't accrue a backlog while paused
      render(ctx, review, layout);
      options.onRender?.(logicFrames);
      raf = requestAnimationFrame(frame);
      return;
    }

    accumulator += delta;

    let ticks = 0;
    while (accumulator >= MS_PER_TICK && ticks < MAX_TICKS_PER_FRAME) {
      if (!gameOver) step(engine);
      accumulator -= MS_PER_TICK;
      ticks++;
    }
    // If we hit the cap, drop the backlog rather than spiral.
    if (ticks >= MAX_TICKS_PER_FRAME) accumulator = 0;

    render(
      ctx,
      engine.snapshot() as EngineSnapshot,
      layout,
      options.overlay?.(),
    );
    options.onRender?.(logicFrames);
    raf = requestAnimationFrame(frame);
  };

  bindEngine(getEngine());
  raf = requestAnimationFrame(frame);

  return {
    stop: () => {
      stopped = true;
      cancelAnimationFrame(raf);
    },
    frames: () => logicFrames,
    bindEngine,
  };
}
