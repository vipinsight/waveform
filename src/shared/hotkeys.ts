/**
 * Modifier keys that can act as a push-to-talk trigger.
 *
 * These are deliberately modifier-only: a dictation key is held down while you
 * speak, so it must not type anything on its own. macOS virtual key codes come
 * from `Carbon/HIToolbox/Events.h`; Fn is 63.
 */
export const HOTKEY_BINDINGS = [
  { id: "fn", label: "Fn", glyph: "fn", keyCode: 63 },
  { id: "right-command", label: "Right Command", glyph: "⌘", keyCode: 54 },
  { id: "left-command", label: "Left Command", glyph: "⌘", keyCode: 55 },
  { id: "right-option", label: "Right Option", glyph: "⌥", keyCode: 61 },
  { id: "left-option", label: "Left Option", glyph: "⌥", keyCode: 58 },
  { id: "right-control", label: "Right Control", glyph: "⌃", keyCode: 62 },
  { id: "right-shift", label: "Right Shift", glyph: "⇧", keyCode: 60 },
] as const;

export type HotkeyBinding = (typeof HOTKEY_BINDINGS)[number];
export type HotkeyBindingId = HotkeyBinding["id"] | "none";

export const DEFAULT_HOTKEY_ID: HotkeyBindingId = "fn";

export function isHotkeyBindingId(value: unknown): value is HotkeyBindingId {
  return value === "none" || HOTKEY_BINDINGS.some(({ id }) => id === value);
}

export function getHotkeyBinding(id: HotkeyBindingId): HotkeyBinding | null {
  return HOTKEY_BINDINGS.find((binding) => binding.id === id) ?? null;
}

export function hotkeyKeyCode(id: HotkeyBindingId): number | null {
  return getHotkeyBinding(id)?.keyCode ?? null;
}

/** Maps a raw key code seen by the native helper back to a binding, for the recorder UI. */
export function hotkeyForKeyCode(keyCode: number): HotkeyBinding | null {
  return HOTKEY_BINDINGS.find((binding) => binding.keyCode === keyCode) ?? null;
}
