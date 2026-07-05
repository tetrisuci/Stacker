// Canvas 2D renderer for an engine `snapshot()`.
//
// `render(ctx, snapshot)` draws, into the given 2D context:
//   • the visible board with locked cells (colored per mino)
//   • the active falling piece and its hard-drop ghost
//   • the hold box
//   • the next-5 queue
//   • an incoming-garbage bar down the left edge, sized from garbageQueue
//
// It is a pure function of the snapshot (plus optional layout) — no engine
// mutation, no input. Coordinates: the engine stores the board bottom-up
// (`board[0]` is the bottom row) with a 20-row spawn buffer above the visible
// rows. Falling-piece block offsets have `dy` increasing *downward*; the engine
// places a block at `[dx + floor(x), -dy + floor(y)]`, which fallingBoardCells
// reproduces so the drawn piece matches exactly where the engine will lock it.

import type { EngineSnapshot } from "../engine/adapter";
import {
  garbageIndicator,
  DEFAULT_GARBAGE_CONFIG,
  type GarbageConfig,
} from "./garbage";
import { colorFor, pieceOffsets, previewShape } from "./theme";

/** The engine's floored piece anchor: `[floor(x), floor(y)]`. */
export function fallingBase(location: readonly [number, number]): [number, number] {
  return [Math.floor(location[0]), Math.floor(location[1])];
}

/**
 * Board cells occupied by the falling piece of `snapshot`, as `[x, y]` pairs in
 * the engine's bottom-up coordinates. Mirrors `Tetromino.absoluteBlocks`
 * (`[dx + floor(x), -dy + floor(y)]`) so rendering and the engine agree.
 */
export function fallingBoardCells(
  snapshot: EngineSnapshot,
): Array<[number, number]> {
  const falling = snapshot.falling;
  if (!falling || !falling.symbol) return [];
  const offsets = pieceOffsets(String(falling.symbol), falling.rotation);
  const [baseX, baseY] = fallingBase(falling.location);
  return offsets.map(([dx, dy]) => [baseX + dx, baseY - dy]);
}

export interface RenderLayout {
  /** Side length of one board cell, in pixels. */
  cell: number;
  /** Number of visible playfield rows (the standard 20). */
  visibleRows: number;
  /**
   * Extra rows drawn *above* the playfield so freshly spawned pieces (which the
   * engine places in the buffer at rows 20–21) are fully visible on spawn.
   */
  bufferRows: number;
  /** Gap between the board and the side panels, in pixels. */
  gap: number;
  /** Width of the incoming-garbage bar, in pixels. */
  garbageBarWidth: number;
  /** Garbage telegraph config (frames to fully charge). */
  garbage?: GarbageConfig;
}

export const DEFAULT_LAYOUT: RenderLayout = {
  cell: 28,
  visibleRows: 20,
  // Pieces spawn in the buffer at board rows 20–22 (the O piece reaches row 22),
  // so 3 buffer rows make any freshly spawned piece fully visible.
  bufferRows: 3,
  gap: 12,
  garbageBarWidth: 12,
  garbage: DEFAULT_GARBAGE_CONFIG,
};

/** Total rows drawn on the canvas: the playfield plus the spawn buffer. */
const drawnRows = (layout: RenderLayout): number =>
  layout.visibleRows + layout.bufferRows;

const COLORS = {
  background: "#0e1116",
  boardBg: "#161b22",
  grid: "#222933",
  panelBg: "#161b22",
  panelBorder: "#2b3240",
  ghost: "rgba(255,255,255,0.22)",
  text: "#c9d1d9",
  garbageBarBg: "#2b3240",
  // Confirmed & charging garbage (solid red) vs. charging telegraph (amber),
  // matching TETR.IO's incoming-garbage bar which reddens as garbage charges.
  garbageCharged: "#f34b4b",
  garbageCharging: "#f5a742",
  garbageSep: "#0e1116",
  // Target ghost: the pro's upcoming placement outlined for the learner to copy.
  target: "#4bf3d6",
  targetFill: "rgba(75,243,214,0.14)",
  // Dimmer look-ahead ghost for the piece one ahead of the current target.
  targetDim: "rgba(75,243,214,0.45)",
  targetFillDim: "rgba(75,243,214,0.05)",
} as const;

/** Width of a hold/next preview column, in pixels. */
const panelWidth = (layout: RenderLayout) => 5 * layout.cell;

/**
 * Horizontal layout metrics for the whole scene, left to right:
 *   [ HOLD panel ][ gap ][ garbage bar ][ gap ][ board ][ gap ][ NEXT panel ]
 * The board sits in the middle with HOLD on the left and NEXT on the right,
 * matching TETR.IO's layout.
 */
