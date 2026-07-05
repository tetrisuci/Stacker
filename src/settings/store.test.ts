import { describe, it, expect, beforeEach } from "vitest";
import { SettingsStore, parseSettings, STORAGE_KEY, type StorageLike } from "./store";
import { DEFAULT_SETTINGS, HANDLING_BOUNDS } from "./defaults";

class MemStorage implements StorageLike {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
}

describe("parseSettings", () => {
  it("returns defaults for null/garbage", () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings("not json")).toEqual(DEFAULT_SETTINGS);
  });

  it("clamps out-of-range handling values", () => {
    const raw = JSON.stringify({
      handling: { arr: -5, das: 999, dcd: 3, sdf: 41 },
      keymap: DEFAULT_SETTINGS.keymap,
    });
    const s = parseSettings(raw);
    expect(s.handling.arr).toBe(HANDLING_BOUNDS.arr.min);
    expect(s.handling.das).toBe(HANDLING_BOUNDS.das.max);
    expect(s.handling.dcd).toBe(3);
  });

  it("drops keymap entries with unknown actions", () => {
    const raw = JSON.stringify({
      handling: DEFAULT_SETTINGS.handling,
      keymap: { KeyG: "moveLeft", KeyH: "notARealAction" },
    });
    const s = parseSettings(raw);
    expect(s.keymap.KeyG).toBe("moveLeft");
    expect(s.keymap.KeyH).toBeUndefined();
  });

  it("falls back to default keymap when none survive", () => {
    const raw = JSON.stringify({
      handling: DEFAULT_SETTINGS.handling,
      keymap: { KeyH: "bogus" },
    });
    const s = parseSettings(raw);
    expect(s.keymap).toEqual(DEFAULT_SETTINGS.keymap);
  });
});

describe("SettingsStore", () => {
  let storage: MemStorage;
  let store: SettingsStore;

  beforeEach(() => {
    storage = new MemStorage();
    store = new SettingsStore(storage);
  });

  it("loads defaults on first run", () => {
    expect(store.handling).toEqual(DEFAULT_SETTINGS.handling);
    expect(store.keymap).toEqual(DEFAULT_SETTINGS.keymap);
  });

  it("persists handling changes and reloads them", () => {
    store.setHandlingValue("das", 12);
    expect(store.handling.das).toBe(12);
    // A new store over the same storage reflects the persisted value.
    const reloaded = new SettingsStore(storage);
    expect(reloaded.handling.das).toBe(12);
  });

  it("clamps handling on write", () => {
    store.setHandlingValue("arr", 999);
    expect(store.handling.arr).toBe(HANDLING_BOUNDS.arr.max);
    store.setHandlingValue("arr", -3);
    expect(store.handling.arr).toBe(HANDLING_BOUNDS.arr.min);
  });

  it("notifies subscribers on change", () => {
    let calls = 0;
    const unsub = store.subscribe(() => calls++);
    store.setHandlingValue("sdf", 20);
    expect(calls).toBe(1);
    unsub();
    store.setHandlingValue("sdf", 21);
    expect(calls).toBe(1); // no more after unsubscribe
  });

  it("rebinds a key to an action and persists", () => {
    store.rebind("KeyN", "hardDrop");
    expect(store.keymap.KeyN).toBe("hardDrop");
    const reloaded = new SettingsStore(storage);
    expect(reloaded.keymap.KeyN).toBe("hardDrop");
  });

  it("rebinding moves an action off its previous keys", () => {
    // Default binds Space -> hardDrop. Rebind hardDrop to KeyN.
    expect(store.keymap.Space).toBe("hardDrop");
    store.rebind("KeyN", "hardDrop");
    expect(store.keymap.KeyN).toBe("hardDrop");
    expect(store.keymap.Space).toBeUndefined(); // old binding removed
  });

  it("rebinding a code overrides its previous action", () => {
    // ArrowLeft defaults to moveLeft; rebind it to hold.
    expect(store.keymap.ArrowLeft).toBe("moveLeft");
    store.rebind("ArrowLeft", "hold");
    expect(store.keymap.ArrowLeft).toBe("hold");
    // moveLeft is now unbound from ArrowLeft.
    const boundToMoveLeft = Object.entries(store.keymap).filter(
      ([, a]) => a === "moveLeft",
    );
    expect(boundToMoveLeft.some(([c]) => c === "ArrowLeft")).toBe(false);
  });

  it("has a default restart binding and can rebind it", () => {
    // Enter defaults to restart.
    expect(store.keymap.Enter).toBe("restart");
    store.rebind("F5", "restart");
    expect(store.keymap.F5).toBe("restart");
    // Rebinding moves restart off its old keys (Enter, KeyR).
    expect(store.keymap.Enter).toBeUndefined();
    expect(store.keymap.KeyR).toBeUndefined();
    // Persists.
    const reloaded = new SettingsStore(storage);
    expect(reloaded.keymap.F5).toBe("restart");
  });

  it("keeps handling and keymap independent", () => {
    store.setHandlingValue("arr", 5);
    const keymapBefore = { ...store.keymap };
    store.rebind("KeyN", "hold");
    expect(store.handling.arr).toBe(5); // handling untouched by rebind
    store.setHandlingValue("das", 9);
    expect(store.keymap.KeyN).toBe("hold"); // keymap untouched by handling
    expect(keymapBefore.ArrowLeft).toBe(store.keymap.ArrowLeft);
  });

  it("resets both slices to defaults", () => {
    store.setHandlingValue("das", 15);
    store.rebind("KeyN", "hold");
    store.resetToDefaults();
    expect(store.handling).toEqual(DEFAULT_SETTINGS.handling);
    expect(store.keymap).toEqual(DEFAULT_SETTINGS.keymap);
    // Persisted too.
    expect(JSON.parse(storage.getItem(STORAGE_KEY)!).handling).toEqual(
      DEFAULT_SETTINGS.handling,
    );
  });

  it("defaults, sets, and persists gravity", () => {
    expect(store.gravity).toEqual(DEFAULT_SETTINGS.gravity);
    store.setGravityPreset("spicy");
    expect(store.gravity.preset).toBe("spicy");
    store.setStaticGravity(30);
    expect(store.gravity.staticG).toBe(30);
    const reloaded = new SettingsStore(storage);
    expect(reloaded.gravity.preset).toBe("spicy");
    expect(reloaded.gravity.staticG).toBe(30);
  });

  it("clamps and validates gravity on load", () => {
    // Out-of-range static value and unknown preset fall back to sane values.
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        handling: DEFAULT_SETTINGS.handling,
        keymap: DEFAULT_SETTINGS.keymap,
        gravity: { preset: "bogus", staticG: 9999 },
      }),
    );
    const loaded = new SettingsStore(storage);
    expect(loaded.gravity.preset).toBe(DEFAULT_SETTINGS.gravity.preset);
    expect(loaded.gravity.staticG).toBeLessThanOrEqual(60);
  });

  it("keeps gravity independent of handling and keymap", () => {
    store.setGravityPreset("off");
    store.setHandlingValue("das", 12);
    store.rebind("KeyN", "hold");
    expect(store.gravity.preset).toBe("off"); // untouched by the others
  });

  it("reset restores gravity to defaults", () => {
    store.setGravityPreset("spicy");
    store.setStaticGravity(45);
    store.resetToDefaults();
    expect(store.gravity).toEqual(DEFAULT_SETTINGS.gravity);
  });
});
