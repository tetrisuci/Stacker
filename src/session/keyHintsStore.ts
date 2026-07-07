// Observable holding the pro's key-finesse sequence for the current target
// piece, so the KeyHintsHud can render it via useSyncExternalStore while the
// game loop pushes the sequence for whichever piece is the current target.
// Kept separate from the ComparisonStore so the per-frame set() churn (dedup'd
// below) doesn't re-render the comparison panel. Mirrors the StatsStore pattern.

import type { InputStep } from "../replay/reconstruct";

export interface KeyHintsState {
  /** The pro's ordered finesse steps, or null when hints are off / unavailable. */
  keys: InputStep[] | null;
}

type Listener = () => void;

export class KeyHintsStore {
  private state: KeyHintsState = { keys: null };
  private listeners = new Set<Listener>();

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getSnapshot = (): KeyHintsState => this.state;

  /**
   * Push a new hint sequence. Skips notifying listeners when the sequence is
   * unchanged (same steps), so a steady hint doesn't re-render the HUD every
   * frame — only a change (the target piece advancing) does.
   */
  set(keys: InputStep[] | null): void {
    if (sameKeys(this.state.keys, keys)) return;
    this.state = { keys };
    for (const l of this.listeners) l();
  }
}

function sameKeys(a: InputStep[] | null, b: InputStep[] | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].key !== b[i].key ||
      a[i].held !== b[i].held ||
      a[i].carried !== b[i].carried ||
      a[i].keepHeld !== b[i].keepHeld
    ) {
      return false;
    }
  }
  return true;
}