function layoutMetrics(layout: RenderLayout, cols: number) {
  const panelW = panelWidth(layout);
  const boardW = cols * layout.cell;
  const holdX = layout.gap;
  const garbageX = holdX + panelW + layout.gap;
  const boardX = garbageX + layout.garbageBarWidth + layout.gap;
  const nextX = boardX + boardW + layout.gap;
  const width = nextX + panelW + layout.gap;
  return { panelW, boardW, holdX, garbageX, boardX, nextX, width };
}

/**
 * Overall pixel size of the canvas needed for a given layout and board width.
 * Defaults to the standard 10-wide board.
 */
export function canvasSize(
  layout: RenderLayout = DEFAULT_LAYOUT,
  cols = 10,
): { width: number; height: number } {
  const { width } = layoutMetrics(layout, cols);
  const height = drawnRows(layout) * layout.cell + layout.gap * 2;
  return { width, height };
}

function drawCell(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  size: number,
  fill: string,
  opts: { ghost?: boolean } = {},
): void {
  const inset = 1;
  if (opts.ghost) {
    ctx.strokeStyle = fill;
    ctx.lineWidth = 2;
    ctx.strokeRect(px + inset, py + inset, size - inset * 2, size - inset * 2);
    return;
  }
  ctx.fillStyle = fill;
  ctx.fillRect(px + inset, py + inset, size - inset * 2, size - inset * 2);
  // subtle top highlight for a beveled look
  ctx.fillStyle = "rgba(255,255,255,0.15)";
  ctx.fillRect(px + inset, py + inset, size - inset * 2, Math.max(2, size * 0.12));
}

/**
 * Draw a target-ghost cell: a filled tint with a dashed outline. `dim` draws the
 * look-ahead (next piece) ghost more faintly than the current target.
 */
function drawTargetCell(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  size: number,
  dim = false,
): void {
  const inset = 1;
  ctx.fillStyle = dim ? COLORS.targetFillDim : COLORS.targetFill;
  ctx.fillRect(px + inset, py + inset, size - inset * 2, size - inset * 2);
  ctx.strokeStyle = dim ? COLORS.targetDim : COLORS.target;
  ctx.lineWidth = dim ? 1 : 2;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(px + inset, py + inset, size - inset * 2, size - inset * 2);
  ctx.setLineDash([]);
}

/** The pro's upcoming placement, drawn as a target ghost on the learner board. */
export interface TargetGhost {
  /** Lowercase mino symbol. */
  piece: string;
  /** Anchor column/row (board coords) and rotation, matching the engine. */
  x: number;
  y: number;
  rotation: number;
}

export interface RenderOverlay {
  /** Draw this placement outlined as the "stack like the pro" target. */
  targetGhost?: TargetGhost | null;
  /**
   * The pro's placements *ahead* of the current target (index 0 is one piece
   * ahead, index 1 two ahead, …), drawn dimmer — and progressively fainter the
   * further ahead they are — so the learner can see where upcoming pieces go.
   */
  nextTargetGhosts?: ReadonlyArray<TargetGhost | null>;
}

/**
 * Render the snapshot into `ctx`. `layout` is optional; the caller is
 * responsible for sizing the canvas (see {@link canvasSize}). `overlay` draws
 * extra guidance (e.g. the pro's target ghost) on top of the board.
 */
