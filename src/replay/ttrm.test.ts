import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseMatch, buildGameReplay, isMatchReplay } from "./ttrm";
import { checkReconstructionSupport } from "./parse";
import { reconstructReplay } from "./reconstruct";
import { pieceOffsets } from "../render/theme";

const dataPath = (name: string) =>
  fileURLToPath(new URL(`../../test_data/${name}`, import.meta.url));

const matchText = () => readFileSync(dataPath("promooooooo_tr.ttrm"), "utf8");

describe("isMatchReplay", () => {
  it("distinguishes a .ttrm (rounds) from a .ttr (events)", () => {
    expect(isMatchReplay({ replay: { rounds: [[]] } })).toBe(true);
    expect(isMatchReplay({ replay: { events: [] } })).toBe(false);
    expect(isMatchReplay({ data: { replay: { rounds: [[]] } } })).toBe(true);
    expect(isMatchReplay(null)).toBe(false);
    expect(isMatchReplay("nope")).toBe(false);
  });
});

describe("parseMatch (promooooooo_tr.ttrm)", () => {
  it("enumerates every round × player game", () => {
    const res = parseMatch(matchText());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const { match } = res;
    // The bundled Tetra League match is 8 rounds, 2 players each.
    expect(match.rounds).toBe(8);
    expect(match.games).toHaveLength(16);
    expect(match.gamemode).toBe("league");
    // Games are in round-then-player order.
    expect(match.games[0]).toMatchObject({ round: 0, player: 0 });
    expect(match.games[1]).toMatchObject({ round: 0, player: 1 });
    // Both contestants appear.
    const names = new Set(match.games.map((g) => g.username));
    expect(names.has("promooooooo")).toBe(true);
    expect(names.size).toBe(2);
  });

  it("rejects non-match and malformed input", () => {
    expect(parseMatch("{not json").ok).toBe(false);
    const noRounds = parseMatch(JSON.stringify({ replay: { events: [] } }));
    expect(noRounds.ok).toBe(false);
    const empty = parseMatch(JSON.stringify({ replay: { rounds: [] } }));
    expect(empty.ok).toBe(false);
  });
});

describe("buildGameReplay + reconstruction", () => {
  it("builds a supported, garbage-accurate reconstruction for a chosen game", () => {
    const res = parseMatch(matchText());
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // Round 6 (index 5), player 0 = promooooooo — the round the prototype
    // validated against (43 garbage sent / 9 received).
    const built = buildGameReplay(res.match, 5, 0);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const replay = built.replay;

    expect(replay.metadata.username).toBe("promooooooo");
    expect(replay.metadata.bagtype).toBe("7-bag");
    // The fully-resolved options from the `end` event carry the multiplayer
    // passthrough mode — the field the partial `replay.options` diff omits.
    expect((replay.options as { passthrough?: string }).passthrough).toBe(
      "zero",
    );
    expect(checkReconstructionSupport(replay).supported).toBe(true);

    const result = reconstructReplay(replay);
    expect(result.track.length).toBeGreaterThan(0);
    // One placement per locked piece, well-formed and in order.
    result.track.forEach((p, i) => {
      expect(p.pieceIndex).toBe(i);
      expect(p.piece).toMatch(/^[iojlstz]$/);
      expect(p.snapshot.board).toHaveLength(40);
    });

    // Garbage is routed by the engine from the ige events: the simulated
    // sent/received totals reproduce the ttrm's recorded values exactly — the
    // core validation that garbage lands in the right place.
    const stats = (result.engine as { stats: { garbage: { sent: number; receive: number } } })
      .stats.garbage;
    expect(stats.sent).toBe(43);
    expect(stats.receive).toBe(9);
  });

  it("errors for an out-of-range game", () => {
    const res = parseMatch(matchText());
    if (!res.ok) throw new Error("parse failed");
    const bad = buildGameReplay(res.match, 99, 0);
    expect(bad.ok).toBe(false);
  });

  it("captures incoming garbage tanks per placement", () => {
    // In multiplayer the pro receives garbage between pieces; reconstruction
    // records each `garbage.tank` arrival on the placement it landed during, so
    // the session can reproduce the terrain on the learner board. Round 1 player
    // 0 of the bundled match: the first garbage (4 rows, hole at column 9) tanks
    // while piece 32 is active.
    const res = parseMatch(matchText());
    if (!res.ok) throw new Error("parse failed");
    const built = buildGameReplay(res.match, 0, 0);
    if (!built.ok) throw new Error("build failed");
    const { track } = reconstructReplay(built.replay);

    expect(track[32].garbage).toEqual([{ column: 9, amount: 4, size: 1 }]);
    // Pieces before the first attack have no garbage.
    expect(track[31].garbage).toEqual([]);

    // Every tank is well-formed, and the total rows tanked across the game is
    // positive (this match has real garbage traffic).
    let totalRows = 0;
    for (const p of track) {
      for (const t of p.garbage) {
        expect(t.amount).toBeGreaterThan(0);
        expect(t.column).toBeGreaterThanOrEqual(0);
        expect(t.size).toBeGreaterThan(0);
        totalRows += t.amount;
      }
    }
    expect(totalRows).toBeGreaterThan(0);
  });

  it("records placement y in the garbage-shifted frame (ghost lands on the piece)", () => {
    // When garbage tanks during a piece, the engine shifts the board up but leaves
    // `falling.location[1]` untouched — so the raw lock y is that many rows too low.
    // Reconstruction adds the tanked-row count back, so the target ghost (drawn at
    // x/y/rot) lands exactly on the piece in the post-lock board rather than buried
    // inside the stack. Verify every non-clearing placement's ghost cells fall on
    // filled, non-garbage cells of its own snapshot.
    const res = parseMatch(matchText());
    if (!res.ok) throw new Error("parse failed");
    const built = buildGameReplay(res.match, 0, 0);
    if (!built.ok) throw new Error("build failed");
    const { track } = reconstructReplay(built.replay);

    const isGb = (c: unknown): boolean =>
      !!c && ((c as { mino?: string }).mino ?? c) === "gb";

    // Piece 32 (the S that arrives with 4 garbage rows) is the exact case from the
    // bug report: its ghost must sit on the stack, not 4 rows inside it.
    const p32 = track[32];
    const cells32 = pieceOffsets(p32.piece, p32.rot).map(
      ([dx, dy]) => [p32.x + dx, p32.y - dy] as const,
    );
    for (const [x, y] of cells32) {
      const cell = (p32.snapshot.board[y] as unknown[])[x];
      expect(cell).not.toBeNull();
      expect(isGb(cell)).toBe(false);
    }

    // And it holds for every placement that doesn't clear (a clear removes the
    // piece's own cells from the post-lock snapshot, so there's nothing to land on).
    for (const p of track) {
      if (p.clears > 0) continue;
      for (const [dx, dy] of pieceOffsets(p.piece, p.rot)) {
        const x = p.x + dx;
        const y = p.y - dy;
        const row = p.snapshot.board[y] as unknown[] | undefined;
        const cell = row?.[x];
        expect(cell == null || isGb(cell)).toBe(false);
      }
    }
  });
});
