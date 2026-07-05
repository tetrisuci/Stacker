import { describe, it, expect } from "vitest";
import {
  createStandardEngine,
  isSupportedBagType,
  SUPPORTED_BAG_TYPES,
  Engine,
} from "./adapter";

describe("engine adapter", () => {
  it("constructs a standard engine that produces a snapshot", () => {
    const engine = createStandardEngine({ seed: 12345 });
    expect(engine).toBeInstanceOf(Engine);

    const snap = engine.snapshot();
    // Board is stored bottom-up with a 20-row buffer over the 20 visible rows.
    expect(snap.board).toHaveLength(40);
    expect(snap.board[0]).toHaveLength(10);
    expect(snap.frame).toBe(0);
  });

  it("respects board dimensions", () => {
    const engine = createStandardEngine({ seed: 1, width: 10, height: 20 });
    const snap = engine.snapshot();
    expect(snap.board[0]).toHaveLength(10);
    expect(snap.board).toHaveLength(40); // 20 visible + 20 buffer
  });

  it("is deterministic: same seed -> identical queue", () => {
    const a = createStandardEngine({ seed: 777 });
    const b = createStandardEngine({ seed: 777 });
    expect(a.queue.slice(0, 14)).toEqual(b.queue.slice(0, 14));
  });

  it("different seeds generally produce different queues", () => {
    const a = createStandardEngine({ seed: 1 });
    const b = createStandardEngine({ seed: 2 });
    expect(a.queue.slice(0, 14)).not.toEqual(b.queue.slice(0, 14));
  });

  it("produces a valid seeded 7-bag queue of standard minos", () => {
    const engine = createStandardEngine({ seed: 42, bagType: "7-bag" });
    const minos = new Set(["i", "o", "t", "s", "z", "j", "l"]);

    // The queue is pre-filled to a substantial length and every entry must be a
    // real tetromino. (This asserts the RNG ran and produced legal pieces; the
    // exact bag partitioning is an engine internal we don't pin here.)
    expect(engine.queue.length).toBeGreaterThan(20);
    for (const piece of engine.queue) {
      expect(minos.has(String(piece).toLowerCase())).toBe(true);
    }

    // Over a large window a 7-bag RNG must use all seven minos.
    const seen = new Set(
      engine.queue.slice(0, 21).map((m) => String(m).toLowerCase()),
    );
    expect(seen).toEqual(minos);
  });

  it("recognizes the engine's supported bag types", () => {
    expect(isSupportedBagType("7-bag")).toBe(true);
    expect(isSupportedBagType("zenith")).toBe(false);
    expect(SUPPORTED_BAG_TYPES).toContain("7-bag");
  });
});
