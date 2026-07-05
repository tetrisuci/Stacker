// Incoming-garbage indicator: a pure function of a snapshot (+ telegraph config)
// producing the segments to draw for TETR.IO's incoming-garbage bar.
//
// Each queued garbage entry has a `frame` it was received, an `amount` of lines,
// a hole `size`, and a `confirmed` flag (whether it is past the cancel window).
// TETR.IO telegraphs garbage: it "charges" over `speed` frames before it can be
// dumped. We surface, per segment, the charge progress [0,1] so the renderer can
// draw a charging (partial/warning) vs. charged (solid) portion, bottom-up.

import type { EngineSnapshot } from "../engine/adapter";

/** Telegraph configuration (from the engine's garbage options). */
export interface GarbageConfig {
  /** Frames a garbage line takes to fully charge/telegraph. */
  speed: number;
}

export const DEFAULT_GARBAGE_CONFIG: GarbageConfig = { speed: 20 };

/** One drawable garbage segment, newest-received last. */
export interface GarbageSegment {
  /** Number of garbage lines in this segment. */
  amount: number;
  /** Hole width for these lines. */
  size: number;
  /** Charge progress in [0, 1]: 0 just received, 1 fully telegraphed. */
  charge: number;
  /** Whether this garbage is confirmed (locked in, past the cancel window). */
  confirmed: boolean;
}

export interface GarbageIndicator {
  /** Total incoming garbage lines. */
  total: number;
  /** Per-entry segments, in queue order (oldest first). */
  segments: GarbageSegment[];
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Compute the incoming-garbage indicator for a snapshot. Pure: depends only on
 * the snapshot's garbage queue + current frame and the telegraph `speed`.
 */
export function garbageIndicator(
  snapshot: EngineSnapshot,
  config: GarbageConfig = DEFAULT_GARBAGE_CONFIG,
): GarbageIndicator {
  const queue = snapshot.garbage?.queue ?? [];
  const now = snapshot.frame ?? 0;
  const speed = config.speed > 0 ? config.speed : 1;

  const segments: GarbageSegment[] = [];
  let total = 0;
  for (const g of queue) {
    const amount = g.amount ?? 0;
    if (amount <= 0) continue;
    const age = now - (g.frame ?? now);
    segments.push({
      amount,
      size: g.size ?? 1,
      charge: clamp01(age / speed),
      confirmed: Boolean(g.confirmed),
    });
    total += amount;
  }
  return { total, segments };
}
