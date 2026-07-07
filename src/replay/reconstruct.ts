// Pro reconstruction: drive a pro Engine through a replay's events and record
// an ordered placement track.
//
// The engine is ticked frame-by-frame from 0..frames. Events are grouped by
// their integer frame and, within a frame, applied in ascending subframe order
// (the engine's tick consumes the exact .ttr event shape). After each piece
// locks we record a placement snapshot so the reconstruction can be scrubbed.

import type { Engine, EngineSnapshot } from "../engine/adapter";
import type { PlayerKey } from "../input/keymap";
import { buildProEngine } from "./proEngine";
import type { ParsedReplay } from "./parse";

/**
 * One press in the pro's finesse: the gameplay key, plus whether it was *held*
 * long enough to charge DAS (a movement slammed to the wall rather than tapped
 * one cell). `held`/`carried` are only ever true for `moveLeft`/`moveRight`;
 * other keys are always a single tap.
 */
export interface InputStep {
  key: PlayerKey;
  /**
   * True when this move actually slid the piece more than one cell — a DAS slide,
   * not a single tap. Judged from the piece's real column displacement over the
   * hold (per piece), so a brief tap or a wall-blocked long hold reads as a tap
   * however long the key was physically down. Only moves are ever held.
   */
  held: boolean;
  /**
   * True when this move was ALREADY held coming into this piece — the pro kept
   * the key down across the previous piece's hard drop, so this piece needs no
   * fresh press. It is the leading step of the piece's inputs. Implies `held`
   * (a carry that didn't slide this piece ≥1 extra cell is dropped as noise).
   */
  carried: boolean;
  /**
   * True when this move is held THROUGH this piece's hard drop into the next
   * piece — the pro did not release it after dropping, so the next piece inherits
   * the hold (a saved keystroke). Set on the *originating* piece so the learner is
   * told to keep holding *before* the drop, not after. The matching next-piece
   * step has `carried: true`. Does NOT imply `held`: the pro may tap one cell on
   * this piece and keep the key down for a DAS slide on the next.
   */
  keepHeld: boolean;
}

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
  /**
   * The pro's actual keydown sequence for this placement — every gameplay press
   * from the previous piece's lock through this piece's hard drop, in order
   * (e.g. `[{hold}, {rotateCW}, {moveLeft, held}, {hardDrop}]`). This is the
   * pro's real finesse, so the learner practises the exact inputs — including
   * whether each move was a tap or a DAS-charged slide (`held`) — rather than
   * any-old way to reach the target. Only `keydown`s become steps.
   */
  inputs: InputStep[];
  /**
   * Garbage that materialized on the board *while this piece was the active one*
   * (between the previous lock and this one) — the real `garbage.tank` events the
   * engine emitted, each giving the hole `column`, row `amount`, and `size`. In
   * multiplayer the pro receives garbage between pieces; the learner plays
   * live-forward from a seed and never replays the pro's incoming garbage, so
   * without this its board would be missing these rows — floating the target
   * ghost and breaking board comparison. The session re-inserts these exact rows
   * into the learner's board when it reaches this piece, so both boards share the
   * same garbage terrain. Empty for solo replays and pieces with no arrival.
   */
  garbage: GarbageTank[];
  /** Full engine snapshot immediately after the lock (for scrubbing/seeding). */
  snapshot: EngineSnapshot;
}

/** One garbage arrival on the board: `amount` rows with a hole at `column`. */
export interface GarbageTank {
  /** Hole column (the single empty column in each inserted garbage row). */
  column: number;
  /** Number of garbage rows inserted. */
  amount: number;
  /** Hole width (usually 1). */
  size: number;
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
  /** The engine after reconstruction (final state). */
  engine: Engine;
}

/** A single .ttr event (keydown/keyup/ige/start/end). */
type RawEvent = {
  frame?: number;
  type?: string;
  data?: { subframe?: number; key?: string };
};

