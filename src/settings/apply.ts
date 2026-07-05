// Bridges the settings store to the live game: applies handling + gravity to
// the current engine and the keymap to the input source whenever settings
// change, and re-applies them to a freshly built engine (on restart).

import type { Engine } from "../engine/adapter";
import type { KeyboardSource } from "../input/keyboard";
import type { SettingsStore } from "./store";
import { gravityRowsPerFrame, toEngineHandling } from "./defaults";

export interface SettingsBridge {
  /** Apply current handling + gravity to a (possibly new) engine. */
  applyEngineSettings: (engine: Engine) => void;
  /** Stop listening. */
  dispose: () => void;
}

/** Apply the store's gravity to an engine, live (mutates the dynamic tracker). */
function applyGravity(engine: Engine, rowsPerFrame: number): void {
  const tracker = engine.dynamic?.gravity as
    | { base: number; increase: number; set: (v: number) => void }
    | undefined;
  if (!tracker) return;
  // `base` governs future ticks; `set` updates the current value immediately.
  tracker.base = rowsPerFrame;
  tracker.set(rowsPerFrame);
  // The user's gravity presets are constant rates, so kill any per-frame ramp
  // the engine options carried (e.g. a replay's `gincrease`) — otherwise the
  // tracker keeps adding it every tick and gravity creeps back in over time
  // even when set to "off".
  tracker.increase = 0;
  // Keep the initializer in sync so snapshots/clones carry the new values.
  if (engine.initializer?.gravity) {
    engine.initializer.gravity.value = rowsPerFrame;
    engine.initializer.gravity.increase = 0;
  }
}

/**
 * Wire the store to `getEngine()` and `input`. Applies immediately, then on
 * every store change. `getEngine` is a getter so we always target the current
 * engine even after restarts.
 */
export function connectSettings(
  store: SettingsStore,
  getEngine: () => Engine,
  input: KeyboardSource,
): SettingsBridge {
  const applyEngineSettings = (engine: Engine) => {
    // Mutate handling + gravity in place so changes are live mid-game.
    Object.assign(engine.handling, toEngineHandling(store.handling));
    applyGravity(engine, gravityRowsPerFrame(store.gravity));
  };

  const applyAll = () => {
    applyEngineSettings(getEngine());
    input.setKeymap(store.keymap);
  };

  applyAll(); // initial sync
  const unsubscribe = store.subscribe(applyAll);

  return {
    applyEngineSettings,
    dispose: unsubscribe,
  };
}
