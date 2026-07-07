// .ttr replay parsing + metadata extraction (pure, no DOM).
//
// A .ttr file is JSON. The shape this app targets is:
//   { replay: { frames, events, options, results }, users, gamemode, version }
// but real TETR.IO exports vary (fields nested under `data`, solo vs multi
// results, missing stats). So parsing is deliberately defensive: we pull out
// what we need with fallbacks, never throw on missing optional fields, and
// surface unknowns as warnings rather than failing.

import type { Game as GameTypes } from "@haelp/teto/types";
import { isSupportedBagType, SUPPORTED_BAG_TYPES } from "../engine/adapter";
import { withDefaults } from "./optionDefaults";

/** The TETR.IO replay format versions we've validated against. */
export const KNOWN_REPLAY_VERSIONS = [1] as const;

export interface ReplayMetadata {
  username: string;
  gamemode: string;
  /** Total frames in the replay (for duration = frames / 60). */
  frames: number;
  /** Duration in seconds (frames / 60). */
  durationSec: number;
  seed: number | null;
  bagtype: string | null;
  hasgarbage: boolean | null;
  /** Results stats, any of which may be null if absent from the file. */
  stats: {
    pps: number | null;
    apm: number | null;
    lines: number | null;
    pieces: number | null;
  };
}

/** Everything a successfully-parsed replay yields. */
export interface ParsedReplay {
  version: number | null;
  gamemode: string;
  /** The engine-config block, passed to createEngine. */
  options: GameTypes.ReadyOptions;
  /** Ordered input events (keydown/keyup/ige/start/end) driving the engine. */
  events: unknown[];
  frames: number;
  metadata: ReplayMetadata;
  /** Non-fatal issues (unknown version, missing stats, etc.). */
  warnings: string[];
}

export type ParseResult =
  | { ok: true; replay: ParsedReplay }
  | { ok: false; error: string };

/** Why a replay can be parsed but not reconstructed. */
export interface SupportCheck {
  supported: boolean;
  reason?: string;
  /**
   * Set when reconstruction is only *approximate* (e.g. Zenith): a caption to
   * show the user explaining the limitation.
   */
  partial?: string;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Dig through a couple of common nesting shapes to find the replay body. */
function findReplayBody(root: any): any | null {
  if (!root || typeof root !== "object") return null;
  // Common shapes: { replay: {...} }, { data: { replay: {...} } }, or the body
  // itself already having events/frames.
  if (root.replay && typeof root.replay === "object") return root.replay;
  if (root.data?.replay && typeof root.data.replay === "object")
    return root.data.replay;
  if (Array.isArray(root.events) || Array.isArray(root.frames)) return root;
  return null;
}

/** Pull the username from `users` (array or single) or a top-level field. */
function extractUsername(root: any): string {
  const users = root?.users ?? root?.data?.users;
  if (Array.isArray(users) && users.length > 0) {
    const u = users[0];
    return str(u?.username) ?? str(u?.name) ?? str(u) ?? "unknown";
  }
  if (users && typeof users === "object") {
    return str(users.username) ?? "unknown";
  }
  return str(root?.username) ?? "unknown";
}

/** Extract pps/apm/lines/pieces from whichever results/stats layout is present. */
function extractStats(replay: any): ReplayMetadata["stats"] {
  // Try a series of likely locations; first hit wins per field.
  const candidates: any[] = [
    replay?.results,
    replay?.results?.stats,
    replay?.results?.aggregatestats,
    replay?.stats,
    Array.isArray(replay?.results?.rounds)
      ? replay.results.rounds.flat?.().find?.((r: any) => r?.stats)?.stats
      : undefined,
  ].filter(Boolean);

  const pick = (keys: string[]): number | null => {
    for (const c of candidates) {
      for (const k of keys) {
        const v = num(c?.[k]);
        if (v !== null) return v;
      }
    }
    return null;
  };

  return {
    pps: pick(["pps"]),
    apm: pick(["apm"]),
    lines: pick(["lines", "linesclear", "linescleared"]),
    pieces: pick(["piecesplaced", "pieces"]),
  };
}

/**
 * Contextual inputs for {@link buildParsedReplay} — the raw options/events plus
 * the surrounding replay metadata, however the container (`.ttr` file, or one
 * player of one `.ttrm` round) chose to source them.
 */
export interface ReplayBuildInput {
  /** The player's raw (possibly partial) options block. */
  rawOptions: Partial<GameTypes.ReadyOptions>;
  /** The player's ordered event stream (keydown/keyup/ige/start/end). */
  events: unknown[];
  /** Display name for this run. */
  username: string;
  /** Game mode ("40l", "league", …). */
  gamemode: string;
  /** Replay-format version, or null if absent. */
  version: number | null;
  /** Explicit frame count, or null to infer from the last event. */
  frames: number | null;
  /**
   * Source for stats extraction (results/stats block). Defaults to searching
   * within a `.ttr` replay body; `.ttrm` passes the player's replay object.
   */
  statsSource?: any;
}

/**
 * Build a {@link ParsedReplay} from an already-located options block + event
 * stream. Shared by the `.ttr` parser and the `.ttrm` per-player extractor so
 * both go through the identical defaults merge, Zenith substitution, frame
 * inference, and metadata assembly.
 */
export function buildParsedReplay(input: ReplayBuildInput): ParsedReplay {
  const { rawOptions, events, username, gamemode, version } = input;

  // Real replay options are a partial diff over a mode preset (bagtype, board,
  // kickset, gravity, garbage config may be omitted). Merge over standard 7-bag
  // defaults so the engine gets a complete, valid configuration. Fields the
  // replay set explicitly (e.g. Zenith's bagtype) survive the merge.
  const options = withDefaults(rawOptions);

  const warnings: string[] = [];

  if (version === null) {
    warnings.push("Replay has no version field; proceeding with caution.");
  } else if (!KNOWN_REPLAY_VERSIONS.includes(version as 1)) {
    warnings.push(
      `Unknown replay version ${version} (known: ${KNOWN_REPLAY_VERSIONS.join(", ")}). ` +
        `Fields may be interpreted incorrectly.`,
    );
  }

  // Frame count: prefer explicit `frames`, else the last event's frame.
  let frames = input.frames;
  if (frames === null && events.length > 0) {
    const last = events[events.length - 1] as any;
    frames = num(last?.frame) ?? events.length;
    warnings.push("No explicit frame count; inferred from last event.");
  }
  frames ??= 0;

  // Effective bag type after merging in defaults. If the replay didn't specify
  // one, note that we assumed the default.
  const bagtype = str(options.bagtype);
  if (str((rawOptions as any).bagtype) === null) {
    warnings.push(
      `Replay options omit bagtype; assuming "${bagtype}" from mode defaults.`,
    );
  }

  const metadata: ReplayMetadata = {
    username,
    gamemode,
    frames,
    durationSec: frames / 60,
    seed: num(options.seed),
    bagtype,
    hasgarbage:
      typeof options.hasgarbage === "boolean" ? options.hasgarbage : null,
    stats: extractStats(input.statsSource ?? {}),
  };

  // Partial Zenith support: the engine has no "zenith" bag RNG, but Zenith's
  // queue matches a plain 7-bag for the early game. Substitute 7-bag in the
  // engine options so reconstruction (and the learner engine) can run at all;
  // `metadata.bagtype` keeps the true value for display, and the reconstruction
  // is capped where it drifts (see replay/zenith.ts).
  if (bagtype === "zenith") {
    options.bagtype = "7-bag";
  }

  return {
    version,
    gamemode,
    options: options as GameTypes.ReadyOptions,
    events,
    frames,
    metadata,
    warnings,
  };
}

/**
 * Parse raw JSON text of a `.ttr` replay into a ParsedReplay, or an error.
 */
export function parseReplay(text: string): ParseResult {
  let root: any;
  try {
    root = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `Not valid JSON: ${(e as Error).message}` };
  }

