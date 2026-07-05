// Visual constants for the Canvas 2D renderer: per-mino colors and the block
// offsets that define each tetromino's shape at a given rotation.
//
// Shape data comes straight from the engine's own `tetrominoes` table
// (`@haelp/teto/engine`), so the cells we draw for the active/ghost piece match
// exactly what the engine will lock. Each `matrix.data[rotation]` entry is a
// list of `[dx, dy, colorCode]` offsets relative to the piece's `location`.

import { tetrominoes } from "@haelp/teto/engine";

/** Fill colors keyed by the engine's lowercase mino symbols. */
export const MINO_COLORS: Record<string, string> = {
  i: "#42c8f5", // cyan
  o: "#f5d442", // yellow
  t: "#b24bf3", // purple
  s: "#4bf35f", // green
  z: "#f34b4b", // red
  j: "#4b6cf3", // blue
  l: "#f39c4b", // orange
  gb: "#7a7a7a", // garbage
  bomb: "#3a3a3a",
};

/** Fallback color for any unknown cell value. */
export const UNKNOWN_COLOR = "#9aa0a6";

export const colorFor = (mino: string | null | undefined): string =>
  (mino && MINO_COLORS[mino.toLowerCase()]) || UNKNOWN_COLOR;

/**
 * Block offsets for `symbol` at `rotation`, as `[dx, dy]` pairs relative to the
 * piece location, taken straight from the engine's rotation states. In this
 * data `dy` increases *downward* (row 0 is the top of the piece). The engine
 * maps a block to the board as `[dx + x, -dy + floor(y)]`, so callers rendering
 * the active piece must negate `dy` — see render().
 */
export function pieceOffsets(
  symbol: string,
  rotation: number,
): Array<[number, number]> {
  const data = tetrominoes[symbol.toLowerCase()];
  if (!data) return [];
  const cells = data.matrix.data[rotation] ?? data.matrix.data[0];
  return cells.map(([dx, dy]) => [dx, dy]);
}

/**
 * Preview shape for `symbol`, used for the hold box and next queue where there
 * is no live rotation state. Offsets are `[dx, dy]` in preview space, where
 * `dy` increases *downward* (row 0 on top), sized to a `w`×`h` grid.
 */
export function previewShape(symbol: string): {
  cells: Array<[number, number]>;
  w: number;
  h: number;
} {
  const data = tetrominoes[symbol.toLowerCase()];
  if (!data) return { cells: [], w: 0, h: 0 };
  return {
    cells: data.preview.data.map(([dx, dy]) => [dx, dy]),
    w: data.preview.w,
    h: data.preview.h,
  };
}
