import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseReplay, checkReconstructionSupport } from "./parse";
import { reconstructReplay, groupEventsByFrame } from "./reconstruct";

const dataPath = (name: string) =>
  fileURLToPath(new URL(`../../test_data/${name}`, import.meta.url));

function loadReplay(name: string) {
  const text = readFileSync(dataPath(name), "utf8");
  const parsed = parseReplay(text);
  if (!parsed.ok) throw new Error(`parse failed: ${parsed.error}`);
  return parsed.replay;
}

describe("groupEventsByFrame", () => {
  it("buckets events by their integer frame", () => {
    const events = [
      { frame: 0, type: "start", data: {} },
      { frame: 0, type: "keydown", data: { subframe: 0.5 } },
      { frame: 2, type: "keydown", data: { subframe: 0 } },
    ];
    const grouped = groupEventsByFrame(events);
    expect(grouped.get(0)).toHaveLength(2);
    expect(grouped.get(2)).toHaveLength(1);
    expect(grouped.get(1)).toBeUndefined();
  });
});

describe("40L golden reconstruction (promooooooo_40l.ttr)", () => {
  // Known values from the replay's own results block:
  //   stats.piecesplaced = 101, stats.lines = 40 (10 quads).
  const EXPECTED_PIECES = 101;
  const EXPECTED_LINES = 40;

  it("parses and is reconstruction-supported", () => {
    const replay = loadReplay("promooooooo_40l.ttr");
    expect(replay.gamemode).toBe("40l");
    expect(replay.metadata.bagtype).toBe("7-bag");
    expect(checkReconstructionSupport(replay).supported).toBe(true);
  });

  it("reproduces the known piece and line counts", () => {
    const replay = loadReplay("promooooooo_40l.ttr");
    const result = reconstructReplay(replay);

    expect(result.pieces).toBe(EXPECTED_PIECES);
    expect(result.lines).toBe(EXPECTED_LINES);
    // One placement recorded per locked piece.
    expect(result.track).toHaveLength(EXPECTED_PIECES);
  });

  it("records well-formed placements in order", () => {
    const replay = loadReplay("promooooooo_40l.ttr");
    const { track } = reconstructReplay(replay);

    track.forEach((p, i) => {
      expect(p.pieceIndex).toBe(i);
      expect(p.piece).toMatch(/^[iojlstz]$/);
      expect(typeof p.frame).toBe("number");
      expect(typeof p.wasHold).toBe("boolean");
      expect(p.snapshot.board).toHaveLength(40); // 20 visible + 20 buffer
    });

    // The results report 30 holds and 10 line-clearing placements (quads).
    expect(track.filter((p) => p.wasHold)).toHaveLength(30);
    const clearing = track.filter((p) => p.clears > 0);
    expect(clearing).toHaveLength(10);
    expect(clearing.every((p) => p.clears === 4)).toBe(true);

    // Frames are non-decreasing across the track.
    for (let i = 1; i < track.length; i++) {
      expect(track[i].frame).toBeGreaterThanOrEqual(track[i - 1].frame);
    }
  });

  it("is deterministic across runs", () => {
    const a = reconstructReplay(loadReplay("promooooooo_40l.ttr"));
    const b = reconstructReplay(loadReplay("promooooooo_40l.ttr"));
    expect(b.pieces).toBe(a.pieces);
    expect(b.lines).toBe(a.lines);
    expect(b.track.map((p) => [p.piece, p.x, p.y, p.rot])).toEqual(
      a.track.map((p) => [p.piece, p.x, p.y, p.rot]),
    );
  });

  it("captures the pro's real keydown finesse per placement", () => {
    // Each placement carries the pro's actual keydown sequence (the finesse the
    // learner drills), bucketed between locks. Verified against the raw .ttr
    // events for the opening pieces.
    const replay = loadReplay("promooooooo_40l.ttr");
    const { track } = reconstructReplay(replay);

    // Every input is a gameplay key and every non-hold placement ends in a drop.
    const GAMEPLAY = new Set([
      "moveLeft",
      "moveRight",
      "softDrop",
      "hardDrop",
      "rotateCW",
      "rotateCCW",
      "rotate180",
      "hold",
    ]);
    for (const p of track) {
      expect(Array.isArray(p.inputs)).toBe(true);
      for (const s of p.inputs) {
        expect(GAMEPLAY.has(s.key)).toBe(true);
        // Only moves can be DAS-held.
        if (s.held) expect(["moveLeft", "moveRight"]).toContain(s.key);
      }
      // A placed piece is committed with a hard drop (this replay never soft-
      // drops into a lock), so the last press is always the drop.
      expect(p.inputs[p.inputs.length - 1].key).toBe("hardDrop");
    }

    // The opener, straight from the raw events: I rotates CW then drops; the
    // second piece DAS-slams left (T to the wall), holds, then drops.
    expect(track[0].inputs.map((s) => s.key)).toEqual(["rotateCW", "hardDrop"]);
    expect(track[1].inputs.map((s) => s.key)).toEqual([
      "moveLeft",
      "hold",
      "hardDrop",
    ]);
    expect(track[1].wasHold).toBe(true);

    // Every raw keydown is bucketed exactly once (nothing dropped or double
    // counted). Carried steps are synthetic (a held key crossing a lock, not a
    // fresh keydown), so real steps = total minus carried, and that equals the
    // file's keydown count.
    const keydowns = (replay.events as Array<{ type?: string }>).filter(
      (e) => e.type === "keydown",
    ).length;
    const total = track.reduce((n, p) => n + p.inputs.length, 0);
    const carried = track.reduce(
      (n, p) => n + p.inputs.filter((s) => s.carried).length,
      0,
    );
    expect(total - carried).toBe(keydowns);
  });

  it("flags DAS slides from taps by the piece's real displacement", () => {
    // `held` is decided by how far the piece actually moved, not how long the key
    // was down: a slide of >1 cell is DAS-held; a single-cell move (or a long but
    // wall-blocked press) is a tap. Piece 1's T slams to the left wall (a DAS
    // slide); piece 3's S nudges one cell left (a tap).
    const { track } = reconstructReplay(loadReplay("promooooooo_40l.ttr"));

    const move1 = track[1].inputs.find((s) => s.key === "moveLeft");
    expect(move1?.held).toBe(true);
    const move3 = track[3].inputs.find((s) => s.key === "moveLeft");
    expect(move3?.held).toBe(false);

    // Two consecutive single-cell nudges are two taps, not one DAS slide: piece
    // 86 taps left twice, and neither is held.
    const taps86 = track[86].inputs.filter((s) => s.key === "moveLeft");
    expect(taps86).toHaveLength(2);
    expect(taps86.every((s) => !s.held)).toBe(true);

    // Non-move keys are never marked held.
    for (const p of track) {
      for (const s of p.inputs) {
        if (s.key !== "moveLeft" && s.key !== "moveRight") {
          expect(s.held).toBe(false);
        }
      }
    }
  });

  it("marks a DAS hold carried across pieces as 'keep holding'", () => {
    // The pro sometimes keeps a move key held through a hard drop, so the next
    // piece is already DAS-charged and needs no fresh press. That next piece's
    // finesse begins with a carried step (the saved keystroke), and the piece the
    // hold STARTED on is flagged `keepHeld` — so the learner is told to keep
    // holding *before* the drop, not only after. Pieces 9→10→11 share one held
    // moveRight: 9 starts it, 10 sustains, 11 slides to the wall (x=7).
    const { track } = reconstructReplay(loadReplay("promooooooo_40l.ttr"));

    const lead = track[11].inputs[0];
    expect(lead.carried).toBe(true);
    expect(lead.key).toBe("moveRight");
    expect(track[11].x).toBe(7); // slid to the right wall via the carry

    // The originating pieces are told to keep holding (before their drop).
    expect(
      track[9].inputs.some((s) => s.key === "moveRight" && s.keepHeld),
    ).toBe(true);
    expect(
      track[10].inputs.some((s) => s.key === "moveRight" && s.keepHeld),
    ).toBe(true);

    // Invariants across the whole track:
    for (let i = 0; i < track.length; i++) {
      track[i].inputs.forEach((s, idx) => {
        if (s.carried) {
          // A carried step leads, is a held move (a carry that never slid is
          // dropped — including when an opposite move overrode it), and its
          // previous piece flags the matching keepHeld. Opposite moves MAY
          // follow a genuine carry: DAS to the wall, then nudge back out.
          expect(idx).toBe(0);
          expect(["moveLeft", "moveRight"]).toContain(s.key);
          expect(s.held).toBe(true);
          expect(
            track[i - 1]?.inputs.some((o) => o.key === s.key && o.keepHeld),
          ).toBe(true);
        }
        if (s.keepHeld) {
          // A keep-held move is a move whose next piece carries it. It need NOT
          // be held on this piece — the pro may tap one cell here and keep the key
          // down for a DAS slide on the next piece.
          expect(["moveLeft", "moveRight"]).toContain(s.key);
          const next = track[i + 1];
          expect(next?.inputs[0]?.carried).toBe(true);
          expect(next?.inputs[0]?.key).toBe(s.key);
        }
      });
    }
  });

});

