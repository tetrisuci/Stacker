// The key-finesse strip: keycaps for the pro's ACTUAL keydown sequence for the
// current target piece (from the replay), so the learner drills the exact
// finesse — not a shortest-path substitute. Shown below the board during a
// session when the "Show key hints" option is on. Reads the sequence from
// KeyHintsStore (pushed by the game loop when the target advances) and the
// current keymap from SettingsStore (so the caps show the player's own
// bindings), both via useSyncExternalStore.

import { useSyncExternalStore } from "react";
import type { KeyHintsStore } from "./keyHintsStore";
import type { SettingsStore } from "../settings/store";
import type { PlayerKey } from "../input/keymap";
import type { InputStep } from "../replay/reconstruct";
import { bindingsForAction } from "../settings/keyLabels";

/** A short glyph per action for the keycap face, independent of the binding. */
const ACTION_GLYPH: Record<PlayerKey, string> = {
  moveLeft: "←",
  moveRight: "→",
  softDrop: "↓",
  hardDrop: "⤓",
  rotateCW: "↻",
  rotateCCW: "↺",
  rotate180: "⤾",
  hold: "⇄",
};

/** Short caption under each cap, so the glyph is unambiguous. */
const ACTION_CAPTION: Record<PlayerKey, string> = {
  moveLeft: "left",
  moveRight: "right",
  softDrop: "soft",
  hardDrop: "drop",
  rotateCW: "cw",
  rotateCCW: "ccw",
  rotate180: "180",
  hold: "hold",
};

/** One rendered step: an action, hold/carry/keep flags, and a repeat count. */
interface Step {
  action: PlayerKey;
  /** DAS-charged move (hold to the wall) rather than a single tap. */
  held: boolean;
  /** Move already held from the previous piece — keep holding, don't re-press. */
  carried: boolean;
  /** Move held THROUGH this piece's drop into the next — don't release it. */
  keepHeld: boolean;
  count: number;
}

/**
 * Collapse consecutive identical steps into one with a count. A tap, a DAS hold,
 * a carried hold, and a keep-held hold of the same direction are all distinct and
 * never merge, so the player sees exactly which moves to tap, hold, keep holding
 * from the last piece, or keep holding into the next.
 */
function toSteps(inputs: InputStep[]): Step[] {
  const steps: Step[] = [];
  for (const s of inputs) {
    const last = steps[steps.length - 1];
    if (
      last &&
      last.action === s.key &&
      last.held === s.held &&
      last.carried === s.carried &&
      last.keepHeld === s.keepHeld
    ) {
      last.count++;
    } else {
      steps.push({
        action: s.key,
        held: s.held,
        carried: s.carried,
        keepHeld: s.keepHeld,
        count: 1,
      });
    }
  }
  return steps;
}

/** The player's bound key label for an action (first binding), or a fallback. */
function boundLabel(keymap: Record<string, string>, action: PlayerKey): string {
  const binds = bindingsForAction(keymap, action);
  return binds[0] ?? ACTION_GLYPH[action];
}

export function KeyHintsHud({
  store,
  settings,
}: {
  store: KeyHintsStore;
  settings: SettingsStore;
}) {
  const { keys } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const settingsState = useSyncExternalStore(
    settings.subscribe,
    settings.getSnapshot,
  );

  if (!keys || keys.length === 0) return null;
  const steps = toSteps(keys);

  return (
    <div
      className="key-hints"
      role="group"
      aria-label="the pro's key finesse for this piece"
    >
      <span className="key-hints-label">Pro finesse</span>
      {steps.map((step, i) => {
        // The "keep holding" continuation is only meaningful while the hold
        // *continues* — i.e. this piece also passes it on (`keepHeld`). On the
        // LAST piece of a hold chain (carried but not keepHeld) you release right
        // after it, so it isn't a keep-holding cue. But the DAS is ALREADY charged
        // coming in (held from the previous piece) — you're not fresh-holding to
        // charge it, you just let it slide and drop. Distinguish these:
        const showCarry = step.carried && step.keepHeld; // hold continues onward
        const alreadyCharged = step.carried && !step.keepHeld; // terminal carry
        // Cap face state:
        //   showCarry      — held from the last piece AND into the next ("« … »").
        //   keepHeld       — keep the key down through the drop into the next ("»").
        //                    (May be a tap on THIS piece — you keep holding so the
        //                    next piece slides — so "keep", not "hold".)
        //   alreadyCharged — DAS already active coming in; slide + drop.
        //   held           — a fresh DAS slide (hold the key to charge, then wall).
        //   tap            — a single-cell press.
        const badge = showCarry
          ? "keep"
          : step.keepHeld
            ? "keep"
            : alreadyCharged
              ? "⚡"
              : step.held
                ? "hold"
                : null;
        const caption = showCarry
          ? "keep holding"
          : step.keepHeld
            ? "don't release"
            : alreadyCharged
              ? "DAS ready"
              : step.held
                ? "DAS"
                : ACTION_CAPTION[step.action];
        const title = showCarry
          ? "held from the last piece — keep holding into the next"
          : step.keepHeld
            ? "keep this key held through the drop into the next piece"
            : alreadyCharged
              ? "DAS already charged from the last piece — just let it slide, then drop"
              : undefined;
        return (
          <span className="key-cap-wrap" key={i}>
            <span className="key-cap-row">
              <kbd
                className={`key-cap${step.held ? " held" : ""}${showCarry ? " carried" : ""}${step.keepHeld ? " keep-next" : ""}${alreadyCharged ? " charged" : ""}`}
                data-action={step.action}
              >
                <span className="key-cap-glyph">
                  {ACTION_GLYPH[step.action]}
                </span>
                <span className="key-cap-bind">
                  {badge && <span className="key-cap-hold">{badge}</span>}
                  {boundLabel(settingsState.keymap, step.action)}
                </span>
              </kbd>
              {step.count > 1 && (
                <span className="key-cap-mult">×{step.count}</span>
              )}
            </span>
            <span
              className={`key-cap-caption${step.held ? " das" : ""}`}
              title={title}
            >
              {caption}
            </span>
          </span>
        );
      })}
    </div>
  );
}
