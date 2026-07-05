// Build a "pro" Engine from a parsed replay via the adapter's createEngine.
//
// This only constructs the engine (config from the replay's options block); it
// does NOT tick the replay — driving events through Engine.tick() is a later
// phase. Callers must gate on checkReconstructionSupport() first.

import { createEngine, type Engine } from "../engine/adapter";
import type { ParsedReplay } from "./parse";
import type { Game as GameTypes } from "@haelp/teto/types";

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
  const options = { ...replay.options, ...optionsOverride };
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
  return createEngine(options, gameid, players);
}
