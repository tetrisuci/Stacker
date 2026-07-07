// Observable holding the live "stack like the pro" comparison state, so a React
// panel can render it via useSyncExternalStore while the game loop / session
// pushes updates. Mirrors the StatsStore pattern.

import type { DivergenceState, MatchResult, WindowSummary } from "./compare";

export interface ComparisonState {
  /** True while a guided training session is active. */
  active: boolean;
  /** The replay player's username, shown in place of "the pro" (null = none). */
  proName: string | null;
  divergence: DivergenceState;
  /** The last piece's match result, or null (used for the retry prompt). */
  lastMatch: MatchResult | null;
  /** Set once the window is complete. */
  summary: WindowSummary | null;
  /**
   * How many pro placements to ghost on the learner board, starting with the
   * current target (0 = no ghosts, 1 = the current target only, 2 = also the
   * next piece, …).
   */
  lookahead: number;
  /**
   * When true, show the pro's actual key finesse for the current piece (from
   * the replay) as a keycap strip below the board.
   */
  keyHints: boolean;
}

const EMPTY: ComparisonState = {
  active: false,
  proName: null,
  divergence: { compared: 0, matched: 0, firstDivergence: null },
  lastMatch: null,
  summary: null,
  lookahead: 1,
  keyHints: false,
};

type Listener = () => void;

export class ComparisonStore {
  private state: ComparisonState = EMPTY;
  private listeners = new Set<Listener>();

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getSnapshot = (): ComparisonState => this.state;

  set(next: Partial<ComparisonState>): void {
    this.state = { ...this.state, ...next };
    for (const l of this.listeners) l();
  }

  reset(): void {
    // Preserve the display preferences (look-ahead, key hints) across sessions.
    this.state = {
      ...EMPTY,
      lookahead: this.state.lookahead,
      keyHints: this.state.keyHints,
    };
    for (const l of this.listeners) l();
  }
}
