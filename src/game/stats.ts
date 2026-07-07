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
  /** Gameplay keys pressed. */
  keys: number;
  /** Keys per piece. */
  kpp: number;
}

/**
 * Compute live stats from a snapshot. Rates are 0 until at least one frame has
 * elapsed (avoids a divide-by-zero spike on the first frame).
 *
 * `keys` comes from the KeyboardSource's press counter, not the snapshot —
 * the engine only ever sees buffered transitions, never raw press counts —
 * so the caller passes it in alongside the snapshot.
 *
 * `piecesOverride` replaces the snapshot's piece count (PPS and KPP derive
 * from it too). The engine's own `stats.pieces` drifts across undo/redo
 * snapshot restores, so during a session the session-owned placement counter
 * is the authoritative count.
 */
export function computeStats(
  snapshot: EngineSnapshot,
  keys = 0,
  piecesOverride?: number,
): GameStats {
  const pieces = piecesOverride ?? snapshot.stats.pieces ?? 0;
  // "Attack" = garbage generated this game. In solo play `sent` stays 0 (no
  // opponent to confirm), so use the attack the engine credited on clears.
  const attack = snapshot.stats.garbage?.attack ?? 0;

  const elapsedFrames = snapshot.frame ?? 0;
  const seconds = elapsedFrames / FPS;

  const pps = seconds > 0 ? pieces / seconds : 0;
  const apm = seconds > 0 ? (attack / seconds) * 60 : 0;
  const kpp = pieces > 0 ? keys / pieces : 0;

  return { pieces, pps, attack, apm, keys, kpp };
}
