// requestAnimationFrame render loop: reads the engine's snapshot() every frame
// and draws it. This module owns no game logic beyond advancing the engine's
// clock so there is visible motion to prove the pipeline works — real input
// arrives in a later phase.

import type { Engine, EngineSnapshot } from "../engine/adapter";
import { canvasSize, DEFAULT_LAYOUT, render, type RenderLayout } from "./render";

export interface RenderLoopOptions {
  layout?: RenderLayout;
  /**
   * Optional hook run once per animation frame before rendering, e.g. to
   * advance the engine. Receives the elapsed ms since the previous frame.
   */
  onFrame?: (dtMs: number) => void;
}

export interface RenderLoopHandle {
  stop: () => void;
}

/** The current engine to render — either a fixed engine or a per-frame getter. */
export type EngineSource = Engine | (() => Engine);

const resolveEngine = (source: EngineSource): Engine =>
  typeof source === "function" ? source() : source;

/** Size `canvas` to fit the board for the given layout and board width. */
export function sizeCanvas(
  canvas: HTMLCanvasElement,
  layout: RenderLayout = DEFAULT_LAYOUT,
  cols = 10,
): void {
  const { width, height } = canvasSize(layout, cols);
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

/**
 * Start a rAF loop that renders `engine.snapshot()` each frame. Returns a
 * handle with `stop()`.
 */
export function startRenderLoop(
  canvas: HTMLCanvasElement,
  engineSource: EngineSource,
  options: RenderLoopOptions = {},
): RenderLoopHandle {
  const layout = options.layout ?? DEFAULT_LAYOUT;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get 2D context from canvas");

  // Size once to the actual board width.
  const cols =
    (resolveEngine(engineSource).snapshot() as EngineSnapshot).board[0]
      ?.length ?? 10;
  sizeCanvas(canvas, layout, cols);

  let raf = 0;
  let prev = performance.now();
  let stopped = false;

  const frame = (now: number): void => {
    if (stopped) return;
    const dt = now - prev;
    prev = now;
    options.onFrame?.(dt);
    const snapshot = resolveEngine(engineSource).snapshot() as EngineSnapshot;
    render(ctx, snapshot, layout);
    raf = requestAnimationFrame(frame);
  };

  raf = requestAnimationFrame(frame);

  return {
    stop: () => {
      stopped = true;
      cancelAnimationFrame(raf);
    },
  };
}
