import { describe, it, expect } from "vitest";
import { garbageIndicator, DEFAULT_GARBAGE_CONFIG } from "./garbage";
import { createStandardEngine } from "../engine/adapter";
import type { EngineSnapshot } from "../engine/adapter";

// Minimal snapshot for the pure-math tests.
function snap(
  frame: number,
  queue: Array<{
    frame: number;
    amount: number;
    size?: number;
    confirmed?: boolean;
  }>,
): EngineSnapshot {
  return {
    frame,
    garbage: {
      queue: queue.map((q) => ({
        frame: q.frame,
        amount: q.amount,
        size: q.size ?? 1,
        confirmed: q.confirmed ?? false,
        cid: 0,
        gameid: 0,
      })),
    },
  } as unknown as EngineSnapshot;
}

describe("garbageIndicator", () => {
  it("is empty for an empty queue", () => {
    const r = garbageIndicator(snap(0, []));
    expect(r.total).toBe(0);
    expect(r.segments).toEqual([]);
  });

  it("totals amounts and keeps queue order", () => {
    const r = garbageIndicator(
      snap(50, [
        { frame: 40, amount: 4 },
        { frame: 45, amount: 2 },
      ]),
    );
    expect(r.total).toBe(6);
    expect(r.segments.map((s) => s.amount)).toEqual([4, 2]);
  });

  it("computes charge progress from age / speed", () => {
    const speed = DEFAULT_GARBAGE_CONFIG.speed; // 20
    const r = garbageIndicator(
      snap(30, [
        { frame: 20, amount: 4 }, // age 10 -> 0.5
        { frame: 30, amount: 2 }, // age 0  -> 0
        { frame: 0, amount: 1 }, // age 30 -> clamp 1
      ]),
      { speed },
    );
    expect(r.segments[0].charge).toBeCloseTo(0.5, 5);
    expect(r.segments[1].charge).toBe(0);
    expect(r.segments[2].charge).toBe(1);
  });

  it("carries the confirmed flag and hole size", () => {
    const r = garbageIndicator(
      snap(10, [{ frame: 0, amount: 3, size: 2, confirmed: true }]),
    );
    expect(r.segments[0].confirmed).toBe(true);
    expect(r.segments[0].size).toBe(2);
  });

  it("skips zero-amount entries", () => {
    const r = garbageIndicator(
      snap(10, [
        { frame: 0, amount: 0 },
        { frame: 0, amount: 3 },
      ]),
    );
    expect(r.total).toBe(3);
    expect(r.segments).toHaveLength(1);
  });

  it("reads a real engine snapshot's garbage queue", () => {
    const e = createStandardEngine({ seed: 1 });
    e.tick([]);
    e.garbageQueue.receive({
      frame: e.frame,
      amount: 4,
      size: 1,
      cid: 1,
      gameid: 2,
      confirmed: true,
    });
    const r = garbageIndicator(e.snapshot());
    expect(r.total).toBe(4);
    expect(r.segments[0].confirmed).toBe(true);
  });
});
