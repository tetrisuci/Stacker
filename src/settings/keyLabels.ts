// Human-readable labels for KeyboardEvent.code values shown in the rebind UI.

const SPECIAL: Record<string, string> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Space: "Space",
  ControlLeft: "L-Ctrl",
  ControlRight: "R-Ctrl",
  ShiftLeft: "L-Shift",
  ShiftRight: "R-Shift",
  AltLeft: "L-Alt",
  AltRight: "R-Alt",
  Enter: "Enter",
  Escape: "Esc",
  Tab: "Tab",
  Backspace: "Backspace",
};

/** Turn a raw `KeyboardEvent.code` (optionally `Ctrl+`-prefixed) into a label. */
export function keyLabel(code: string): string {
  // Modifier combo, e.g. "Ctrl+KeyZ" → "Ctrl+Z".
  if (code.startsWith("Ctrl+")) return `Ctrl+${keyLabel(code.slice(5))}`;
  if (SPECIAL[code]) return SPECIAL[code];
  // KeyA → A, Digit1 → 1, Numpad5 → Num5
  const key = code.match(/^Key([A-Z])$/);
  if (key) return key[1];
  const digit = code.match(/^Digit(\d)$/);
  if (digit) return digit[1];
  const numpad = code.match(/^Numpad(\d)$/);
  if (numpad) return `Num${numpad[1]}`;
  return code;
}

/** For a given action, the codes currently bound to it, as labels. */
export function bindingsForAction(
  keymap: Record<string, string>,
  action: string,
): string[] {
  return Object.entries(keymap)
    .filter(([, a]) => a === action)
    .map(([code]) => keyLabel(code));
}
