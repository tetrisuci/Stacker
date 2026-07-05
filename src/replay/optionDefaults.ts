// A complete default 40L-style 7-bag ReadyOptions block.
//
// Real TETR.IO .ttr files store `options` as a *partial diff* over a named
// preset (40L, Blitz, …) — so a 40L replay's options may omit bagtype,
// boardwidth, kickset, gravity, garbage config, etc. To reconstruct the game we
// merge the replay's partial options over these standard defaults, giving
// createEngine a complete, valid configuration.
//
// These values mirror TETR.IO's standard 7-bag singleplayer defaults closely
// enough for faithful 40L/Blitz reconstruction (the modes this app targets).

import type { Game as GameTypes } from "@haelp/teto/types";

export const DEFAULT_READY_OPTIONS: GameTypes.ReadyOptions = {
  version: 1,
  seed: 0,
  seed_random: false,
  are: 0,
  lineclear_are: 0,
  g: 0.02,
  gincrease: 0,
  gmargin: 0,
  hasgarbage: false,
  usebombs: false,
  garbagespeed: 20,
  garbagemultiplier: 1,
  garbagemargin: 0,
  garbageincrease: 0,
  garbageholesize: 1,
  garbagephase: 0,
  garbagequeue: true,
  garbageentry: "instant",
  garbageare: 0,
  garbagecap: 8,
  garbagecapincrease: 0,
  garbagecapmargin: 0,
  garbagecapmax: 40,
  garbageabsolutecap: 0,
  garbagetargetbonus: "none",
  garbageblocking: "combo blocking",
  garbagespecialbonus: false,
  passthrough: "zero",
  openerphase: 0,
  roundmode: "down",
  spinbonuses: "T-spins+",
  combotable: "multiplier",
  kickset: "SRS+",
  bagtype: "7-bag",
  messiness_change: 1,
  messiness_inner: 0,
  messiness_nosame: false,
  messiness_timeout: 0,
  b2bchaining: true,
  b2bcharging: false,
  b2bextras: false,
  b2bcharge_at: 0,
  b2bcharge_base: 0,
  allclears: false,
  allclear_garbage: 0,
  allclear_b2b: 0,
  allclear_b2b_sends: false,
  allclear_b2b_dupes: false,
  allclear_charges: false,
  allow_harddrop: true,
  allow180: true,
  infinite_hold: false,
  infinite_movement: false,
  nextcount: 5,
  clutch: false,
  nolockout: false,
  manual_allowed: false,
  new_payback: false,
  can_undo: false,
  can_retry: false,
  display_hold: true,
  boardwidth: 10,
  boardheight: 20,
  stock: 0,
  locktime: 30,
  lockresets: 15,
  prestart: 0,
  precountdown: 0,
  countdown: true,
  countdown_count: 3,
  countdown_interval: 1000,
  mission: "",
  mission_type: "",
  objective_type: "",
  zoominto: "",
  noextrawidth: false,
  stride: false,
  handling: {
    arr: 0,
    das: 6,
    dcd: 0,
    sdf: 41,
    safelock: true,
    cancel: false,
    may20g: false,
    irs: "tap",
    ihs: "tap",
  },
} as unknown as GameTypes.ReadyOptions;

/**
 * Merge a replay's partial options over the standard defaults, producing a
 * complete ReadyOptions. The replay's handling (if present) fully replaces the
 * default handling; other fields are shallow-merged.
 */
export function withDefaults(
  partial: Partial<GameTypes.ReadyOptions>,
): GameTypes.ReadyOptions {
  const handling = {
    ...DEFAULT_READY_OPTIONS.handling,
    ...(partial.handling ?? {}),
  };
  return { ...DEFAULT_READY_OPTIONS, ...partial, handling };
}
