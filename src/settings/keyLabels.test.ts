import { describe, it, expect } from "vitest";
import { keyLabel, bindingsForAction } from "./keyLabels";

describe("keyLabel", () => {
  it("labels special keys", () => {
    expect(keyLabel("ArrowLeft")).toBe("←");
    expect(keyLabel("Space")).toBe("Space");
    expect(keyLabel("ShiftLeft")).toBe("L-Shift");
    expect(keyLabel("ControlRight")).toBe("R-Ctrl");
  });

  it("labels letters, digits, numpad", () => {
    expect(keyLabel("KeyX")).toBe("X");
    expect(keyLabel("Digit7")).toBe("7");
    expect(keyLabel("Numpad5")).toBe("Num5");
  });

  it("passes through unknown codes", () => {
    expect(keyLabel("F13")).toBe("F13");
  });

  it("labels Ctrl+ combos", () => {
    expect(keyLabel("Ctrl+KeyZ")).toBe("Ctrl+Z");
    expect(keyLabel("Ctrl+KeyY")).toBe("Ctrl+Y");
  });
});

describe("bindingsForAction", () => {
  it("collects all codes bound to an action as labels", () => {
    const keymap = { KeyX: "rotateCW", ArrowUp: "rotateCW", KeyZ: "rotateCCW" };
    expect(bindingsForAction(keymap, "rotateCW").sort()).toEqual(["X", "↑"].sort());
    expect(bindingsForAction(keymap, "rotateCCW")).toEqual(["Z"]);
    expect(bindingsForAction(keymap, "hold")).toEqual([]);
  });
});
