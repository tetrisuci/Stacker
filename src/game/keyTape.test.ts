import { beforeEach, describe, expect, it } from "vitest";
import { KeyTape } from "./keyTape";

describe("KeyTape", () => {
  let tape: KeyTape;
  beforeEach(() => {
    tape = new KeyTape();
  });

  it("undo restores the count at the undone piece's spawn", () => {
    tape.record(3); // piece 1 locked after 3 presses
    tape.record(7); // piece 2 locked after 7
    expect(tape.undo()).toBe(3); // piece 2 undone → back to 3
    expect(tape.undo()).toBe(0); // piece 1 undone → back to 0
  });

  it("redo restores the redone piece's post-lock count", () => {
    tape.record(3);
    tape.record(7);
    tape.undo();
    tape.undo();
    expect(tape.redo()).toBe(3);
    expect(tape.redo()).toBe(7);
  });

  it("returns null at both ends", () => {
    expect(tape.undo()).toBeNull();
    tape.record(3);
    expect(tape.redo()).toBeNull();
    tape.undo();
    expect(tape.undo()).toBeNull();
  });

  it("a fresh placement truncates the redo tail", () => {
    tape.record(3);
    tape.record(7);
    tape.undo(); // back to 3
    tape.record(5); // retry the piece with fewer presses
    expect(tape.redo()).toBeNull(); // old future is gone
    expect(tape.undo()).toBe(3);
  });

  it("reset forgets everything", () => {
    tape.record(3);
    tape.reset();
    expect(tape.undo()).toBeNull();
    expect(tape.redo()).toBeNull();
  });
});