export function render(
  ctx: CanvasRenderingContext2D,
  snapshot: EngineSnapshot,
  layout: RenderLayout = DEFAULT_LAYOUT,
  overlay?: RenderOverlay,
): void {
  const { cell, gap, visibleRows, bufferRows } = layout;
  const board = snapshot.board;
  const totalRows = board.length; // visible + engine buffer
  const cols = board[0]?.length ?? 10;

  // Total rows drawn = the 20 playfield rows plus a spawn buffer *above* the
  // framed playfield. The frame (background + grid + border) covers only the
  // playfield; the buffer rows render as open space above it, so a spawning
  // piece floats above the top edge exactly like in TETR.IO.
  const rows = drawnRows(layout);

  const metrics = layoutMetrics(layout, cols);
  const boardX = metrics.boardX;
  const boardY = gap; // top of the whole drawn area (incl. spawn buffer)
  const boardPxW = metrics.boardW;
  // The framed playfield sits below the buffer rows.
  const playfieldY = boardY + bufferRows * cell;
  const playfieldPxH = visibleRows * cell;

  // Map a board coordinate (x across, y bottom-up incl. buffer) to canvas px.
  // Row `y` is drawn when `y < rows`, measured from the bottom of the playfield.
  const cellPx = (x: number, y: number): [number, number] => [
    boardX + x * cell,
    boardY + (rows - 1 - y) * cell,
  ];

  // ---- background ----
  const size = canvasSize(layout, cols);
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, size.width, size.height);

  // ---- playfield background + grid (20 rows only; buffer stays open above) ----
  ctx.fillStyle = COLORS.boardBg;
  ctx.fillRect(boardX, playfieldY, boardPxW, playfieldPxH);
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let c = 0; c <= cols; c++) {
    const x = boardX + c * cell + 0.5;
    ctx.moveTo(x, playfieldY);
    ctx.lineTo(x, playfieldY + playfieldPxH);
  }
  for (let r = 0; r <= visibleRows; r++) {
    const y = playfieldY + r * cell + 0.5;
    ctx.moveTo(boardX, y);
    ctx.lineTo(boardX + boardPxW, y);
  }
  ctx.stroke();

  // ---- locked cells ----
  for (let y = 0; y < Math.min(rows, totalRows); y++) {
    const row = board[y];
    for (let x = 0; x < cols; x++) {
      const tile = row[x];
      if (!tile) continue;
      const [px, py] = cellPx(x, y);
      drawCell(ctx, px, py, cell, colorFor(tile.mino));
    }
  }

  // ---- ghost piece (hard-drop landing) then active piece ----
  const falling = snapshot.falling;
  if (falling && falling.symbol) {
    const offsets = pieceOffsets(String(falling.symbol), falling.rotation);
    const [baseX, baseY] = fallingBase(falling.location);

    const ghostDrop = hardDropDistance(board, offsets, baseX, baseY);
    // ghost first (so the active piece draws on top if they overlap)
    for (const [dx, dy] of offsets) {
      const gy = baseY - dy - ghostDrop;
      if (gy < rows) {
        const [px, py] = cellPx(baseX + dx, gy);
        drawCell(ctx, px, py, cell, COLORS.ghost, { ghost: true });
      }
    }
    const fill = colorFor(String(falling.symbol));
    for (const [dx, dy] of offsets) {
      const y = baseY - dy;
      if (y < rows && y >= 0) {
        const [px, py] = cellPx(baseX + dx, y);
        drawCell(ctx, px, py, cell, fill);
      }
    }
  }

  // ---- target ghosts (the pro's upcoming placement, + optional look-ahead) ----
  const drawGhost = (ghost: TargetGhost | null | undefined, dim: boolean) => {
    if (!ghost || !ghost.piece) return;
    for (const [dx, dy] of pieceOffsets(ghost.piece, ghost.rotation)) {
      const x = ghost.x + dx;
      const y = ghost.y - dy;
      if (y < rows && y >= 0 && x >= 0 && x < cols) {
        const [px, py] = cellPx(x, y);
        drawTargetCell(ctx, px, py, cell, dim);
      }
    }
  };
  // Look-aheads first, deepest-first and progressively fainter, so nearer
  // ghosts (and finally the current target) draw on top where they overlap.
  const lookaheads = overlay?.nextTargetGhosts ?? [];
  for (let i = lookaheads.length - 1; i >= 0; i--) {
    ctx.globalAlpha = Math.max(0.3, 1 - 0.25 * i);
    drawGhost(lookaheads[i], true);
  }
  ctx.globalAlpha = 1;
  drawGhost(overlay?.targetGhost, false);

  // ---- incoming-garbage bar (aligned to the playfield, left of the board) ----
  drawGarbageBar(ctx, snapshot, layout, metrics.garbageX, playfieldY, playfieldPxH);

  // ---- HOLD panel (left) and NEXT panel (right), aligned to the playfield ----
  drawHoldPanel(ctx, snapshot, layout, metrics.holdX, playfieldY);
  drawNextPanel(ctx, snapshot, layout, metrics.nextX, playfieldY);
}

/** How far the piece can hard-drop before colliding, in rows (y decreasing). */
function hardDropDistance(
  board: EngineSnapshot["board"],
  offsets: Array<[number, number]>,
  baseX: number,
  baseY: number,
): number {
  let drop = 0;
  const cols = board[0]?.length ?? 10;
  const collides = (dropBy: number): boolean => {
    for (const [dx, dy] of offsets) {
      const x = baseX + dx;
      // dy is negated to match the engine's board coordinates (see render()).
      const y = baseY - dy - dropBy;
      if (y < 0) return true; // hit floor
      if (x < 0 || x >= cols) return true;
      if (board[y]?.[x]) return true; // hit a locked cell
    }
    return false;
  };
  while (!collides(drop + 1)) drop++;
  return drop;
}

