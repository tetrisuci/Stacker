// Keyboard → engine input bridge.
//
// Listens for raw DOM key events, maps them to logical engine actions via a
// keymap, and buffers keydown/keyup *transitions* in order. The game loop drains
// this buffer each logic frame and feeds the transitions to `engine.tick()` as
// `{ type, data: { key, subframe }, frame }` events, so the engine's own
// handling (DAS/ARR/DCD/SDF) governs movement — we never simulate repeat.
//
// OS key-repeat is ignored: a physical key produces exactly one keydown until
// it is released (tracked in `held`), matching how the engine expects input.

import type { ActionKey, AppKey, PlayerKey } from "./keymap";
import { DEFAULT_KEYMAP, comboCode, isPlayerKey } from "./keymap";

export type InputTransition = {
  type: "keydown" | "keyup";
  key: PlayerKey;
};

export interface KeyboardSourceOptions {
  keymap?: Record<string, ActionKey>;
  /** Element to listen on. Defaults to `window`. */
  target?: Window | HTMLElement;
  /**
   * Called when a non-gameplay app action (e.g. "restart") is pressed. App
   * actions are NOT buffered into the engine input stream.
   */
  onAppKey?: (key: AppKey) => void;
}

export class KeyboardSource {
  private keymap: Record<string, ActionKey>;
  private target: Window | HTMLElement;
  private onAppKey?: (key: AppKey) => void;
  private held = new Set<string>();
  private buffer: InputTransition[] = [];
  private attached = false;
  /** Gameplay keydowns since attach (or the last reset) — the "keys" stat.
   * App actions and OS auto-repeat don't count, matching TETR.IO's counter. */
  pressCount = 0;

  constructor(options: KeyboardSourceOptions = {}) {
    this.keymap = options.keymap ?? DEFAULT_KEYMAP;
    this.target = options.target ?? window;
    this.onAppKey = options.onAppKey;
  }

  attach(): void {
    if (this.attached) return;
    this.target.addEventListener("keydown", this.onKeyDown as EventListener);
    this.target.addEventListener("keyup", this.onKeyUp as EventListener);
    // Release everything if focus is lost, so no key gets stuck held.
    window.addEventListener("blur", this.onBlur);
    this.attached = true;
  }

  detach(): void {
    if (!this.attached) return;
    this.target.removeEventListener("keydown", this.onKeyDown as EventListener);
    this.target.removeEventListener("keyup", this.onKeyUp as EventListener);
    window.removeEventListener("blur", this.onBlur);
    this.attached = false;
    this.held.clear();
    this.buffer.length = 0;
  }

  /** Swap the active keymap (e.g. after a rebind). Takes effect immediately. */
  setKeymap(keymap: Record<string, ActionKey>): void {
    this.keymap = keymap;
  }

  /** Zero the press counter (a new game starts a new count). */
  resetPressCount(): void {
    this.pressCount = 0;
  }

  /** Take and clear all buffered transitions (in press/release order). */
  drain(): InputTransition[] {
    if (this.buffer.length === 0) return [];
    const out = this.buffer;
    this.buffer = [];
    return out;
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    // Prefer a Ctrl+ combo binding (e.g. Ctrl+Z undo) over the plain-key one.
    const action = this.keymap[comboCode(e)] ?? this.keymap[e.code];
    if (!action) return;
    e.preventDefault(); // stop page scroll on arrows/space, browser undo, etc.
    if (e.repeat || this.held.has(e.code)) return; // ignore OS auto-repeat
    this.held.add(e.code);
    if (isPlayerKey(action)) {
      this.buffer.push({ type: "keydown", key: action });
      this.pressCount++;
    } else {
      // App action (restart/undo/redo): fire immediately, never enters the engine.
      this.onAppKey?.(action);
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    // Match keydown's resolution; on release the modifier may already be gone,
    // so fall back to the plain code (which is what we tracked in `held`).
    const action = this.keymap[comboCode(e)] ?? this.keymap[e.code];
    if (!action) return;
    e.preventDefault();
    if (!this.held.has(e.code)) return;
    this.held.delete(e.code);
    // Only gameplay keys have a matching keyup transition in the engine stream.
    if (isPlayerKey(action)) {
      this.buffer.push({ type: "keyup", key: action });
    }
  };

  private onBlur = (): void => {
    // Emit keyup for every currently-held gameplay key so the engine doesn't
    // keep DASing after focus loss.
    for (const code of this.held) {
      const action = this.keymap[code];
      if (action && isPlayerKey(action)) {
        this.buffer.push({ type: "keyup", key: action });
      }
    }
    this.held.clear();
  };
}
