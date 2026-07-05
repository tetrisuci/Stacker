// Synthetic .ttr fixtures for tests. Modeled on the documented structure
// { replay: { frames, events, options, results }, users, gamemode, version }
// with a complete-enough ReadyOptions block for createEngine to build.

import type { Game as GameTypes } from "@haelp/teto/types";
import { withDefaults } from "./optionDefaults";

export function makeOptions(
  overrides: Partial<GameTypes.ReadyOptions> = {},
): GameTypes.ReadyOptions {
  return withDefaults({ seed: 12345, username: "promooooooo", ...overrides });
}

/** A valid 40L-style 7-bag .ttr JSON string. */
export function makeTtr(
  overrides: {
    options?: Partial<GameTypes.ReadyOptions>;
    gamemode?: string;
    version?: number;
    frames?: number;
    events?: unknown[];
    results?: unknown;
    username?: string;
  } = {},
): string {
  const options = makeOptions(overrides.options);
  const events = overrides.events ?? [
    { type: "start", data: {}, frame: 0 },
    { type: "keydown", data: { key: "hardDrop", subframe: 0 }, frame: 10 },
    { type: "end", data: {}, frame: 100 },
  ];
  return JSON.stringify({
    version: overrides.version ?? 1,
    gamemode: overrides.gamemode ?? "40l",
    users: [{ username: overrides.username ?? "promooooooo" }],
    replay: {
      frames: overrides.frames ?? 100,
      events,
      options,
      results: overrides.results ?? {
        stats: { pps: 3.78, apm: 208, lines: 40, piecesplaced: 100 },
      },
    },
  });
}

/** A Zenith replay (partially supported: reconstructed with 7-bag + capped). */
export function makeZenithTtr(): string {
  return makeTtr({
    gamemode: "zenith",
    options: { bagtype: "7-bag" },
  });
}
