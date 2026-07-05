// A tiny observable holding the latest GameStats, so a React panel can read it
// via useSyncExternalStore while the imperative game loop pushes updates each
// frame. Updates that don't change any displayed value are coalesced so React
// only re-renders when a shown number actually changes.

import type { GameStats } from "./stats";

type Listener = () => void;

const ZERO: GameStats = { pieces: 0, pps: 0, attack: 0, apm: 0 };

/** Round rates to the precision the UI shows, so tiny jitter doesn't re-render. */
function displayEqual(a: GameStats, b: GameStats): boolean {
  return (
    a.pieces === b.pieces &&
    a.attack === b.attack &&
    a.pps.toFixed(2) === b.pps.toFixed(2) &&
    a.apm.toFixed(2) === b.apm.toFixed(2)
  );
}

export class StatsStore {
  private state: GameStats = ZERO;
  private listeners = new Set<Listener>();

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): GameStats => this.state;

  /** Push new stats; notifies subscribers only if a displayed value changed. */
  set(next: GameStats): void {
    if (displayEqual(this.state, next)) return;
    this.state = next;
    for (const l of this.listeners) l();
  }

  reset(): void {
    this.set(ZERO);
  }
}
