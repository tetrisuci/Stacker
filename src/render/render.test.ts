import { describe, it, expect, beforeEach } from "vitest";
import { createStandardEngine, type Engine } from "../engine/adapter";
import {
  render,
  canvasSize,
  DEFAULT_LAYOUT,
  fallingBoardCells,
} from "./render";
import { colorFor, pieceOffsets, previewShape } from "./theme";

const sortCells = (cells: Array<[number, number]>) =>
  [...cells].sort((a, b) => a[0] - b[0] || a[1] - b[1]);

// A minimal CanvasRenderingContext2D stand-in that records the calls the
// renderer makes, so we can assert it draws the expected elements without a DOM.
function mockCtx() {
  const calls: {
    fillRects: number;
    strokeRects: number;
    fillTexts: string[];
    dashed: number;
  } = { fillRects: 0, strokeRects: 0, fillTexts: [], dashed: 0 };
  const ctx = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    font: "",
    textBaseline: "",
    fillRect: () => {
      calls.fillRects++;
    },
    strokeRect: () => {
      calls.strokeRects++;
    },
    fillText: (t: string) => {
      calls.fillTexts.push(t);
    },
    setLineDash: (d: number[]) => {
      if (d.length > 0) calls.dashed++;
    },
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => {},
  } as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

describe("theme helpers", () => {
  it("maps each mino to a distinct color", () => {
    const minos = ["i", "o", "t", "s", "z", "j", "l"];
    const colors = new Set(minos.map(colorFor));
    expect(colors.size).toBe(minos.length);
  });

  it("falls back to a color for unknown minos", () => {
    expect(colorFor(null)).toBeTruthy();
    expect(colorFor("???")).toBeTruthy();
  });

  it("gives 4 block offsets for every tetromino rotation", () => {
    for (const sym of ["i", "o", "t", "s", "z", "j", "l"]) {
      for (let r = 0; r < 4; r++) {
        expect(pieceOffsets(sym, r)).toHaveLength(4);
      }
    }
  });

  it("gives a 4-cell preview shape for every tetromino", () => {
    for (const sym of ["i", "o", "t", "s", "z", "j", "l"]) {
      const { cells, w, h } = previewShape(sym);
      expect(cells).toHaveLength(4);
      expect(w).toBeGreaterThan(0);
      expect(h).toBeGreaterThan(0);
    }
  });
});

describe("canvasSize", () => {
  it("scales with board width", () => {
    const a = canvasSize(DEFAULT_LAYOUT, 10);
    const b = canvasSize(DEFAULT_LAYOUT, 20);
    expect(b.width).toBeGreaterThan(a.width);
    // Height covers the playfield plus the spawn buffer rows.
    const totalRows = DEFAULT_LAYOUT.visibleRows + DEFAULT_LAYOUT.bufferRows;
    expect(a.height).toBe(totalRows * DEFAULT_LAYOUT.cell + DEFAULT_LAYOUT.gap * 2);
  });

  it("grows taller with more buffer rows", () => {
    const base = canvasSize(DEFAULT_LAYOUT, 10);
    const taller = canvasSize(
      { ...DEFAULT_LAYOUT, bufferRows: DEFAULT_LAYOUT.bufferRows + 2 },
      10,
    );
    expect(taller.height).toBe(base.height + 2 * DEFAULT_LAYOUT.cell);
  });
});

describe("render", () => {
  let engine: ReturnType<typeof createStandardEngine>;
  beforeEach(() => {
    engine = createStandardEngine({ seed: 12345 });
    engine.tick([]); // spawn a piece
  });

  it("draws without throwing and paints cells + panel labels", () => {
    const { ctx, calls } = mockCtx();
    render(ctx, engine.snapshot());
    // background + board bg + active piece cells + hold/next boxes all fill.
    expect(calls.fillRects).toBeGreaterThan(5);
    expect(calls.fillTexts).toContain("HOLD");
    expect(calls.fillTexts).toContain("NEXT");
  });

  it("draws more fill rects once a stack and garbage exist", () => {
    // Build a small stack.
    for (let i = 0; i < 5; i++) {
      engine.press("hardDrop");
      engine.tick([]);
    }
    engine.garbageQueue.receive({
      frame: engine.frame,
      amount: 4,
      size: 1,
      cid: 1,
      gameid: -1,
      confirmed: true,
    });

    const empty = mockCtx();
    const fresh = createStandardEngine({ seed: 999 });
    fresh.tick([]);
    render(empty.ctx, fresh.snapshot());

    const stacked = mockCtx();
    render(stacked.ctx, engine.snapshot());

    // A populated board + garbage bar means strictly more filled rects.
    expect(stacked.calls.fillRects).toBeGreaterThan(empty.calls.fillRects);
  });

  it("is a pure read: rendering does not advance the engine", () => {
    const before = engine.frame;
    const { ctx } = mockCtx();
    render(ctx, engine.snapshot());
    render(ctx, engine.snapshot());
    expect(engine.frame).toBe(before);
  });
});

