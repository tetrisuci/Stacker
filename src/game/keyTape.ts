// Press-count history in lockstep with placements, so undo/redo move the
// "keys" stat together with the board: position n holds the count as of the
// nth lock (position 0 = game start). Undoing a placement restores the count
// to that piece's spawn; redoing restores its post-lock count. Pure — the
// trainer bootstrap drives it from engine lock events.

export class KeyTape {
  private history: number[] = [0];
  private pos = 0;

  /** A placement locked with `count` total presses. Truncates the redo tail
   * (a fresh placement invalidates redone futures, like the engine's stack). */
  record(count: number): void {
    this.pos++;
    this.history.length = this.pos;
    this.history.push(count);
  }

  /** Step back one placement; returns the restored count, or null when
   * there's nothing to undo. */
  undo(): number | null {
    if (this.pos === 0) return null;
    return this.history[--this.pos];
  }

  /** Step forward one placement; returns the restored count, or null when
   * there's nothing to redo. */
  redo(): number | null {
    if (this.pos >= this.history.length - 1) return null;
    return this.history[++this.pos];
  }

  /** New game: forget everything. */
  reset(): void {
    this.history = [0];
    this.pos = 0;
  }
}
