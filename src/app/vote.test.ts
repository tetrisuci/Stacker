import { describe, expect, it } from "vitest";
import { applyVote, nextVote } from "./vote";

describe("nextVote", () => {
  it("casts when no prior vote", () => {
    expect(nextVote(0, 1)).toBe(1);
    expect(nextVote(0, -1)).toBe(-1);
  });

  it("toggles off when clicking the same direction", () => {
    expect(nextVote(1, 1)).toBe(0);
    expect(nextVote(-1, -1)).toBe(0);
  });

  it("switches direction", () => {
    expect(nextVote(1, -1)).toBe(-1);
    expect(nextVote(-1, 1)).toBe(1);
  });
});

describe("applyVote", () => {
  const base = { ups: 5, downs: 2, myVote: 0 };

  it("adds a fresh up/down", () => {
    expect(applyVote(base, 1)).toEqual({ ups: 6, downs: 2, myVote: 1 });
    expect(applyVote(base, -1)).toEqual({ ups: 5, downs: 3, myVote: -1 });
  });

  it("moves a switched vote across both counters", () => {
    expect(applyVote({ ups: 6, downs: 2, myVote: 1 }, -1)).toEqual({
      ups: 5,
      downs: 3,
      myVote: -1,
    });
  });

  it("removes a cleared vote", () => {
    expect(applyVote({ ups: 6, downs: 2, myVote: 1 }, 0)).toEqual({
      ups: 5,
      downs: 2,
      myVote: 0,
    });
  });
});
