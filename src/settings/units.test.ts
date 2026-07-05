import { describe, it, expect } from "vitest";
import {
  msToFrames,
  framesToMs,
  toEngineHandling,
  MS_PER_FRAME,
  DEFAULT_HANDLING,
  gravityRowsPerFrame,
  GRAVITY_PRESET_G,
} from "./defaults";

describe("gravityRowsPerFrame", () => {
  it("converts presets from rows/sec to rows/frame", () => {
    expect(gravityRowsPerFrame({ preset: "off", staticG: 20 })).toBe(0);
    expect(
      gravityRowsPerFrame({ preset: "spicy", staticG: 20 }),
    ).toBeCloseTo(GRAVITY_PRESET_G.spicy / 60, 6);
  });

  it("uses staticG only for the static preset", () => {
    // 60 rows/sec = exactly 1 row/frame at 60fps.
    expect(gravityRowsPerFrame({ preset: "static", staticG: 60 })).toBe(1);
    expect(gravityRowsPerFrame({ preset: "static", staticG: 30 })).toBe(0.5);
    // A non-static preset ignores staticG entirely.
    expect(gravityRowsPerFrame({ preset: "off", staticG: 60 })).toBe(0);
  });
});

describe("ms <-> frames conversion", () => {
  it("MS_PER_FRAME is 1000/60", () => {
    expect(MS_PER_FRAME).toBeCloseTo(16.6667, 3);
  });

  it("converts ms to frames (rounded)", () => {
    expect(msToFrames(0)).toBe(0);
    expect(msToFrames(100)).toBe(6); // 100 / 16.667 = 6.0
    expect(msToFrames(200)).toBe(12);
    expect(msToFrames(50)).toBe(3);
    expect(msToFrames(16)).toBe(1); // rounds to nearest frame
    expect(msToFrames(8)).toBe(0);
  });

  it("converts frames to ms (rounded)", () => {
    expect(framesToMs(0)).toBe(0);
    expect(framesToMs(6)).toBe(100);
    expect(framesToMs(1)).toBe(17);
  });

  it("round-trips whole-frame ms values", () => {
    for (const frames of [0, 1, 3, 6, 12, 20]) {
      expect(msToFrames(framesToMs(frames))).toBe(frames);
    }
  });
});

describe("toEngineHandling", () => {
  it("converts arr/das/dcd to frames and leaves sdf as a multiplier", () => {
    const h = toEngineHandling({ arr: 100, das: 200, dcd: 50, sdf: 41 });
    expect(h.arr).toBe(6);
    expect(h.das).toBe(12);
    expect(h.dcd).toBe(3);
    expect(h.sdf).toBe(41); // unitless, unchanged
  });

  it("includes the fixed handling flags", () => {
    const h = toEngineHandling(DEFAULT_HANDLING);
    expect(h.safelock).toBe(true);
    expect(h.irs).toBe("tap");
    expect(h.ihs).toBe("tap");
    expect(h.cancel).toBe(false);
  });

  it("maps the ms defaults to sane frame values", () => {
    const h = toEngineHandling(DEFAULT_HANDLING);
    expect(h.das).toBe(6); // 100ms default
    expect(h.arr).toBe(0);
    expect(h.dcd).toBe(0);
  });
});
