// Pro reconstruction: drive a pro Engine through a replay's events and record
// an ordered placement track.
//
// The engine is ticked frame-by-frame from 0..frames. Events are grouped by
// their integer frame and, within a frame, applied in ascending subframe order
// (the engine's tick consumes the exact .ttr event shape). After each piece
// locks we record a placement snapshot so the reconstruction can be scrubbed.

import type { Engine, EngineSnapshot } from "../engine/adapter";
import { buildProEngine } from "./proEngine";
import type { ParsedReplay } from "./parse";

export interface Placement {
  /** 0-based index of this placement in the game. */
  pieceIndex: number;
  /** The locked mino (lowercase symbol, e.g. "t"). */
  piece: string;
  /** Engine frame at which the piece locked. */
  frame: number;
  /** Locked piece position/orientation (floored board coords). */
  x: number;
  y: number;
  rot: number;
  /** Whether the placed piece came out of hold. */
  wasHold: boolean;
  /** Spin type of the placement ("none" | "mini" | "normal"). */
  spin: string;
  /** Lines cleared by this placement. */
  clears: number;
  /** Full engine snapshot immediately after the lock (for scrubbing/seeding). */
  snapshot: EngineSnapshot;
}

/** One tanked garbage chunk: contiguous rows sharing a hole column. */
export interface GarbageChunk {
  /** Hole column (0-indexed). */
  column: number;
  /** Rows in this chunk. */
  amount: number;
  /** Hole width. */
  size: number;
  /** The originating interaction id (chunk grouping). */
  id: number;
}

/**
 * Garbage rows at the moment they entered the pro's *board* (tank time, not
 * queue time), with their exact hole columns — so the learner can replicate
 * the identical rows at the identical piece boundary.
 */
export interface GarbageEvent {
  /**
   * Absolute index of the first pro piece placed with these rows already on
   * the board (the tank happened during the previous piece's lock).
   */
  beforePiece: number;
  /** Total garbage lines tanked. */
  amount: number;
  /** The tanked chunks in insertion order. */
  rows: GarbageChunk[];
}

export interface ReconstructionResult {
  /** Ordered placements, one per locked piece. */
  track: Placement[];
  /** Final piece count. */
  pieces: number;
  /** Final line-clear count. */
  lines: number;
  /** Final engine frame reached. */
  frame: number;
  /**
   * Garbage rows the pro's board gained during the run, keyed by the piece
   * boundary at which they entered the board — used to insert identical rows
   * on the learner board at the same boundary.
   */
  garbage: GarbageEvent[];
  /** The engine after reconstruction (final state). */
  engine: Engine;
}

/** A single .ttr event (keydown/keyup/ige/start/end). */
type RawEvent = { frame?: number; type?: string; data?: { subframe?: number } };

/** Group events by integer frame, preserving array order within a frame. */
export function groupEventsByFrame(
  events: readonly unknown[],
): Map<number, RawEvent[]> {
  const byFrame = new Map<number, RawEvent[]>();
  for (const raw of events) {
    const ev = raw as RawEvent;
    const f = Math.floor(ev.frame ?? 0);
    const bucket = byFrame.get(f);
    if (bucket) bucket.push(ev);
    else byFrame.set(f, [ev]);
  }
  return byFrame;
}

/** Sort a frame's events by ascending subframe (stable for equal subframes). */
function sortBySubframe(events: RawEvent[]): RawEvent[] {
  return events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      const sa = a.e.data?.subframe ?? 0;
      const sb = b.e.data?.subframe ?? 0;
      return sa - sb || a.i - b.i;
    })
    .map(({ e }) => e);
}

/**
 * Reconstruct a supported replay into a placement track. Caller must have
 * verified support (see checkReconstructionSupport) before calling.
 */
export function reconstructReplay(replay: ParsedReplay): ReconstructionResult {
  const engine = buildProEngine(replay);
  const byFrame = groupEventsByFrame(replay.events);

  const track: Placement[] = [];

  // `falling.new` fires for the *next* piece before the current piece's
  // `falling.lock`, so we must snapshot hold-ness (and the piece's position) at
  // `falling.lock.pre`, while the locking piece is still the active one.
  let currentWasHold = false;
  let pending: {
    piece: string;
    x: number;
    y: number;
    rot: number;
    wasHold: boolean;
  } | null = null;

  engine.events.on("falling.new", (e) => {
    currentWasHold = e.isHold;
  });

  engine.events.on("falling.lock.pre", () => {
    const f = engine.falling;
    pending = {
      piece: String(f.symbol),
      x: Math.floor(f.location[0]),
      y: Math.floor(f.location[1]),
      rot: f.rotation,
      wasHold: currentWasHold,
    };
  });

  // Garbage recorded at TANK time (when rows actually entered the board), with
  // per-chunk hole columns from the lock result. Queue-time ("garbage.receive")
  // is the wrong key: the queue charges on a frame clock, so a learner playing
  // at a different speed would tank at a different piece and every placement
  // above the garbage would be vertically offset from the pro's.
  const garbage: GarbageEvent[] = [];

  engine.events.on("falling.lock", (res) => {
    const snapshot = engine.snapshot() as EngineSnapshot;
    const pieceIndex = track.length;
    track.push({
      pieceIndex,
      piece: pending?.piece ?? String(res.mino),
      frame: engine.frame,
      x: pending?.x ?? 0,
      y: pending?.y ?? 0,
      rot: pending?.rot ?? 0,
      wasHold: pending?.wasHold ?? false,
      spin: res.spin,
      clears: res.lines,
      snapshot,
    });
    pending = null;
    // Rows tanked during this lock sit under every subsequent piece: the first
    // piece placed on top of them is the next one.
    if (res.garbageAdded && res.garbageAdded.length > 0) {
      garbage.push({
        beforePiece: pieceIndex + 1,
        amount: res.garbageAdded.reduce((n, g) => n + g.amount, 0),
        rows: res.garbageAdded.map(({ column, amount, size, id }) => ({
          column,
          amount,
          size,
          id,
        })),
      });
    }
  });

  const lastFrame = Math.max(replay.frames, 0);
  for (let f = 0; f <= lastFrame; f++) {
    const events = byFrame.get(f);
    const ordered = events ? sortBySubframe(events) : [];
    engine.tick(ordered as Parameters<Engine["tick"]>[0]);
  }

  const final = engine.snapshot();
  return {
    track,
    pieces: final.stats.pieces,
    lines: final.stats.lines,
    frame: engine.frame,
    garbage,
    engine,
  };
}
