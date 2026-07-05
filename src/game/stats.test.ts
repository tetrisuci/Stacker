import { describe, it, expect } from "vitest";
import { computeStats, FPS } from "./stats";
import { StatsStore } from "./statsStore";
import { createStandardEngine } from "../engine/adapter";
import type { EngineSnapshot } from "../engine/adapter";

// Build a minimal snapshot-like object for the pure-math tests.
function fakeSnapshot(
  pieces: number,
  attack: number,
  frame: number,
): EngineSnapshot {
  return {
    frame,
    stats: { pieces, garbage: { attack, sent: 0, receive: 0, cleared: 0 } },
  } as unknown as EngineSnapshot;
}

describe("computeStats", () => {
  it("returns zeros before any time has elapsed", () => {
    const s = computeStats(fakeSnapshot(0, 0, 0));
    expect(s).toEqual({ pieces: 0, pps: 0, attack: 0, apm: 0 });
  });

  it("computes PPS from pieces over elapsed seconds", () => {
    // 6 pieces in 3 seconds (180 frames) -> 2 pps.
    const s = computeStats(fakeSnapshot(6, 0, 3 * FPS));
    expect(s.pieces).toBe(6);
    expect(s.pps).toBeCloseTo(2, 5);
  });

  it("computes APM from attack over elapsed minutes", () => {
    // 10 attack in 30 seconds (1800 frames) -> 20 apm.
    const s = computeStats(fakeSnapshot(0, 10, 30 * FPS));
    expect(s.attack).toBe(10);
    expect(s.apm).toBeCloseTo(20, 5);
  });

  it("does not divide by zero on the very first frame", () => {
    const s = computeStats(fakeSnapshot(1, 1, 0));
    expect(Number.isFinite(s.pps)).toBe(true);
    expect(Number.isFinite(s.apm)).toBe(true);
    expect(s.pps).toBe(0);
    expect(s.apm).toBe(0);
  });

  it("reads pieces and attack from a real engine snapshot", () => {
    const engine = createStandardEngine({ seed: 1 });
    engine.tick([]);
    for (let i = 0; i < 4; i++) {
      engine.press("hardDrop");
      engine.tick([]);
    }
    const s = computeStats(engine.snapshot());
    expect(s.pieces).toBe(4);
    expect(s.attack).toBeGreaterThanOrEqual(0);
    expect(s.pps).toBeGreaterThan(0);
  });
});

describe("StatsStore", () => {
  it("notifies subscribers only when a displayed value changes", () => {
    const store = new StatsStore();
    let calls = 0;
    store.subscribe(() => calls++);

    store.set({ pieces: 1, pps: 1.234, attack: 0, apm: 0 });
    expect(calls).toBe(1);

    // A sub-0.01 PPS jitter should not re-render.
    store.set({ pieces: 1, pps: 1.2349, attack: 0, apm: 0 });
    expect(calls).toBe(1);

    // A change past the shown precision does notify.
    store.set({ pieces: 1, pps: 1.24, attack: 0, apm: 0 });
    expect(calls).toBe(2);

    // A pieces change notifies.
    store.set({ pieces: 2, pps: 1.24, attack: 0, apm: 0 });
    expect(calls).toBe(3);
  });

  it("reset returns to zeros", () => {
    const store = new StatsStore();
    store.set({ pieces: 5, pps: 3, attack: 2, apm: 40 });
    store.reset();
    expect(store.getSnapshot()).toEqual({
      pieces: 0,
      pps: 0,
      attack: 0,
      apm: 0,
    });
  });
});
