import { describe, it, expect, beforeEach } from "vitest";
import { SettingsStore, type StorageLike } from "./store";
import { connectSettings } from "./apply";
import { createStandardEngine, type Engine } from "../engine/adapter";
import { KeyboardSource } from "../input/keyboard";
import {
  DEFAULT_HANDLING,
  gravityRowsPerFrame,
  msToFrames,
} from "./defaults";

class MemStorage implements StorageLike {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
}

describe("connectSettings", () => {
  let store: SettingsStore;
  let engine: Engine;
  let input: KeyboardSource;

  beforeEach(() => {
    (globalThis as any).window = {
      addEventListener() {},
      removeEventListener() {},
    };
    store = new SettingsStore(new MemStorage());
    engine = createStandardEngine({ seed: 1 });
    input = new KeyboardSource();
  });

  it("applies default handling to the engine as frames on connect", () => {
    connectSettings(store, () => engine, input);
    // Store holds ms; the engine receives frames.
    expect(engine.handling.arr).toBe(msToFrames(DEFAULT_HANDLING.arr));
    expect(engine.handling.das).toBe(msToFrames(DEFAULT_HANDLING.das));
    expect(engine.handling.sdf).toBe(DEFAULT_HANDLING.sdf); // unitless, unchanged
    // Fixed flags are present too.
    expect(engine.handling.irs).toBe("tap");
  });

  it("live-applies handling changes to the running engine (ms → frames)", () => {
    connectSettings(store, () => engine, input);
    store.setHandlingValue("das", 200); // ms
    expect(engine.handling.das).toBe(msToFrames(200)); // 12 frames
    store.setHandlingValue("arr", 100); // ms
    expect(engine.handling.arr).toBe(msToFrames(100)); // 6 frames
  });

  it("applies handling to a freshly built engine via applyEngineSettings", () => {
    const bridge = connectSettings(store, () => engine, input);
    store.setHandlingValue("das", 50); // ms
    const restarted = createStandardEngine({ seed: 2 });
    bridge.applyEngineSettings(restarted);
    expect(restarted.handling.das).toBe(msToFrames(50)); // 3 frames
  });

  it("pushes keymap changes to the input source", () => {
    connectSettings(store, () => engine, input);
    // Rebind KeyN -> hold, then feed a KeyN keydown and expect a hold action.
    store.rebind("KeyN", "hold");
    (input as any).onKeyDown({
      code: "KeyN",
      repeat: false,
      preventDefault() {},
    });
    expect(input.drain()).toEqual([{ type: "keydown", key: "hold" }]);
  });

  it("stops applying after dispose", () => {
    const bridge = connectSettings(store, () => engine, input);
    bridge.dispose();
    store.setHandlingValue("das", 25);
    expect(engine.handling.das).not.toBe(25);
  });

  it("applies gravity to the engine's dynamic tracker on connect", () => {
    connectSettings(store, () => engine, input);
    // Default gravity is the "relaxed" preset.
    const expected = gravityRowsPerFrame(store.gravity);
    expect(engine.dynamic.gravity.get()).toBeCloseTo(expected, 6);
  });

  it("live-applies a gravity preset change (off -> fast)", () => {
    connectSettings(store, () => engine, input);
    store.setGravityPreset("off");
    expect(engine.dynamic.gravity.get()).toBe(0);
    store.setGravityPreset("spicy");
    expect(engine.dynamic.gravity.get()).toBeGreaterThan(0);
  });

  it("kills an engine-option gravity ramp so 'off' stays off", () => {
    // Replays can carry a per-frame gravity ramp (e.g. Zenith's `gincrease`);
    // the tracker adds it every tick, so without zeroing it gravity creeps
    // back in even when the user set the preset to "off".
    (engine.dynamic.gravity as unknown as { increase: number }).increase = 0.5;
    connectSettings(store, () => engine, input);
    store.setGravityPreset("off");
    expect(engine.dynamic.gravity.get()).toBe(0);
    for (let i = 0; i < 600; i++) engine.tick([]);
    expect(engine.dynamic.gravity.get()).toBe(0);
  });

  it("live-applies a static gravity value (rows/sec -> rows/frame)", () => {
    connectSettings(store, () => engine, input);
    store.setGravityPreset("static");
    store.setStaticGravity(60); // 60 rows/sec = 1 row/frame at 60fps
    expect(engine.dynamic.gravity.get()).toBeCloseTo(1, 6);
    store.setStaticGravity(30);
    expect(engine.dynamic.gravity.get()).toBeCloseTo(0.5, 6);
  });

  it("makes pieces fall faster after raising gravity", () => {
    connectSettings(store, () => engine, input);
    engine.tick([]); // spawn
    store.setGravityPreset("off");
    const yBefore = engine.falling.location[1];
    for (let i = 0; i < 10; i++) engine.tick([]);
    expect(engine.falling.location[1]).toBeCloseTo(yBefore, 3); // no fall

    store.setGravityPreset("static");
    store.setStaticGravity(60); // 1 row/frame
    const yFast = engine.falling.location[1];
    for (let i = 0; i < 5; i++) engine.tick([]);
    expect(yFast - engine.falling.location[1]).toBeGreaterThanOrEqual(4);
  });
});
