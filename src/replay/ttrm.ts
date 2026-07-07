// `.ttrm` (multiplayer / Tetra League) replay parsing.
//
// A `.ttrm` is a *match*: `replay.rounds` is an array of rounds, each an array of
// players. Each player carries its own `replay.events` stream (keydown / keyup /
// **ige** garbage-interaction events) and — inside its `end` event — a fully
// resolved `options` block. Reconstructing one player's board is therefore the
// same problem as a solo `.ttr`, with two differences:
//
//   1. The authoritative options live in the player's `end` event (fully
//      resolved: 170+ keys incl. `passthrough` and the garbage config), not in
//      the partial `replay.options` diff. We use those so the engine is
//      configured for real multiplayer garbage.
//   2. The event stream includes `ige` events. Reconstruction already ticks the
//      full per-frame event array (it only *filters* for finesse extraction), so
//      the engine receives garbage interactions and routes them to the correct
//      columns natively — no extra handling here.
//
// So this module's whole job is: detect a `.ttrm`, enumerate its round×player
// games, and turn a chosen one into a `ParsedReplay` the existing pipeline
// (reconstruct → session → compare) consumes unchanged.

import type { Game as GameTypes } from "@haelp/teto/types";
import { buildParsedReplay, type ParsedReplay } from "./parse";

/** One selectable game in a match: a specific player in a specific round. */
export interface TtrmGame {
  /** 0-based round index. */
  round: number;
  /** 0-based player index within the round. */
  player: number;
  /** The player's display name. */
  username: string;
}

/** A parsed `.ttrm` match: its games plus the raw root for lazy extraction. */
export interface ParsedMatch {
  /** Match-level game mode (usually "league"). */
  gamemode: string;
  /** Replay-format version, or null. */
  version: number | null;
  /** Every round×player game, in round then player order. */
  games: TtrmGame[];
  /** Number of rounds in the match. */
  rounds: number;
  /** Retained raw root so a selected game can be built on demand. */
  raw: any;
}

export type MatchParseResult =
  | { ok: true; match: ParsedMatch }
  | { ok: false; error: string };

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * Is this raw JSON a multiplayer `.ttrm` (has `replay.rounds`) rather than a
 * solo `.ttr` (has `replay.events`)? Used to route a dropped file to the right
 * parser without relying on the filename.
 */
export function isMatchReplay(root: any): boolean {
  const rounds = root?.replay?.rounds ?? root?.data?.replay?.rounds;
  return Array.isArray(rounds);
}

/** Locate the rounds array under either common nesting. */
function findRounds(root: any): any[] | null {
  const rounds = root?.replay?.rounds ?? root?.data?.replay?.rounds;
  return Array.isArray(rounds) ? rounds : null;
}

/**
 * Parse `.ttrm` JSON text into a {@link ParsedMatch} (the list of selectable
 * games), or an error. Individual games are built lazily via
 * {@link buildGameReplay} once the user picks one.
 */
export function parseMatch(text: string): MatchParseResult {
  let root: any;
  try {
    root = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `Not valid JSON: ${(e as Error).message}` };
  }

  const rounds = findRounds(root);
  if (!rounds) {
    return {
      ok: false,
      error: "Unrecognized .ttrm structure: no replay.rounds array found.",
    };
  }
  if (rounds.length === 0) {
    return { ok: false, error: "Match has no rounds." };
  }

  const games: TtrmGame[] = [];
  rounds.forEach((round: any, ri: number) => {
    if (!Array.isArray(round)) return;
    round.forEach((p: any, pi: number) => {
      games.push({
        round: ri,
        player: pi,
        username: str(p?.username) ?? str(p?.user?.username) ?? `player ${pi + 1}`,
      });
    });
  });

  if (games.length === 0) {
    return { ok: false, error: "Match rounds contain no players." };
  }

  return {
    ok: true,
    match: {
      gamemode: str(root.gamemode) ?? str(root.data?.gamemode) ?? "league",
      version: num(root.version) ?? num(root.data?.version),
      games,
      rounds: rounds.length,
      raw: root,
    },
  };
}

/**
 * Build the {@link ParsedReplay} for one game (round × player) of a match, ready
 * for the existing reconstruction pipeline. Prefers the fully-resolved options
 * block from the player's `end` event (multiplayer garbage/passthrough config);
 * falls back to the partial `replay.options` diff if no `end` event is present.
 */
export function buildGameReplay(
  match: ParsedMatch,
  round: number,
  player: number,
): { ok: true; replay: ParsedReplay } | { ok: false; error: string } {
  const rounds = findRounds(match.raw);
  const p = rounds?.[round]?.[player];
  if (!p) {
    return { ok: false, error: `No player ${player} in round ${round}.` };
  }

  const rep = p.replay ?? p.data?.replay;
  const events: unknown[] = Array.isArray(rep?.events) ? rep.events : [];
  if (events.length === 0) {
    return { ok: false, error: "This game has no replayable events." };
  }

  // The end event holds the fully resolved options (incl. passthrough + garbage
  // config). Fall back to the partial replay.options diff if it's absent.
  const endEvent = (events as any[]).find((e) => e?.type === "end");
  const rawOptions: Partial<GameTypes.ReadyOptions> =
    endEvent?.data?.options ?? rep?.options ?? {};

  const username =
    str(p.username) ?? str(match.games.find((g) => g.round === round && g.player === player)?.username) ?? "unknown";

  const replay = buildParsedReplay({
    rawOptions,
    events,
    username,
    gamemode: match.gamemode,
    version: match.version,
    frames: num(rep?.frames),
    statsSource: rep,
  });

  return { ok: true, replay };
}
