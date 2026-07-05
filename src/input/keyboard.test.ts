import { describe, it, expect, beforeEach, vi } from "vitest";
import { KeyboardSource } from "./keyboard";

// Minimal EventTarget stub so we can drive the source without a DOM. The source
// only reads `code`, `repeat`, and calls `preventDefault` on events.
class StubTarget {
  private listeners: Record<string, EventListener[]> = {};
  addEventListener(type: string, fn: EventListener) {
    (this.listeners[type] ??= []).push(fn);
  }
  removeEventListener(type: string, fn: EventListener) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn);
  }
  fire(type: string, code: string, repeat = false, ctrlKey = false) {
    const ev = {
      code,
      repeat,
      ctrlKey,
      metaKey: false,
      preventDefault: vi.fn(),
    } as unknown as Event;
    for (const fn of this.listeners[type] ?? []) fn(ev);
  }
}

describe("KeyboardSource", () => {
  let target: StubTarget;
  let src: KeyboardSource;

  beforeEach(() => {
    // Provide a global `window` for the blur listener the source attaches.
    (globalThis as any).window = new StubTarget();
    target = new StubTarget();
    src = new KeyboardSource({ target: target as unknown as HTMLElement });
    src.attach();
  });

  it("maps arrow keys to engine actions in press/release order", () => {
    target.fire("keydown", "ArrowLeft");
    target.fire("keyup", "ArrowLeft");
    target.fire("keydown", "Space");
    expect(src.drain()).toEqual([
      { type: "keydown", key: "moveLeft" },
      { type: "keyup", key: "moveLeft" },
      { type: "keydown", key: "hardDrop" },
    ]);
  });

  it("ignores OS auto-repeat and duplicate keydowns", () => {
    target.fire("keydown", "ArrowRight");
    target.fire("keydown", "ArrowRight", true); // repeat flag
    target.fire("keydown", "ArrowRight"); // still held
    expect(src.drain()).toEqual([{ type: "keydown", key: "moveRight" }]);
  });

  it("ignores unmapped keys", () => {
    target.fire("keydown", "KeyQ");
    target.fire("keyup", "KeyQ");
    expect(src.drain()).toEqual([]);
  });

  it("drain clears the buffer", () => {
    target.fire("keydown", "KeyC");
    expect(src.drain()).toHaveLength(1);
    expect(src.drain()).toEqual([]);
  });

  it("releases held keys on window blur", () => {
    target.fire("keydown", "ArrowLeft");
    target.fire("keydown", "ArrowDown");
    src.drain();
    (globalThis as any).window.fire("blur", "");
    const released = src.drain();
    expect(released).toContainEqual({ type: "keyup", key: "moveLeft" });
    expect(released).toContainEqual({ type: "keyup", key: "softDrop" });
  });

  it("allows re-press after release", () => {
    target.fire("keydown", "Space");
    target.fire("keyup", "Space");
    target.fire("keydown", "Space");
    expect(src.drain()).toEqual([
      { type: "keydown", key: "hardDrop" },
      { type: "keyup", key: "hardDrop" },
      { type: "keydown", key: "hardDrop" },
    ]);
  });
});

describe("KeyboardSource app actions (restart)", () => {
  let target: StubTarget;

  beforeEach(() => {
    (globalThis as any).window = new StubTarget();
    target = new StubTarget();
  });

  it("fires onAppKey for a bound app action and does NOT buffer it as input", () => {
    const onAppKey = vi.fn();
    const src = new KeyboardSource({
      target: target as unknown as HTMLElement,
      onAppKey,
    });
    src.attach();

    target.fire("keydown", "Enter"); // default-bound to restart
    expect(onAppKey).toHaveBeenCalledWith("restart");
    // The restart keydown must not enter the engine input stream.
    expect(src.drain()).toEqual([]);
    // ...and its keyup produces no engine transition either.
    target.fire("keyup", "Enter");
    expect(src.drain()).toEqual([]);
  });

  it("respects a rebound restart key via setKeymap", () => {
    const onAppKey = vi.fn();
    const src = new KeyboardSource({
      target: target as unknown as HTMLElement,
      onAppKey,
    });
    src.attach();
    // Rebind restart to F5, unbind Enter.
    src.setKeymap({ F5: "restart", ArrowLeft: "moveLeft" });

    target.fire("keydown", "Enter"); // now unmapped
    expect(onAppKey).not.toHaveBeenCalled();

    target.fire("keydown", "F5");
    expect(onAppKey).toHaveBeenCalledWith("restart");

    // Gameplay keys still work alongside.
    target.fire("keydown", "ArrowLeft");
    expect(src.drain()).toEqual([{ type: "keydown", key: "moveLeft" }]);
  });

  it("ignores OS auto-repeat for app actions (fires once per press)", () => {
    const onAppKey = vi.fn();
    const src = new KeyboardSource({
      target: target as unknown as HTMLElement,
      onAppKey,
    });
    src.attach();
    target.fire("keydown", "KeyR"); // default restart
    target.fire("keydown", "KeyR", true); // auto-repeat
    target.fire("keydown", "KeyR"); // still held
    expect(onAppKey).toHaveBeenCalledTimes(1);
    // After release, it can fire again.
    target.fire("keyup", "KeyR");
    target.fire("keydown", "KeyR");
    expect(onAppKey).toHaveBeenCalledTimes(2);
  });
});

describe("KeyboardSource Ctrl combos (undo/redo)", () => {
  let target: StubTarget;

  beforeEach(() => {
    (globalThis as any).window = new StubTarget();
    target = new StubTarget();
  });

  it("fires undo on Ctrl+Z and redo on Ctrl+Y (not as engine input)", () => {
    const onAppKey = vi.fn();
    const src = new KeyboardSource({
      target: target as unknown as HTMLElement,
      onAppKey,
    });
    src.attach();

    target.fire("keydown", "KeyZ", false, true); // Ctrl+Z
    expect(onAppKey).toHaveBeenCalledWith("undo");
    target.fire("keyup", "KeyZ", false, true);

    target.fire("keydown", "KeyY", false, true); // Ctrl+Y
    expect(onAppKey).toHaveBeenCalledWith("redo");

    // No engine transitions from the combos.
    expect(src.drain()).toEqual([]);
  });

  it("plain Z (no Ctrl) still rotates CCW, not undo", () => {
    const onAppKey = vi.fn();
    const src = new KeyboardSource({
      target: target as unknown as HTMLElement,
      onAppKey,
    });
    src.attach();

    target.fire("keydown", "KeyZ"); // plain Z
    expect(onAppKey).not.toHaveBeenCalled();
    expect(src.drain()).toEqual([{ type: "keydown", key: "rotateCCW" }]);
  });
});