describe.skipIf(!existsSync(dataPath("nuewink.ttr")))(
  "genuine carried DAS followed by opposite taps (nuewink.ttr)",
  () => {
    // Regression: the pro holds left DAS through piece 99's drop; the last
    // piece slides to the left wall on the carried charge, then taps right,
    // CCW, right, right. The carry used to be dropped as "overridden by an
    // opposite move" — but it genuinely slid the piece, so it must be shown
    // (our goal is the pro's exact inputs, optimal finesse or not).
    it("keeps the carried left DAS on the last piece", () => {
      const replay = loadReplay("nuewink.ttr");
      const { track } = reconstructReplay(replay);
      const last = track[100];
      expect(last.inputs.map((s) => s.key)).toEqual([
        "moveLeft",
        "moveRight",
        "rotateCCW",
        "moveRight",
        "moveRight",
        "hardDrop",
      ]);
      expect(last.inputs[0].carried).toBe(true);
      expect(last.inputs[0].held).toBe(true);
      // …and the originating piece tells the learner not to release.
      expect(
        track[99].inputs.some((s) => s.key === "moveLeft" && s.keepHeld),
      ).toBe(true);
    });
  },
);

describe.skipIf(!existsSync(dataPath("monke.ttr")))(
  "DAS charge completing inside the release tick (monke.ttr)",
  () => {
    // Regression: piece 93's right press charges DAS and the slide to the
    // wall completes within the same tick the key is released (keyup a
    // subframe after the charge). The pre-tick keyup measurement saw the
    // piece before it moved, so the press read as a tap. The real inputs:
    // DAS right to the wall (4→8), tap left back one (→7), drop.
    it("marks the press as a DAS slide", () => {
      const replay = loadReplay("monke.ttr");
      const { track } = reconstructReplay(replay);
      const p = track[93];
      expect(p.piece).toBe("o");
      expect(p.x).toBe(7);
      expect(p.inputs.map((s) => `${s.key}${s.held ? "+held" : ""}`)).toEqual([
        "moveRight+held",
        "moveLeft",
        "hardDrop",
      ]);
    });
  },
);

