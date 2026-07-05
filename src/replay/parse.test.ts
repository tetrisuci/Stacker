import { describe, it, expect } from "vitest";
import { parseReplay, checkReconstructionSupport } from "./parse";
import { buildProEngine } from "./proEngine";
import { makeTtr, makeZenithTtr } from "./fixtures";

describe("parseReplay", () => {
  it("rejects non-JSON", () => {
    const r = parseReplay("not json {");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/JSON/);
  });

  it("rejects JSON without a replay body", () => {
    const r = parseReplay(JSON.stringify({ hello: "world" }));
    expect(r.ok).toBe(false);
  });

  it("rejects a replay missing its options block", () => {
    const r = parseReplay(JSON.stringify({ replay: { events: [] } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/options/);
  });

  it("parses a valid 7-bag replay and extracts metadata", () => {
    const r = parseReplay(makeTtr());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const m = r.replay.metadata;
    expect(m.username).toBe("promooooooo");
    expect(m.gamemode).toBe("40l");
    expect(m.frames).toBe(100);
    expect(m.durationSec).toBeCloseTo(100 / 60, 5);
    expect(m.seed).toBe(12345);
    expect(m.bagtype).toBe("7-bag");
    expect(m.hasgarbage).toBe(false);
    expect(m.stats.pps).toBe(3.78);
    expect(m.stats.apm).toBe(208);
    expect(m.stats.lines).toBe(40);
    expect(m.stats.pieces).toBe(100);
  });

  it("preserves options and events for reconstruction", () => {
    const r = parseReplay(makeTtr());
    if (!r.ok) throw new Error("parse failed");
    expect(r.replay.options.bagtype).toBe("7-bag");
    expect(Array.isArray(r.replay.events)).toBe(true);
    expect(r.replay.events.length).toBeGreaterThan(0);
  });

  it("warns on an unknown version", () => {
    const r = parseReplay(makeTtr({ version: 99 }));
    if (!r.ok) throw new Error("parse failed");
    expect(r.replay.warnings.some((w) => /version 99/.test(w))).toBe(true);
  });

  it("tolerates missing stats (nulls, no throw)", () => {
    const r = parseReplay(makeTtr({ results: {} }));
    if (!r.ok) throw new Error("parse failed");
    expect(r.replay.metadata.stats.pps).toBeNull();
    expect(r.replay.metadata.stats.lines).toBeNull();
  });

  it("finds stats nested under results.stats or results directly", () => {
    const direct = parseReplay(
      makeTtr({ results: { pps: 2.5, apm: 100, lines: 20, piecesplaced: 60 } }),
    );
    if (!direct.ok) throw new Error("parse failed");
    expect(direct.replay.metadata.stats.pps).toBe(2.5);
    expect(direct.replay.metadata.stats.pieces).toBe(60);
  });

  it("reads a body nested under data.replay", () => {
    const nested = JSON.parse(makeTtr());
    const wrapped = JSON.stringify({ data: { replay: nested.replay, users: nested.users, gamemode: nested.gamemode }, version: 1 });
    const r = parseReplay(wrapped);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.replay.metadata.bagtype).toBe("7-bag");
  });
});

describe("checkReconstructionSupport", () => {
  it("supports a standard 7-bag replay", () => {
    const r = parseReplay(makeTtr());
    if (!r.ok) throw new Error("parse failed");
    expect(checkReconstructionSupport(r.replay).supported).toBe(true);
  });

  it("partially supports Zenith mode with a caption", () => {
    const r = parseReplay(makeZenithTtr());
    if (!r.ok) throw new Error("parse failed");
    const check = checkReconstructionSupport(r.replay);
    expect(check.supported).toBe(true);
    expect(check.partial).toMatch(/Zenith/i);
    expect(check.partial).toMatch(/7-bag/);
  });

  it("substitutes 7-bag for the zenith bag but keeps the true bag in metadata", () => {
    const r = parseReplay(makeTtr({ options: { bagtype: "zenith" as never } }));
    if (!r.ok) throw new Error("parse failed");
    expect(r.replay.metadata.bagtype).toBe("zenith");
    expect(r.replay.options.bagtype).toBe("7-bag");
    const check = checkReconstructionSupport(r.replay);
    expect(check.supported).toBe(true);
    expect(check.partial).toBeTruthy();
  });

  it("blocks an unsupported bag type", () => {
    const r = parseReplay(makeTtr({ options: { bagtype: "bombs" as never } }));
    if (!r.ok) throw new Error("parse failed");
    const check = checkReconstructionSupport(r.replay);
    expect(check.supported).toBe(false);
    expect(check.reason).toMatch(/bag type/i);
  });

  it("accepts all engine-supported bag types", () => {
    for (const bag of [
      "7-bag",
      "14-bag",
      "classic",
      "pairs",
      "total mayhem",
      "7+1-bag",
      "7+2-bag",
      "7+x-bag",
    ]) {
      const r = parseReplay(makeTtr({ options: { bagtype: bag as never } }));
      if (!r.ok) throw new Error("parse failed");
      expect(
        checkReconstructionSupport(r.replay).supported,
        `bag ${bag}`,
      ).toBe(true);
    }
  });

  it("blocks non-standard board dimensions", () => {
    const r = parseReplay(makeTtr({ options: { boardwidth: 8 } }));
    if (!r.ok) throw new Error("parse failed");
    const check = checkReconstructionSupport(r.replay);
    expect(check.supported).toBe(false);
    expect(check.reason).toMatch(/board width/i);
  });
});

describe("buildProEngine", () => {
  it("builds a working engine from a supported replay", () => {
    const r = parseReplay(makeTtr());
    if (!r.ok) throw new Error("parse failed");
    const engine = buildProEngine(r.replay);
    engine.tick([]); // spawn
    const snap = engine.snapshot();
    expect(snap.board).toHaveLength(40); // 20 visible + 20 buffer
    expect(snap.board[0]).toHaveLength(10);
    expect(String(snap.falling.symbol)).toMatch(/^[iojlstz]$/);
  });

  it("produces a deterministic queue from the replay seed", () => {
    const r1 = parseReplay(makeTtr({ options: { seed: 777 } }));
    const r2 = parseReplay(makeTtr({ options: { seed: 777 } }));
    if (!r1.ok || !r2.ok) throw new Error("parse failed");
    const e1 = buildProEngine(r1.replay);
    const e2 = buildProEngine(r2.replay);
    expect(e1.queue.slice(0, 14)).toEqual(e2.queue.slice(0, 14));
  });
});
