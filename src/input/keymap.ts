// Raw keyboard → logical engine action mapping.
//
// The engine's logical actions are the library's `Game.Key` names. This is a
// temporary default keymap (rebinding UI comes in a later phase). Keys are
// matched on `KeyboardEvent.code` so the layout is physical-position based and
// independent of keyboard locale.

import type { Game as GameTypes } from "@haelp/teto/types";

/** The subset of engine keys the player can trigger via the keyboard. */
export type PlayerKey = Extract<
  GameTypes.Key,
  | "moveLeft"
  | "moveRight"
  | "softDrop"
  | "hardDrop"
  | "rotateCW"
  | "rotateCCW"
  | "rotate180"
  | "hold"
>;

/**
 * App-level actions that are bound like keys but are NOT fed to the engine's
 * input stream (they control the app, e.g. restart / undo / redo).
 */
export type AppKey = "restart" | "undo" | "redo" | "toggleGhosts";

/** Every rebindable action: gameplay engine keys plus app actions. */
export type ActionKey = PlayerKey | AppKey;

const PLAYER_KEYS: ReadonlySet<string> = new Set<PlayerKey>([
  "moveLeft",
  "moveRight",
  "softDrop",
  "hardDrop",
  "rotateCW",
  "rotateCCW",
  "rotate180",
  "hold",
]);

/** Whether an action is an engine key (fed to tick) vs. an app action. */
export const isPlayerKey = (action: ActionKey): action is PlayerKey =>
  PLAYER_KEYS.has(action);

/**
 * Default keymap. Keys are `KeyboardEvent.code`, optionally prefixed with
 * `Ctrl+` for a Ctrl/Cmd combo (see comboCode in the keyboard bridge). This lets
 * Ctrl+Z undo without clashing with plain Z (rotate CCW).
 */
export const DEFAULT_KEYMAP: Record<string, ActionKey> = {
  ArrowLeft: "moveLeft",
  ArrowRight: "moveRight",
  ArrowDown: "softDrop",
  Space: "hardDrop",
  ArrowUp: "rotateCW",
  KeyX: "rotateCW",
  KeyZ: "rotateCCW",
  ControlLeft: "rotateCCW",
  ControlRight: "rotateCCW",
  KeyA: "rotate180",
  ShiftLeft: "hold",
  KeyC: "hold",
  Enter: "restart",
  KeyR: "restart",
  "Ctrl+KeyZ": "undo",
  "Ctrl+KeyY": "redo",
  KeyG: "toggleGhosts",
};

/** Build the keymap lookup code for an event, applying a `Ctrl+` prefix. */
export function comboCode(e: {
  code: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
}): string {
  return e.ctrlKey || e.metaKey ? `Ctrl+${e.code}` : e.code;
}
