// Live gameplay stats derived from an engine snapshot.
//
// PPS (pieces per second) and APM (attack per minute) are rates over the time
// elapsed *in the current game*. We measure elapsed time from the engine's own
// frame counter (60 Hz), which resets when the engine is rebuilt on restart, so
// the rates naturally reset per game.

import type { EngineSnapshot } from "../engine/adapter";

export const FPS = 60;

export interface GameStats {
  /** Pieces placed. */
  pieces: number;
  /** Pieces per second. */
  pps: number;
  /** Attack sent (garbage lines). */
  attack: number;
  /** Attack per minute. */
  apm: number;
}

/**
 * Compute live stats from a snapshot. Rates are 0 until at least one frame has
 * elapsed (avoids a divide-by-zero spike on the first frame).
 */
export function computeStats(snapshot: EngineSnapshot): GameStats {
  const pieces = snapshot.stats.pieces ?? 0;
  // "Attack" = garbage generated this game. In solo play `sent` stays 0 (no
  // opponent to confirm), so use the attack the engine credited on clears.
  const attack = snapshot.stats.garbage?.attack ?? 0;

  const elapsedFrames = snapshot.frame ?? 0;
  const seconds = elapsedFrames / FPS;

  const pps = seconds > 0 ? pieces / seconds : 0;
  const apm = seconds > 0 ? (attack / seconds) * 60 : 0;

  return { pieces, pps, attack, apm };
}