/** The gameplay keys we record as finesse (everything a PlayerKey can be). */
const FINESSE_KEYS: ReadonlySet<string> = new Set<PlayerKey>([
  "moveLeft",
  "moveRight",
  "softDrop",
  "hardDrop",
  "rotateCW",
  "rotateCCW",
  "rotate180",
  "hold",
]);

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
    // A hold press swaps the falling piece WITHOUT a lock, so any move key
    // still down keeps acting — now on the swapped-in piece. Its slide
    // baseline must rebase to that piece's spawn column (this event fires at
    // spawn, before any intra-tick DAS movement): otherwise `held` compares
    // two different pieces' columns, and a genuine DAS slide on the new piece
    // reads as a tap when the press began near where the new piece walls
    // (e.g. charge DAS at the wall, press hold, release — the "hold DAS"
    // hint went missing). Any slide already achieved before the swap has
    // been folded into `held` by the per-tick sampling in the frame loop.
    if (e.isHold) {
      const x = Math.floor(engine.falling.location[0]);
      for (const step of openMoves.values()) step.xAtDown = x;
    }
  });

  // Garbage that tanks (materializes on the board) while the current piece is
  // active, accumulated between locks and flushed onto each placement so the
  // session can reproduce it on the learner board. `garbage.tank` is the engine's
  // ground-truth arrival event (real hole column + row amount); capturing it is
  // exact, unlike diffing garbage rows out of successive board snapshots.
  let currentGarbage: GarbageTank[] = [];
  engine.events.on("garbage.tank", (e) => {
    currentGarbage.push({ column: e.column, amount: e.amount, size: e.size });
  });

  // A move press is a DAS slide (vs. a single tap) iff it actually moved the
  // piece by more than one cell — the replay's real effect, not a duration guess.
  // A brief tap moves one cell; a wall-blocked long hold moves ≤1 (still a tap);
  // a DAS slide moves several. Duration alone misclassifies both (a fast DAS
  // charge under the threshold, or a long-but-blocked press over it), so we mark
  // `held` from the piece's column displacement across the hold.
  const DAS_MIN_CELLS = 2;

  // The pro's keydowns since the previous lock, flushed onto each placement as
  // its finesse. Each step carries the keydown time so its matching keyup can
  // mark a move as DAS-held. A `hold` press swaps the active piece but doesn't
  // lock, so it lands in the buffer of whichever piece is next placed — the piece
  // the pro was setting up when they held. Cleared on every flush.
  interface OpenStep extends InputStep {
    /** Absolute time (frame + subframe) of the keydown, for the keyup pairing. */
    downAt: number;
    /** Piece column (floored) at this keydown, to measure the slide distance. */
    xAtDown: number;
    /**
     * For a carried step: the index of the piece the hold began on, so once this
     * carry is confirmed genuine we can flag that originating piece's move with
     * `keepHeld` (telling the learner to keep holding *before* the drop).
     */
    carriedFrom?: number;
  }
  let currentInputs: OpenStep[] = [];
  // Move steps awaiting their keyup, keyed by move key, so the keyup can measure
  // the hold and set `held`. Only moves are tracked (only they can DAS).
  const openMoves = new Map<PlayerKey, OpenStep>();
  // Move keys physically held through the current piece's lock (no keyup yet),
  // so the NEXT piece can begin with a "keep holding" carried step instead of a
  // fresh press. Recomputed at each lock; keyed by move key.
  const heldThroughLock = new Set<PlayerKey>();

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

  engine.events.on("falling.lock", (res) => {
    const snapshot = engine.snapshot() as EngineSnapshot;
    const pieceIndex = track.length;
    // Any move still physically down at the lock (no keyup yet) carries into the
    // next piece — the pro didn't release it. Resolve its `held` now from how far
    // the piece slid on THIS piece (its final x here vs. the move's keydown x):
    // its keyup may land after this flush (or after the carry is overridden), so
    // waiting for it would miss a genuine slide that ends the piece still held.
    heldThroughLock.clear();
    const lockX = pending?.x ?? Math.floor(engine.falling.location[0]);
    for (const [key, step] of openMoves) {
      heldThroughLock.add(key);
      if (Math.abs(lockX - step.xAtDown) >= DAS_MIN_CELLS) step.held = true;
    }
    // A piece is committed by its own hard drop, but a single frame can carry
    // both that drop and the *next* piece's opening presses (later subframes),
    // and they were all accumulated before this frame's tick fired the lock. So
    // split the buffer at the first hardDrop (inclusive): everything up to it is
    // this piece's finesse; the remainder carries forward to the next piece. A
    // gravity/soft-drop lock has no hardDrop — the whole buffer is this piece's.
    const dropAt = currentInputs.findIndex((s) => s.key === "hardDrop");
    let mine = dropAt >= 0 ? currentInputs.slice(0, dropAt + 1) : currentInputs;
    const carry = dropAt >= 0 ? currentInputs.slice(dropAt + 1) : [];
    // Drop a leading carried hold that this piece then overrode with an opposite
    // move WITHOUT the carry ever sliding it: the pro released the carried key
    // and went the other way, so the carry saved nothing and would be misleading
    // finesse. But a carry that DID slide this piece (`held`, resolved above /
    // per tick) is genuine even when opposite taps follow — DAS to the wall,
    // then nudge back out is real pro finesse and must be shown.
    const lead = mine[0];
    if (lead?.carried) {
      const opp = lead.key === "moveLeft" ? "moveRight" : "moveLeft";
      const oppStep = mine.slice(1).find((s) => s.key === opp);
      if (oppStep && !lead.held) {
        // Never slid before the opposite move — the carry contributed nothing.
        // Drop it; the fresh opposite move stands on its own.
        mine = mine.slice(1);
      } else if (lead.carriedFrom != null) {
        // Genuine carry: flag the originating piece's move as `keepHeld`, so the
        // learner is told to keep holding *before* the drop (on that piece), not
        // only after (here). Set it on that piece's last matching move step.
        const from = track[lead.carriedFrom];
        if (from) {
          for (let i = from.inputs.length - 1; i >= 0; i--) {
            if (from.inputs[i].key === lead.key) {
              from.inputs[i].keepHeld = true;
              break;
            }
          }
        }
      }
    }
    // Each move step's `held` was resolved above from THIS piece's slide distance
    // (open moves) or at its keyup (released moves), so the copies are correct.
    const outputs: InputStep[] = mine.map(({ key, held, carried, keepHeld }) => ({
      key,
      held,
      carried,
      keepHeld,
    }));
    // When garbage tanks *during* this piece (multiplayer), the engine inserts it
    // at the bottom and shifts the whole board — and the just-locked piece — up by
    // that many rows, but `falling.location[1]` (captured at lock.pre) is NOT
    // updated to reflect the shift. So the recorded `y` is that many rows too low
    // relative to the post-lock board (and the learner board, which we seed with
    // the same garbage). Add the tanked row count so the target ghost lands on the
    // stack instead of buried inside it. Solo replays tank nothing → no change.
    const garbageShift = currentGarbage.reduce((n, t) => n + t.amount, 0);
    track.push({
      pieceIndex,
      piece: pending?.piece ?? String(res.mino),
      frame: engine.frame,
      x: pending?.x ?? 0,
      y: (pending?.y ?? 0) + garbageShift,
      rot: pending?.rot ?? 0,
      wasHold: pending?.wasHold ?? false,
      spin: res.spin,
      clears: res.lines,
      inputs: outputs,
      garbage: currentGarbage,
      snapshot,
    });
    pending = null;
    currentGarbage = [];
    // Seed the next piece with a "keep holding" carried step for each move key
    // still DAS-held through this lock — the pro didn't re-press it, so the next
    // piece's finesse leads with a carry rather than a fresh keydown. Re-register
    // it in openMoves (as of this lock) so a run held across three+ pieces keeps
    // carrying, and so its eventual keyup is paired against the live step. Skip a
    // direction that already has a fresh keydown queued in `carry` (a re-press).
    // `carriedFrom` remembers this piece so the receiving lock can flag it.
    currentInputs = carry;
    // By this point the next piece has already spawned (falling.new fires before
    // this lock), so its spawn column is the baseline for the carried hold's new
    // slide segment. Each carried step is a fresh segment: `held` starts false and
    // is decided by how far THIS next piece slides (resolved at its own lock/keyup
    // against this baseline) — so a hold that only nudges one cell per piece reads
    // as taps, not a DAS slide.
    const nextSpawnX = Math.floor(engine.falling.location[0]);
    for (const key of heldThroughLock) {
      const original = openMoves.get(key);
      if (!original) continue;
      if (carry.some((s) => s.key === key)) continue;
      const carriedStep: OpenStep = {
        key,
        held: false,
        carried: true,
        keepHeld: false,
        downAt: original.downAt,
        xAtDown: nextSpawnX,
        carriedFrom: pieceIndex,
      };
      currentInputs.unshift(carriedStep);
      openMoves.set(key, carriedStep);
    }
  });

  const lastFrame = Math.max(replay.frames, 0);
  for (let f = 0; f <= lastFrame; f++) {
    const events = byFrame.get(f);
    const ordered = events ? sortBySubframe(events) : [];
    // Move steps released THIS frame whose pre-tick verdict was "tap": DAS
    // may fire within the release tick itself (the keyup subframe lands after
    // the charge completes), so they get one post-tick re-check below.
    const releasedMoves: OpenStep[] = [];
    // A fresh move keydown in this batch contaminates that re-check (the
    // post-tick column would include the new press's movement).
    let moveKeydownThisFrame = false;
    const piecesBeforeTick = track.length;
    // Record this frame's gameplay key transitions (in subframe order) before
    // ticking, so a hard-drop press is in the buffer when the tick locks the
    // piece and flushes it. A move keydown opens a step; its keyup measures the
    // hold and marks `held` when it charged DAS.
    for (const ev of ordered) {
      const key = ev.data?.key;
      if (!key || !FINESSE_KEYS.has(key)) continue;
      const at = (ev.frame ?? f) + (ev.data?.subframe ?? 0);
      if (ev.type === "keydown") {
        const step: OpenStep = {
          key: key as PlayerKey,
          held: false,
          carried: false,
          keepHeld: false,
          downAt: at,
          xAtDown: Math.floor(engine.falling.location[0]),
        };
        currentInputs.push(step);
        if (key === "moveLeft" || key === "moveRight") {
          openMoves.set(key as PlayerKey, step);
          moveKeydownThisFrame = true;
        }
      } else if (ev.type === "keyup") {
        const step = openMoves.get(key as PlayerKey);
        if (step) {
          // This keyup ends the press. Whether it was a DAS slide is decided by
          // how far the piece actually moved from the keydown to here (its column
          // now) — ≥ DAS_MIN_CELLS is a slide, ≤1 is a tap however long the key
          // was down (e.g. blocked by a wall). Resolve on the open step itself;
          // for a hold that ends on its own piece this runs before the flush that
          // copies it. (A hold carried across a lock is forced held at flush.)
          const cells = Math.abs(
            Math.floor(engine.falling.location[0]) - step.xAtDown,
          );
          if (cells >= DAS_MIN_CELLS) step.held = true;
          else releasedMoves.push(step);
          openMoves.delete(key as PlayerKey);
        }
      }
    }
    engine.tick(ordered as Parameters<Engine["tick"]>[0]);
    // Resolve DAS slides as they happen, not only at keyup/lock: sample each
    // open press's displacement after every tick. A press can span a hold
    // swap (which rebases its baseline, above), so waiting for the keyup
    // would measure only the last segment.
    if (openMoves.size > 0 && engine.falling) {
      const x = Math.floor(engine.falling.location[0]);
      for (const step of openMoves.values()) {
        if (!step.held && Math.abs(x - step.xAtDown) >= DAS_MIN_CELLS) {
          step.held = true;
        }
      }
    }
    // A press released this frame can STILL be a DAS slide: with the charge
    // completing inside the release tick, the pre-tick keyup measurement saw
    // the piece before it moved (e.g. das≈5, release a subframe after the
    // slide — the "DAS to the wall, quick release" pattern). Re-check those
    // against the post-tick column — but only when nothing else could have
    // moved the piece this tick: no lock (the column would be the NEXT
    // piece's), no other move key still down, and no fresh move press in
    // this frame's batch (a fast tap-tap must not read as one long slide).
    if (
      releasedMoves.length > 0 &&
      !moveKeydownThisFrame &&
      openMoves.size === 0 &&
      track.length === piecesBeforeTick &&
      engine.falling
    ) {
      const x = Math.floor(engine.falling.location[0]);
      for (const step of releasedMoves) {
        if (!step.held && Math.abs(x - step.xAtDown) >= DAS_MIN_CELLS) {
          step.held = true;
        }
      }
    }
  }

  // Post-pass: a carried step only matters as a *DAS* keystroke-save. If the hold
  // turned out sub-DAS (`held` never set — a brief carry-over, not a wall slide),
  // it isn't real "keep holding" finesse: drop the carried step and clear the
  // matching `keepHeld` on the originating piece. The receiving piece keeps its
  // own fresh presses, which already describe the placement.
  for (let i = 0; i < track.length; i++) {
    const inputs = track[i].inputs;
    const lead = inputs[0];
    if (lead?.carried && !lead.held) {
      inputs.shift();
      const prev = track[i - 1];
      if (prev) {
        for (let j = prev.inputs.length - 1; j >= 0; j--) {
          const s = prev.inputs[j];
          if (s.key === lead.key && s.keepHeld) {
            s.keepHeld = false;
            break;
          }
        }
      }
    }
  }

  const final = engine.snapshot();
  return {
    track,
    pieces: final.stats.pieces,
    lines: final.stats.lines,
    frame: engine.frame,
    engine,
  };
}