  const replay = findReplayBody(root);
  if (!replay) {
    return {
      ok: false,
      error:
        "Unrecognized .ttr structure: no replay body with events/options found.",
    };
  }

  const rawOptions = replay.options ?? replay.data?.options;
  if (!rawOptions || typeof rawOptions !== "object") {
    return { ok: false, error: "Replay is missing its options block." };
  }

  const events = Array.isArray(replay.events)
    ? replay.events
    : Array.isArray(replay.frames)
      ? replay.frames
      : [];

  return {
    ok: true,
    replay: buildParsedReplay({
      rawOptions: rawOptions as Partial<GameTypes.ReadyOptions>,
      events,
      username: extractUsername(root),
      gamemode: str(root.gamemode) ?? str(root.data?.gamemode) ?? "unknown",
      version: num(root.version) ?? num(root.data?.version),
      frames: num(replay.frames),
      statsSource: replay,
    }),
  };
}

/**
 * Decide whether a parsed replay can be reconstructed by the engine. Blocks
 * unsupported bag types (e.g. Zenith) and mode-specific board/garbage configs.
 */
export function checkReconstructionSupport(replay: ParsedReplay): SupportCheck {
  const bag = replay.metadata.bagtype;
  const mode = replay.gamemode.toLowerCase();

  // Zenith's custom bag RNG is unimplemented (the parser substitutes 7-bag,
  // which matches Zenith's queue for the early game), so reconstruction works
  // but only approximately: it is capped where the queue drifts.
  if (mode === "zenith" || bag === "zenith") {
    return {
      supported: true,
      partial:
        "Zenith replay: the Zenith piece bag isn't implemented, so this run is " +
        "reconstructed with a standard 7-bag — accurate for the early game only.",
    };
  }

  if (bag === null || !isSupportedBagType(bag)) {
    return {
      supported: false,
      reason:
        `Reconstruction not supported for this mode yet: bag type ` +
        `"${bag ?? "unknown"}" is not one of the engine's supported types ` +
        `(${SUPPORTED_BAG_TYPES.join(", ")}).`,
    };
  }

  // Board must be standard-ish; Zenith and some modes use non-standard sizes.
  const w = num(replay.options.boardwidth);
  const h = num(replay.options.boardheight);
  if (w !== null && w !== 10) {
    return {
      supported: false,
      reason: `Reconstruction not supported for this mode yet: non-standard board width ${w} (expected 10).`,
    };
  }
  if (h !== null && h !== 20) {
    return {
      supported: false,
      reason: `Reconstruction not supported for this mode yet: non-standard board height ${h} (expected 20).`,
    };
  }

  return { supported: true };
}
