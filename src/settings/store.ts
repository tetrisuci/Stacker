// Settings store: the single source of truth for handling + keymap.
//
// Framework-agnostic observable (subscribe / getSnapshot) so React can consume
// it via useSyncExternalStore while non-React code (the input bridge, the
// engine) reads it directly. Persists to localStorage and reloads on startup.
// Handling and keymap are stored as two independent slices.

import {
  DEFAULT_SETTINGS,
  GRAVITY_PRESET_G,
  GRAVITY_STATIC_BOUNDS,
  HANDLING_BOUNDS,
  type GravityPreset,
  type GravitySettings,
  type HandlingSettings,
  type Keymap,
  type Settings,
} from "./defaults";
import type { ActionKey } from "../input/keymap";

// v5: added the toggle-ghosts default binding (G). Bumping the key so users get
// the new binding instead of an older keymap that lacks it.
const STORAGE_KEY = "stacker.settings.v5";

type Listener = () => void;

/** Minimal storage interface so the store is testable without a real DOM. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function clampHandling(h: HandlingSettings): HandlingSettings {
  const clamp = (v: number, k: keyof HandlingSettings) => {
    const { min, max } = HANDLING_BOUNDS[k];
    if (!Number.isFinite(v)) return DEFAULT_SETTINGS.handling[k];
    return Math.min(max, Math.max(min, Math.round(v)));
  };
  return {
    arr: clamp(h.arr, "arr"),
    das: clamp(h.das, "das"),
    dcd: clamp(h.dcd, "dcd"),
    sdf: clamp(h.sdf, "sdf"),
  };
}

/** Parse persisted JSON into a valid Settings, falling back to defaults. */
export function parseSettings(raw: string | null): Settings {
  if (!raw) return structuredCloneSettings(DEFAULT_SETTINGS);
  try {
    const data = JSON.parse(raw) as Partial<Settings>;
    const handling = clampHandling({
      ...DEFAULT_SETTINGS.handling,
      ...(data.handling ?? {}),
    });
    // Keymap: keep only entries whose action is a known ActionKey.
    const keymap: Keymap = {};
    const validActions = new Set<ActionKey>(
      Object.values(DEFAULT_SETTINGS.keymap),
    );
    const source = data.keymap ?? DEFAULT_SETTINGS.keymap;
    for (const [code, action] of Object.entries(source)) {
      if (validActions.has(action as ActionKey)) {
        keymap[code] = action as ActionKey;
      }
    }
    // If a stored keymap somehow bound no valid keys, fall back to defaults.
    return {
      handling,
      keymap:
        Object.keys(keymap).length > 0
          ? keymap
          : { ...DEFAULT_SETTINGS.keymap },
      gravity: parseGravity(data.gravity),
    };
  } catch {
    return structuredCloneSettings(DEFAULT_SETTINGS);
  }
}

function parseGravity(g: Partial<GravitySettings> | undefined): GravitySettings {
  const validPresets = new Set<GravityPreset>([
    ...(Object.keys(GRAVITY_PRESET_G) as GravityPreset[]),
    "static",
  ]);
  const preset =
    g && validPresets.has(g.preset as GravityPreset)
      ? (g.preset as GravityPreset)
      : DEFAULT_SETTINGS.gravity.preset;
  const raw = g?.staticG;
  const staticG =
    typeof raw === "number" && Number.isFinite(raw)
      ? clampStaticG(raw)
      : DEFAULT_SETTINGS.gravity.staticG;
  return { preset, staticG };
}

function clampStaticG(v: number): number {
  const { min, max } = GRAVITY_STATIC_BOUNDS;
  return Math.min(max, Math.max(min, Math.round(v)));
}

function structuredCloneSettings(s: Settings): Settings {
  return {
    handling: { ...s.handling },
    keymap: { ...s.keymap },
    gravity: { ...s.gravity },
  };
}

export class SettingsStore {
  private state: Settings;
  private listeners = new Set<Listener>();
  private storage: StorageLike | null;

  constructor(storage: StorageLike | null = defaultStorage()) {
    this.storage = storage;
    this.state = parseSettings(this.storage?.getItem(STORAGE_KEY) ?? null);
  }

  // --- observable API (for React useSyncExternalStore) ---
  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): Settings => this.state;

  // --- reads ---
  get handling(): HandlingSettings {
    return this.state.handling;
  }
  get keymap(): Keymap {
    return this.state.keymap;
  }
  get gravity(): GravitySettings {
    return this.state.gravity;
  }

  // --- writes ---
  /** Update one handling value (clamped) and persist. */
  setHandlingValue(key: keyof HandlingSettings, value: number): void {
    const next = clampHandling({ ...this.state.handling, [key]: value });
    this.state = { ...this.state, handling: next };
    this.commit();
  }

  /** Choose a gravity preset (or "static") and persist. */
  setGravityPreset(preset: GravityPreset): void {
    this.state = {
      ...this.state,
      gravity: { ...this.state.gravity, preset },
    };
    this.commit();
  }

  /** Set the static gravity value (rows/sec, clamped) and persist. */
  setStaticGravity(value: number): void {
    this.state = {
      ...this.state,
      gravity: { ...this.state.gravity, staticG: clampStaticG(value) },
    };
    this.commit();
  }

  /**
   * Bind `code` to `action`. A code maps to exactly one action, and (to avoid
   * an unusable dead action) any *other* code previously bound to `action` is
   * removed, so rebinding moves the action to the new key.
   */
  rebind(code: string, action: ActionKey): void {
    const keymap: Keymap = {};
    for (const [c, a] of Object.entries(this.state.keymap)) {
      if (a === action) continue; // drop old binding(s) for this action
      if (c === code) continue; // will be re-added below
      keymap[c] = a;
    }
    keymap[code] = action;
    this.state = { ...this.state, keymap };
    this.commit();
  }

  /** Reset both slices to defaults and persist. */
  resetToDefaults(): void {
    this.state = structuredCloneSettings(DEFAULT_SETTINGS);
    this.commit();
  }

  private commit(): void {
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      // Ignore quota / unavailable storage; in-memory state still updates.
    }
    for (const l of this.listeners) l();
  }
}

function defaultStorage(): StorageLike | null {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    // Accessing localStorage can throw in sandboxed contexts.
  }
  return null;
}

export { STORAGE_KEY };
