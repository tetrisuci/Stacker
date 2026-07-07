import { useEffect, useRef, useState } from "react";
import type { SettingsStore } from "./store";
import { useSettings } from "./useSettings";
import {
  ACTION_LABELS,
  GRAVITY_PRESETS,
  GRAVITY_STATIC_BOUNDS,
  HANDLING_BOUNDS,
  REBINDABLE_ACTIONS,
  type HandlingSettings,
} from "./defaults";
import { bindingsForAction, keyLabel } from "./keyLabels";
import { comboCode, type ActionKey } from "../input/keymap";

const HANDLING_FIELDS: Array<{
  key: keyof HandlingSettings;
  label: string;
  help: string;
  unit: string;
}> = [
  { key: "arr", label: "ARR", help: "Auto-repeat rate", unit: "ms" },
  { key: "das", label: "DAS", help: "Delayed auto shift", unit: "ms" },
  { key: "dcd", label: "DCD", help: "DAS cut delay", unit: "ms" },
  { key: "sdf", label: "SDF", help: "Soft-drop factor", unit: "×" },
];

export function SettingsPanel({ store }: { store: SettingsStore }) {
  const settings = useSettings(store);

  return (
    <aside className="settings">
      <div className="settings-header">
        <h2>Settings</h2>
        <button
          type="button"
          className="reset-btn"
          onClick={() => store.resetToDefaults()}
        >
          Reset to defaults
        </button>
      </div>

      <section className="settings-section">
        <h3>Handling</h3>
        {HANDLING_FIELDS.map(({ key, label, help, unit }) => {
          const bounds = HANDLING_BOUNDS[key];
          const value = settings.handling[key];
          return (
            <div className="field" key={key}>
              <label htmlFor={`handling-${key}`}>
                <span className="field-label">{label}</span>
                <span className="field-help">
                  {help} ({unit})
                </span>
              </label>
              <div className="field-control">
                <input
                  id={`handling-${key}`}
                  type="range"
                  min={bounds.min}
                  max={bounds.max}
                  step={bounds.step}
                  value={value}
                  onChange={(e) =>
                    store.setHandlingValue(key, Number(e.target.value))
                  }
                />
                <span className="field-number-wrap">
                  <input
                    type="number"
                    className="field-number"
                    min={bounds.min}
                    max={bounds.max}
                    step={bounds.step}
                    value={value}
                    onChange={(e) =>
                      store.setHandlingValue(key, Number(e.target.value))
                    }
                  />
                  <span className="field-unit">{unit}</span>
                </span>
              </div>
            </div>
          );
        })}
      </section>

      <section className="settings-section">
        <h3>Gravity</h3>
        <p className="section-help">How fast pieces fall on their own.</p>
        <div className="gravity-presets">
          {GRAVITY_PRESETS.map(({ preset, label }) => (
            <label className="gravity-option" key={preset}>
              <input
                type="radio"
                name="gravity-preset"
                checked={settings.gravity.preset === preset}
                onChange={() => store.setGravityPreset(preset)}
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
        {settings.gravity.preset === "static" && (
          <div className="field">
            <label htmlFor="gravity-static">
              <span className="field-label">Static gravity</span>
              <span className="field-help">Rows per second (G)</span>
            </label>
            <div className="field-control">
              <input
                id="gravity-static"
                type="range"
                min={GRAVITY_STATIC_BOUNDS.min}
                max={GRAVITY_STATIC_BOUNDS.max}
                step={GRAVITY_STATIC_BOUNDS.step}
                value={settings.gravity.staticG}
                onChange={(e) => store.setStaticGravity(Number(e.target.value))}
              />
              <span className="field-number-wrap">
                <input
                  type="number"
                  className="field-number"
                  min={GRAVITY_STATIC_BOUNDS.min}
                  max={GRAVITY_STATIC_BOUNDS.max}
                  step={GRAVITY_STATIC_BOUNDS.step}
                  value={settings.gravity.staticG}
                  onChange={(e) =>
                    store.setStaticGravity(Number(e.target.value))
                  }
                />
                <span className="field-unit">G</span>
              </span>
            </div>
          </div>
        )}
      </section>
    </aside>
  );
}

/**
 * Keybinding panel, split out from {@link SettingsPanel} so it can mount beside
 * the board. Owns the rebinding capture: while listening, the next key press
 * (anywhere) binds the chosen action.
 */
export function ControlsPanel({ store }: { store: SettingsStore }) {
  const settings = useSettings(store);
  const [rebinding, setRebinding] = useState<ActionKey | null>(null);

  // While rebinding, the next key press (anywhere) binds that action. We
  // capture in the capture phase and stopPropagation so gameplay input never
  // sees the rebinding keystroke.
  const rebindingRef = useRef<ActionKey | null>(null);
  rebindingRef.current = rebinding;

  useEffect(() => {
    if (!rebinding) return;
    const isModifier = (code: string) => /^(Control|Shift|Alt|Meta)/.test(code);
    let done = false;
    const finish = (code: string) => {
      if (done) return;
      done = true;
      store.rebind(code, rebinding);
      setRebinding(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "Escape") {
        done = true;
        setRebinding(null);
        return;
      }
      // A non-modifier key binds immediately (with a Ctrl+ prefix if held, so
      // Ctrl+Z becomes a combo).
      if (!isModifier(e.code)) finish(comboCode(e));
      // A modifier keydown is deferred: if it's released without another key, it
      // binds on its own (below); if a real key follows, that combo wins.
    };
    const onKeyUp = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      // Binding a lone modifier (e.g. Shift for hold): commit on its release.
      if (isModifier(e.code)) finish(e.code);
    };
    // Capture phase, and on window, so we intercept before the game loop.
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, [rebinding, store]);

  return (
    <aside className="settings controls-panel">
      <div className="settings-header">
        <h2>Controls</h2>
      </div>
      <p className="section-help">
        Click an action, then press a key to rebind. Esc cancels.
      </p>
      {REBINDABLE_ACTIONS.map((action) => {
        const binds = bindingsForAction(settings.keymap, action);
        const isActive = rebinding === action;
        return (
          <div className="field keybind" key={action}>
            <span className="field-label">{ACTION_LABELS[action]}</span>
            <button
              type="button"
              className={`bind-btn${isActive ? " listening" : ""}`}
              onClick={() => setRebinding(isActive ? null : action)}
            >
              {isActive
                ? "Press a key…"
                : binds.length > 0
                  ? binds.join(" / ")
                  : "Unbound"}
            </button>
          </div>
        );
      })}
    </aside>
  );
}

export { keyLabel };
