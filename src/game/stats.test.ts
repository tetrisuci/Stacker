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
    expect(s).toEqual({
      pieces: 0,
      pps: 0,
      attack: 0,
      apm: 0,
      keys: 0,
      kpp: 0,
    });
  });

  it("computes KPP from keys over pieces", () => {
    // 21 keys over 9 pieces ≈ 2.33 kpp.
    const s = computeStats(fakeSnapshot(9, 0, FPS), 21);
    expect(s.keys).toBe(21);
    expect(s.kpp).toBeCloseTo(21 / 9, 5);
  });

  it("prefers the session-owned pieces count when provided", () => {
    // Engine says 95 (drifted across undo/redo restores); session says 101.
    const s = computeStats(fakeSnapshot(95, 0, 10 * FPS), 234, 101);
    expect(s.pieces).toBe(101);
    expect(s.pps).toBeCloseTo(101 / 10, 5);
    expect(s.kpp).toBeCloseTo(234 / 101, 5);
  });

  it("keeps KPP at 0 before the first placement", () => {
    // Keys pressed while the first piece is still falling: no division by 0.
    const s = computeStats(fakeSnapshot(0, 0, FPS), 4);
    expect(s.keys).toBe(4);
    expect(s.kpp).toBe(0);
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

    const base = { pieces: 1, attack: 0, apm: 0, keys: 0, kpp: 0 };
    store.set({ ...base, pps: 1.234 });
    expect(calls).toBe(1);

    // A sub-0.01 PPS jitter should not re-render.
    store.set({ ...base, pps: 1.2349 });
    expect(calls).toBe(1);

    // A change past the shown precision does notify.
    store.set({ ...base, pps: 1.24 });
    expect(calls).toBe(2);

    // A pieces change notifies.
    store.set({ ...base, pieces: 2, pps: 1.24 });
    expect(calls).toBe(3);

    // A key press notifies.
    store.set({ ...base, pieces: 2, pps: 1.24, keys: 1, kpp: 0.5 });
    expect(calls).toBe(4);
  });

  it("reset returns to zeros", () => {
    const store = new StatsStore();
    store.set({ pieces: 5, pps: 3, attack: 2, apm: 40, keys: 12, kpp: 2.4 });
    store.reset();
    expect(store.getSnapshot()).toEqual({
      pieces: 0,
      pps: 0,
      attack: 0,
      apm: 0,
      keys: 0,
      kpp: 0,
    });
  });
});
