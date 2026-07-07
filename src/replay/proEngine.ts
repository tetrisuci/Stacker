// Build a "pro" Engine from a parsed replay via the adapter's createEngine.
//
// This only constructs the engine (config from the replay's options block); it
// does NOT tick the replay — driving events through Engine.tick() is a later
// phase. Callers must gate on checkReconstructionSupport() first.

import { createEngine, type Engine } from "../engine/adapter";
import type { ParsedReplay } from "./parse";
import type { Game as GameTypes } from "@haelp/teto/types";

const SZO = new Set(["s", "z", "o"]);

/**
 * TETR.IO's `no_szo` option: the game's FIRST piece may never be S, Z, or O
 * (an S/Z start forces an overhang and an O start wastes the flat field).
 * The engine's bag implementations don't know the option — they deal the raw
 * seeded shuffle — so when the raw first piece violates it, TETR.IO rotates
 * the offender to the BACK of the opening bag: raw `s l i j o t z` is played
 * as `l i j o t z s`. (Verified empirically: with this correction the
 * nuewink.ttr 40L run reconstructs to exactly its recorded 101 pieces and 40
 * lines; the swap-in-place and drop alternatives do not.)
 *
 * By the time an Engine is constructed the raw first piece has ALREADY been
 * shifted off the queue and spawned as the falling piece, so the correction
 * works on that shape: given the spawned `falling` symbol and the remaining
 * queue, it mutates the queue so the offender rejoins at the back of the
 * opening bag and returns the piece that should be falling instead — or null
 * when no correction is needed. Exported for unit tests.
 */
export function noSzoCorrection(
  falling: string,
  queue: string[],
): string | null {
  if (!SZO.has(falling)) return null;
  // Reassemble the opening bag, rotate forbidden leaders to its back until an
  // allowed piece leads (a real bag always has one; bail out if not).
  const bag = [falling, ...queue.splice(0, 6).map(String)];
  if (bag.every((p) => SZO.has(p))) {
    queue.unshift(...bag.slice(1));
    return null;
  }
  while (SZO.has(bag[0])) bag.push(bag.shift() as string);
  const replacement = bag.shift() as string;
  queue.unshift(...bag);
  return replacement;
}

/**
 * Construct an Engine from a supported replay. `gameid` and `players` feed
 * createEngine's multiplayer-opponent derivation; for a solo reconstruction we
 * use a single self-player so the opponent list is empty.
 *
 * `optionsOverride` shallow-merges over the replay's options — used to build the
 * learner engine with undo/redo enabled (which the replay itself may not permit).
 * The undo hooks are wired at construction from `can_undo`, so this must be set
 * up-front, not toggled afterward.
 */
export function buildProEngine(
  replay: ParsedReplay,
  optionsOverride: Partial<GameTypes.ReadyOptions> = {},
): Engine {
  const options = {
    ...replay.options,
    ...optionsOverride,
  } as GameTypes.ReadyOptions;
  const gameid = 1;
  const players: GameTypes.Ready["players"] = [
    {
      gameid,
      userid: "pro",
      options,
      alive: true,
      naturalorder: 0,
    },
  ];
  const engine = createEngine(options, gameid, players);
  // The Engine constructor spawns the raw first piece; when no_szo forbids
  // it, respawn the corrected piece via the engine's own spawn path (public
  // initiatePiece, blockout ignored — the board is empty at piece 0).
  if (options.no_szo) {
    const corrected = noSzoCorrection(
      String(engine.falling.symbol),
      engine.queue as unknown as string[],
    );
    if (corrected) {
      engine.initiatePiece(
        corrected as Parameters<Engine["initiatePiece"]>[0],
        true,
      );
    }
  }
  return engine;
}