describe("DAS held across a hold swap", () => {
  // Regression: a hold press swaps the falling piece mid-press, so judging a
  // DAS slide from "column at keydown vs column at keyup" compares two
  // different pieces. Charging DAS at the wall, pressing hold, and releasing
  // after the swapped-in piece slid to ITS wall read as a tap — the "hold
  // DAS" hint went missing. Synthetic replay, seed 1 (bag: o j i l s t z):
  // tap O to the right wall, fresh right press there, hold-swap to J, let J
  // DAS from spawn to its wall, release, drop.
  const events = [
    { frame: 0, type: "start", data: {} },
    ...[5, 8, 11, 14].flatMap((f) => [
      { frame: f, type: "keydown", data: { key: "moveRight", subframe: 0 } },
      { frame: f + 1, type: "keyup", data: { key: "moveRight", subframe: 0 } },
    ]),
    { frame: 20, type: "keydown", data: { key: "moveRight", subframe: 0 } },
    { frame: 22, type: "keydown", data: { key: "hold", subframe: 0 } },
    { frame: 40, type: "keyup", data: { key: "moveRight", subframe: 0 } },
    { frame: 45, type: "keydown", data: { key: "hardDrop", subframe: 0 } },
    { frame: 46, type: "keyup", data: { key: "hardDrop", subframe: 0 } },
    { frame: 55, type: "end", data: {} },
  ];
  const raw = JSON.stringify({
    version: 1,
    gamemode: "40l",
    users: [{ username: "synthetic" }],
    replay: { frames: 60, events, options: { seed: 1, version: 19 } },
  });

  it("marks the press spanning the swap as a DAS hold, not a tap", () => {
    const parsed = parseReplay(raw);
    if (!parsed.ok) throw new Error(parsed.error);
    const { track } = reconstructReplay(parsed.replay);
    const p = track[0];
    // The swapped-in J really slid: it locked at the right wall out of hold.
    expect(p.piece).toBe("j");
    expect(p.wasHold).toBe(true);
    expect(p.x).toBe(7);
    const moves = p.inputs.filter((s) => s.key === "moveRight");
    expect(moves).toHaveLength(5);
    // The four positioning taps stay taps…
    expect(moves.slice(0, 4).every((s) => !s.held)).toBe(true);
    // …and the press held across the hold swap is the DAS slide.
    expect(moves[4].held).toBe(true);
  });
});

describe("Zenith replay is partially supported (promooooooo_zenith.ttr)", () => {
  it("parses and is reconstruction-supported with a partial caption", () => {
    const replay = loadReplay("promooooooo_zenith.ttr");
    expect(replay.gamemode).toBe("zenith");
    const support = checkReconstructionSupport(replay);
    expect(support.supported).toBe(true);
    expect(support.partial).toMatch(/Zenith/i);
  });
});
