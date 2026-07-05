// Thin adapter over `@haelp/teto`.
//
// The rest of the app imports the engine ONLY through this module. This gives us
// one place to swap engine versions and, critically, guarantees we never touch
// the library's Client/bot half (which talks to TETR.IO's API and carries ban
// risk). We import strictly from "@haelp/teto/engine".
//
// The library also exposes `Classes.Game.createEngine(options, gameid, players)`,
// but that lives in the `classes/game` module which statically imports `Client`.
// Pulling it in would drag the bot API (and Node-only deps) into our bundle and
// violate the import constraint. `createEngine` is, however, a *pure* mapping
// from a TETR.IO "ready options" block onto `new Engine({...})` — it reads no
// Client state. So we reproduce that exact mapping here against the engine class
// alone, preserving the same call signature the app is meant to use.

import {
  Engine,
  type EngineInitializeParams,
  type EngineSnapshot,
} from "@haelp/teto/engine";
import type { Game as GameTypes } from "@haelp/teto/types";

export { Engine };
export type { EngineInitializeParams, EngineSnapshot };

/** The set of bag types the engine's RNG actually supports. */
export const SUPPORTED_BAG_TYPES = [
  "7-bag",
  "14-bag",
  "classic",
  "pairs",
  "total mayhem",
  "7+1-bag",
  "7+2-bag",
  "7+x-bag",
] as const;
export type SupportedBagType = (typeof SUPPORTED_BAG_TYPES)[number];

export const isSupportedBagType = (t: string): t is SupportedBagType =>
  (SUPPORTED_BAG_TYPES as readonly string[]).includes(t);

/**
 * Build a configured {@link Engine} from a TETR.IO replay's `options` block,
 * mirroring the library's `Classes.Game.createEngine`. `gameid` and `players`
 * are used only to derive the multiplayer opponent list (empty for solo modes).
 *
 * This is a faithful re-implementation of the library's mapping — kept in sync
 * with `@haelp/teto`'s `Game.createEngine` — so that app code has the exact
 * helper the build plan calls for without importing the Client.
 */
export function createEngine(
  options: GameTypes.ReadyOptions,
  gameid: number,
  players: GameTypes.Ready["players"],
): Engine {
  return new Engine({
    multiplayer: {
      opponents: players.map((o) => o.gameid).filter((id) => id !== gameid),
      passthrough: options.passthrough,
    },
    board: {
      width: options.boardwidth,
      height: options.boardheight,
      buffer: 20, // there is always a buffer of 20 over the visible board
    },
    kickTable: options.kickset,
    options: {
      comboTable: options.combotable,
      garbageBlocking: options.garbageblocking,
      clutch: options.clutch,
      garbageTargetBonus: options.garbagetargetbonus,
      spinBonuses: options.spinbonuses,
      stock: options.stock,
    },
    queue: {
      minLength: 31,
      seed: options.seed,
      type: options.bagtype,
    },
    garbage: {
      cap: {
        absolute: options.garbageabsolutecap,
        increase: options.garbagecapincrease,
        max: options.garbagecapmax,
        value: options.garbagecap,
        marginTime: options.garbagecapmargin,
      },
      multiplier: {
        value: options.garbagemultiplier,
        increase: options.garbageincrease,
        marginTime: options.garbagemargin,
      },
      boardWidth: options.boardwidth,
      garbage: {
        speed: options.garbagespeed,
        holeSize: options.garbageholesize,
      },
      messiness: {
        change: options.messiness_change,
        nosame: options.messiness_nosame,
        timeout: options.messiness_timeout,
        within: options.messiness_inner,
        center: options.messiness_center ?? false,
      },
      bombs: options.usebombs,
      seed: options.seed,
      rounding: options.roundmode,
      openerPhase: options.openerphase,
      specialBonus: options.garbagespecialbonus,
    },
    pc: options.allclears
      ? { garbage: options.allclear_garbage, b2b: options.allclear_b2b }
      : false,
    b2b: {
      chaining: options.b2bchaining,
      charging: options.b2bcharging
        ? { at: options.b2bcharge_at, base: options.b2bcharge_base }
        : false,
    },
    gravity: {
      value: options.g,
      increase: options.gincrease,
      marginTime: options.gmargin,
    },
    misc: {
      movement: {
        infinite: options.infinite_movement,
        lockResets: options.lockresets,
        lockTime: options.locktime,
        may20G: options.gravitymay20g ?? false,
      },
      allowed: {
        spin180: options.allow180,
        hardDrop: options.allow_harddrop,
        hold: options.display_hold,
        undo: options.can_undo,
        retry: options.can_retry,
      },
      infiniteHold: options.infinite_hold,
      stride: options.stride,
      username: options.username,
      date: new Date(),
    },
    handling: options.handling,
  });
}

/** Options for {@link createStandardEngine}. */
export interface StandardEngineOptions {
  /** Visible board width. Default 10. */
  width?: number;
  /** Visible board height. Default 20. */
  height?: number;
  /** Deterministic RNG seed for the 7-bag queue. */
  seed: number;
  /** Bag type. Default "7-bag". */
  bagType?: SupportedBagType;
  /** Kick table. Default "SRS+". */
  kickTable?: EngineInitializeParams["kickTable"];
  /** Handling overrides merged over sensible instant-drop defaults. */
  handling?: Partial<GameTypes.Handling>;
}

const DEFAULT_HANDLING: GameTypes.Handling = {
  arr: 0,
  das: 6,
  dcd: 0,
  sdf: 41,
  safelock: true,
  cancel: false,
  may20g: false,
  irs: "tap",
  ihs: "tap",
};

/**
 * Construct a minimal, self-contained standard-rules {@link Engine} (single
 * player, no garbage pressure) with a fixed seed — enough to prove the engine
 * bundles and runs, and the base for the local stacker. Uses only engine-level
 * primitives; no replay options block required.
 */
export function createStandardEngine(opts: StandardEngineOptions): Engine {
  const width = opts.width ?? 10;
  const height = opts.height ?? 20;

  return new Engine({
    board: { width, height, buffer: 20 },
    kickTable: opts.kickTable ?? "SRS+",
    queue: { seed: opts.seed, type: opts.bagType ?? "7-bag", minLength: 31 },
    options: {
      comboTable: "multiplier",
      garbageBlocking: "combo blocking",
      clutch: true,
      garbageTargetBonus: "none",
      spinBonuses: "T-spins+",
      stock: 0,
    },
    gravity: { value: 0.02, increase: 0, marginTime: 0 },
    garbage: {
      cap: { absolute: 0, increase: 0, max: 40, value: 8, marginTime: 0 },
      multiplier: { value: 1, increase: 0, marginTime: 0 },
      boardWidth: width,
      garbage: { speed: 20, holeSize: 1 },
      messiness: { change: 1, nosame: false, timeout: 0, within: 0, center: false },
      bombs: false,
      seed: opts.seed,
      rounding: "down",
      openerPhase: 0,
      specialBonus: false,
    },
    pc: false,
    b2b: { chaining: true, charging: false },
    misc: {
      movement: { infinite: false, lockResets: 15, lockTime: 30, may20G: false },
      allowed: {
        spin180: true,
        hardDrop: true,
        hold: true,
        undo: true,
        retry: true,
      },
      infiniteHold: false,
      stride: false,
      username: "dev",
      date: new Date(),
    },
    handling: { ...DEFAULT_HANDLING, ...opts.handling },
  });
}