describe("fallingBoardCells matches the engine (spawn-orientation regression)", () => {
  // The falling piece must render at exactly the cells the engine will lock,
  // i.e. equal to engine.falling.absoluteBlocks. A sign error on dy previously
  // rendered every piece vertically flipped (e.g. the S piece inverted).
  function advanceToNextPiece(engine: Engine): void {
    engine.press("hardDrop");
    engine.tick([]);
  }

  it("agrees with absoluteBlocks for the active piece across the whole first bag", () => {
    const engine = createStandardEngine({ seed: 5 });
    engine.tick([]); // spawn

    const seen = new Set<string>();
    for (let i = 0; i < 14; i++) {
      const sym = String(engine.falling.symbol);
      const rendered = sortCells(
        fallingBoardCells(engine.snapshot()),
      );
      const truth = sortCells(
        engine.falling.absoluteBlocks.map(
          ([x, y]) => [x, y] as [number, number],
        ),
      );
      expect(rendered, `piece ${sym}`).toEqual(truth);
      seen.add(sym.toLowerCase());
      advanceToNextPiece(engine);
    }
    // Make sure we actually exercised all 7 piece types, including S and Z.
    for (const p of ["i", "o", "t", "s", "z", "j", "l"]) {
      expect(seen.has(p)).toBe(true);
    }
  });

  it("agrees with absoluteBlocks after rotations", () => {
    const engine = createStandardEngine({ seed: 5 });
    engine.tick([]);
    // Skip O (rotation-invariant) so a sign error would actually show.
    if (String(engine.falling.symbol).toLowerCase() === "o") advanceToNextPiece(engine);
    for (let r = 0; r < 4; r++) {
      const rendered = sortCells(fallingBoardCells(engine.snapshot()));
      const truth = sortCells(
        engine.falling.absoluteBlocks.map(
          ([x, y]) => [x, y] as [number, number],
        ),
      );
      expect(rendered, `rotation ${r}`).toEqual(truth);
      engine.press("rotateCW");
      engine.tick([]);
    }
  });
});

describe("spawn visibility", () => {
  // The engine spawns pieces in the buffer at board rows 20–21. The renderer
  // must draw enough buffer rows above the playfield that a piece is fully
  // visible the instant it spawns — i.e. every spawn cell has y < drawnRows.
  it("keeps every spawned piece cell within the drawn area", () => {
    const drawn = DEFAULT_LAYOUT.visibleRows + DEFAULT_LAYOUT.bufferRows;
    const engine = createStandardEngine({ seed: 5 });
    engine.tick([]); // spawn

    const seen = new Set<string>();
    for (let i = 0; i < 14; i++) {
      const sym = String(engine.falling.symbol).toLowerCase();
      const cells = fallingBoardCells(engine.snapshot());
      const maxY = Math.max(...cells.map(([, y]) => y));
      expect(maxY, `piece ${sym} top row`).toBeLessThan(drawn);
      seen.add(sym);
      engine.press("hardDrop");
      engine.tick([]);
    }
    for (const p of ["i", "o", "t", "s", "z", "j", "l"]) {
      expect(seen.has(p)).toBe(true);
    }
  });

  it("default buffer is large enough for the spawn rows (>= 3)", () => {
    // Pieces occupy rows 20–22 at spawn (the O reaches row 22); playfield is
    // rows 0–19, so at least 3 buffer rows are needed to show them fully.
    expect(DEFAULT_LAYOUT.bufferRows).toBeGreaterThanOrEqual(3);
  });
});

describe("target ghost overlay", () => {
  it("draws a dashed target ghost when provided", () => {
    const engine = createStandardEngine({ seed: 5 });
    engine.tick([]);
    const withoutGhost = mockCtx();
    render(withoutGhost.ctx, engine.snapshot(), DEFAULT_LAYOUT);

    const withGhost = mockCtx();
    render(withGhost.ctx, engine.snapshot(), DEFAULT_LAYOUT, {
      targetGhost: { piece: "t", x: 4, y: 5, rotation: 0 },
    });

    // A T-piece ghost adds 4 dashed cells (each cell sets a line dash once).
    expect(withGhost.calls.dashed).toBe(withoutGhost.calls.dashed + 4);
    expect(withGhost.calls.strokeRects).toBeGreaterThan(
      withoutGhost.calls.strokeRects,
    );
  });

  it("draws nothing extra when the target ghost is null", () => {
    const engine = createStandardEngine({ seed: 5 });
    engine.tick([]);
    const a = mockCtx();
    render(a.ctx, engine.snapshot(), DEFAULT_LAYOUT);
    const b = mockCtx();
    render(b.ctx, engine.snapshot(), DEFAULT_LAYOUT, { targetGhost: null });
    expect(b.calls.dashed).toBe(a.calls.dashed);
  });

  it("draws the target and every look-ahead ghost provided", () => {
    const engine = createStandardEngine({ seed: 5 });
    engine.tick([]);
    const base = mockCtx();
    render(base.ctx, engine.snapshot(), DEFAULT_LAYOUT);

    const all = mockCtx();
    render(all.ctx, engine.snapshot(), DEFAULT_LAYOUT, {
      targetGhost: { piece: "t", x: 4, y: 5, rotation: 0 },
      nextTargetGhosts: [
        { piece: "o", x: 1, y: 5, rotation: 0 },
        { piece: "l", x: 6, y: 5, rotation: 0 },
        null, // beyond the window — skipped
      ],
    });
    // Three 4-cell ghosts (target + two look-aheads) => 12 dashed cells added.
    expect(all.calls.dashed).toBe(base.calls.dashed + 12);
  });
});
