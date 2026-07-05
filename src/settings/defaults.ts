// Default settings and their types.
//
// Two independent groups, kept deliberately separate (per the design):
//   • handling — the engine's ARR/DAS/DCD/SDF feel (plus the fixed flags)
//   • keymap   — raw KeyboardEvent.code → logical engine action
//
// Only the four tunable handling values (arr, das, dcd, sdf) are exposed in the
// UI; the remaining Handling flags are held at sane fixed defaults so we always
// hand the engine a complete, valid Handling object.
//
// UNITS: the engine expects ARR/DAS/DCD in *frames* (60 Hz), but the UI — like
// TETR.IO itself — expresses them in *milliseconds*. So HandlingSettings stores
// milliseconds for arr/das/dcd, and `toEngineHandling` converts ms → frames.
// SDF is a unitless soft-drop multiplier (41 = instant) and is NOT a time, so
// it passes through unchanged.

import type { Game as GameTypes } from "@haelp/teto/types";
import { DEFAULT_KEYMAP, type ActionKey } from "../input/keymap";

/** Milliseconds per logic frame at 60 Hz. */
export const MS_PER_FRAME = 1000 / 60;

/** Convert a millisecond handling value to engine frames (rounded). */
export const msToFrames = (ms: number): number => Math.round(ms / MS_PER_FRAME);

/** Convert engine frames to milliseconds (rounded), for display/migration. */
export const framesToMs = (frames: number): number =>
  Math.round(frames * MS_PER_FRAME);

/** The user-tunable subset of the engine's handling. */
export interface HandlingSettings {
  /** Auto-Repeat Rate in milliseconds between repeats after DAS (0 = instant). */
  arr: number;
  /** Delayed Auto Shift in milliseconds before a held direction repeats. */
  das: number;
  /** DAS Cut Delay in milliseconds that DAS is paused after another input. */
  dcd: number;
  /** Soft-Drop Factor: unitless soft-drop speed multiplier (41 ≈ instant). */
  sdf: number;
}

/** A raw-code → action binding table (gameplay engine keys + app actions). */
export type Keymap = Record<string, ActionKey>;

/** Named gravity presets (plus "static" for a user-chosen value). */
export type GravityPreset =
  | "off"
  | "relaxed"
  | "engaging"
  | "spicy"
  | "static";

/**
 * Gravity config: a preset, plus the value used when the preset is "static".
 * `staticG` is in *rows per second* (G) — the same unit TETR.IO shows — and is
 * converted to the engine's rows-per-frame at apply time.
 */
export interface GravitySettings {
  preset: GravityPreset;
  /** Rows per second, used only when preset === "static". */
  staticG: number;
}

/** Preset → gravity in rows per second (G). "static" uses `staticG` instead. */
export const GRAVITY_PRESET_G: Record<
  Exclude<GravityPreset, "static">,
  number
> = {
  off: 0,
  relaxed: 1.2, // ≈ 0.02 rows/frame — the classic slow default
  engaging: 6,
  spicy: 30,
};

export const GRAVITY_STATIC_BOUNDS = { min: 0, max: 60, step: 1 };

export const DEFAULT_GRAVITY: GravitySettings = {
  preset: "relaxed",
  staticG: 20,
};

export interface Settings {
  handling: HandlingSettings;
  keymap: Keymap;
  gravity: GravitySettings;
}

/** TETR.IO-ish defaults (arr/das/dcd in ms, sdf a multiplier). */
export const DEFAULT_HANDLING: HandlingSettings = {
  arr: 0, // ms
  das: 100, // ms (≈ 6 frames)
  dcd: 0, // ms
  sdf: 41, // multiplier
};

export const DEFAULT_SETTINGS: Settings = {
  handling: { ...DEFAULT_HANDLING },
  keymap: { ...DEFAULT_KEYMAP },
  gravity: { ...DEFAULT_GRAVITY },
};

/** Rows per frame (engine unit) for the current gravity settings. */
export function gravityRowsPerFrame(g: GravitySettings): number {
  const rowsPerSecond =
    g.preset === "static"
      ? g.staticG
      : GRAVITY_PRESET_G[g.preset];
  return rowsPerSecond / 60;
}

export const GRAVITY_PRESETS: Array<{ preset: GravityPreset; label: string }> = [
  { preset: "off", label: "Off" },
  { preset: "relaxed", label: "Relaxed" },
  { preset: "engaging", label: "Engaging" },
  { preset: "spicy", label: "Spicy" },
  { preset: "static", label: "Static" },
];

/**
 * Bounds for each handling value, used to clamp/validate user input. ARR/DAS/DCD
 * are in milliseconds; SDF is a unitless multiplier. Ranges mirror TETR.IO's
 * accepted values closely enough for local play, with a 1000/60 ms step so each
 * tick maps cleanly onto a whole engine frame.
 */
export const HANDLING_BOUNDS: Record<
  keyof HandlingSettings,
  { min: number; max: number; step: number }
> = {
  arr: { min: 0, max: 200, step: 1 },
  das: { min: 0, max: 500, step: 1 },
  dcd: { min: 0, max: 500, step: 1 },
  sdf: { min: 1, max: 41, step: 1 },
};

/** The fixed (non-UI) handling flags merged in when building a full Handling. */
export const FIXED_HANDLING_FLAGS: Omit<
  GameTypes.Handling,
  "arr" | "das" | "dcd" | "sdf"
> = {
  safelock: true,
  cancel: false,
  may20g: false,
  irs: "tap",
  ihs: "tap",
};

/**
 * Compose a complete engine Handling from the tunable values + fixed flags.
 * ARR/DAS/DCD are converted from the UI's milliseconds to engine frames; SDF is
 * a multiplier and passes through unchanged.
 */
export function toEngineHandling(h: HandlingSettings): GameTypes.Handling {
  return {
    ...FIXED_HANDLING_FLAGS,
    arr: msToFrames(h.arr),
    das: msToFrames(h.das),
    dcd: msToFrames(h.dcd),
    sdf: h.sdf,
  };
}

/** The logical actions shown in the rebinding UI, in display order. */
export const REBINDABLE_ACTIONS: ActionKey[] = [
  "moveLeft",
  "moveRight",
  "softDrop",
  "hardDrop",
  "rotateCW",
  "rotateCCW",
  "rotate180",
  "hold",
  "restart",
  "undo",
  "redo",
  "toggleGhosts",
];

export const ACTION_LABELS: Record<ActionKey, string> = {
  moveLeft: "Move Left",
  moveRight: "Move Right",
  softDrop: "Soft Drop",
  hardDrop: "Hard Drop",
  rotateCW: "Rotate CW",
  rotateCCW: "Rotate CCW",
  rotate180: "Rotate 180",
  hold: "Hold",
  restart: "Restart",
  undo: "Undo",
  redo: "Redo",
  toggleGhosts: "Toggle Ghosts",
};