function drawGarbageBar(
  ctx: CanvasRenderingContext2D,
  snapshot: EngineSnapshot,
  layout: RenderLayout,
  barX: number,
  boardY: number,
  boardPxH: number,
): void {
  const barW = layout.garbageBarWidth;
  ctx.fillStyle = COLORS.garbageBarBg;
  ctx.fillRect(barX, boardY, barW, boardPxH);

  const config: GarbageConfig = layout.garbage ?? DEFAULT_GARBAGE_CONFIG;
  const { segments } = garbageIndicator(snapshot, config);
  if (segments.length === 0) return;

  const cell = layout.cell;
  const barBottom = boardY + boardPxH;
  // Stack segments from the bottom up, oldest (front of the queue) at the bottom
  // since it will be tanked first.
  let linesFromBottom = 0;
  for (const seg of segments) {
    const segTop = barBottom - (linesFromBottom + seg.amount) * cell;
    const segH = seg.amount * cell;
    // Charged garbage is solid red; still-charging telegraphs as amber, with the
    // charged fraction filling in red from the bottom of the segment.
    const charged = seg.confirmed && seg.charge >= 1;
    if (charged) {
      ctx.fillStyle = COLORS.garbageCharged;
      ctx.fillRect(barX, segTop, barW, segH);
    } else {
      ctx.fillStyle = COLORS.garbageCharging;
      ctx.fillRect(barX, segTop, barW, segH);
      const chargedH = segH * seg.charge;
      if (chargedH > 0) {
        ctx.fillStyle = COLORS.garbageCharged;
        ctx.fillRect(barX, segTop + segH - chargedH, barW, chargedH);
      }
    }
    // Thin separator between segments so distinct attacks read individually.
    ctx.fillStyle = COLORS.garbageSep;
    ctx.fillRect(barX, segTop, barW, 1);
    linesFromBottom += seg.amount;
  }
}

function panelLabel(
  ctx: CanvasRenderingContext2D,
  cell: number,
  text: string,
  x: number,
  y: number,
): void {
  ctx.fillStyle = COLORS.text;
  ctx.font = `${Math.round(cell * 0.5)}px system-ui, sans-serif`;
  ctx.textBaseline = "top";
  ctx.fillText(text, x, y);
}

/** HOLD panel: a labelled box on the left of the board showing the held piece. */
function drawHoldPanel(
  ctx: CanvasRenderingContext2D,
  snapshot: EngineSnapshot,
  layout: RenderLayout,
  panelX: number,
  panelY: number,
): void {
  const { cell } = layout;
  const boxW = 4.5 * cell;
  const previewCell = cell * 0.7;
  const boxH = cell * 2.4;

  let y = panelY;
  panelLabel(ctx, cell, "HOLD", panelX, y);
  y += cell * 0.6;
  drawPanelBox(ctx, panelX, y, boxW, boxH);
  if (snapshot.hold) {
    drawPreviewPiece(ctx, String(snapshot.hold), panelX, y, boxW, boxH, previewCell);
  }
}

/** NEXT panel: the first five upcoming pieces on the right of the board. */
function drawNextPanel(
  ctx: CanvasRenderingContext2D,
  snapshot: EngineSnapshot,
  layout: RenderLayout,
  panelX: number,
  panelY: number,
): void {
  const { cell } = layout;
  const boxW = 4.5 * cell;
  const previewCell = cell * 0.7;
  const slotH = cell * 2.4;

  let y = panelY;
  panelLabel(ctx, cell, "NEXT", panelX, y);
  y += cell * 0.6;
  const next = (snapshot.queue?.value ?? []).slice(0, 5);
  for (const sym of next) {
    drawPanelBox(ctx, panelX, y, boxW, slotH);
    drawPreviewPiece(ctx, String(sym), panelX, y, boxW, slotH, previewCell);
    y += slotH + cell * 0.2;
  }
}

function drawPanelBox(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  ctx.fillStyle = COLORS.panelBg;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = COLORS.panelBorder;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
}

/** Draw a mino centered inside a box using its preview (spawn) shape. */
function drawPreviewPiece(
  ctx: CanvasRenderingContext2D,
  symbol: string,
  boxX: number,
  boxY: number,
  boxW: number,
  boxH: number,
  cell: number,
): void {
  const { cells, w, h } = previewShape(symbol);
  if (cells.length === 0) return;
  const pieceW = w * cell;
  const pieceH = h * cell;
  const originX = boxX + (boxW - pieceW) / 2;
  const originY = boxY + (boxH - pieceH) / 2;
  const fill = colorFor(symbol);
  for (const [dx, dy] of cells) {
    drawCell(ctx, originX + dx * cell, originY + dy * cell, cell, fill);
  }
}
