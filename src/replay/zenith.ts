// Partial Zenith support: drift detection and capping.
//
// Zenith replays are reconstructed with a standard 7-bag (the engine has no
// "zenith" bag RNG — see parse.ts), which empirically matches Zenith's real
// queue for the early game and then diverges. Once the queue is wrong, the
// reconstructed board fills with mis-stacked pieces and line clears stop
// entirely — so a long clearless run is the drift signal, and everything from
// its start onward is untrustworthy and gets cut.

import type { Placement, ReconstructionResult } from "./reconstruct";

/**
 * A 10×20 board holds at most 50 pieces' worth of cells (200 / 4) without a
 * single line clear, and real play never gets near that. A clearless run this
 * long proves the reconstruction has desynced from the real queue.
 */
export const DRIFT_CLEARLESS_RUN = 50;

/**
 * The piece index where a (7-bag) reconstruction of a Zenith replay begins to
 * drift: the start of the first run of {@link DRIFT_CLEARLESS_RUN} consecutive
 * placements without a line clear. Returns null when no drift is detected
 * (the whole track is trustworthy).
 */
export function detectDriftCap(track: readonly Placement[]): number | null {
  let runStart = -1;
  let run = 0;
  for (const p of track) {
    if (p.clears === 0) {
      if (run === 0) runStart = p.pieceIndex;
      run++;
      if (run >= DRIFT_CLEARLESS_RUN) return runStart;
    } else {
      run = 0;
    }
  }
  return null;
}

/**
 * Truncate a reconstruction to the placements before `cap`, recomputing the
 * piece/line/frame totals. The final engine is left as-is (nothing reads it
 * past the track).
 */
export function capReconstruction(
  result: ReconstructionResult,
  cap: number,
): ReconstructionResult {
  const track = result.track.slice(0, Math.max(0, cap));
  const last = track[track.length - 1];
  return {
    ...result,
    track,
    pieces: track.length,
    lines: track.reduce((sum, p) => sum + p.clears, 0),
    frame: last?.frame ?? 0,
  };
}
