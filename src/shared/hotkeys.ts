/**
 * Modifier keys that can act as a push-to-talk trigger.
 *
 * These are deliberately modifier-only: a dictation key is held down while you
 * speak, so it must not type anything on its own. macOS virtual key codes come
 * from `Carbon/HIToolbox/Events.h`; Fn is 63.
 */
/**
 * `short` is the name the HUD prints beside the glyph. Command's glyph is the
 * most recognised symbol on the keyboard and says everything the word would,
 * so it is left to speak for itself. `side` tells the HUD which way to point:
 * these keys come in pairs, and which one is meant is the whole difference.
 */
export const HOTKEY_BINDINGS = [
  { id: "fn", label: "Fn", glyph: "fn", short: "Fn", side: null, keyCode: 63 },
  { id: "right-command", label: "Right Command", glyph: "⌘", short: "", side: "right", keyCode: 54 },
  { id: "left-command", label: "Left Command", glyph: "⌘", short: "", side: "left", keyCode: 55 },
  { id: "right-option", label: "Right Option", glyph: "⌥", short: "Opt", side: "right", keyCode: 61 },
  { id: "left-option", label: "Left Option", glyph: "⌥", short: "Opt", side: "left", keyCode: 58 },
  { id: "right-control", label: "Right Control", glyph: "⌃", short: "Ctrl", side: "right", keyCode: 62 },
  { id: "right-shift", label: "Right Shift", glyph: "⇧", short: "Shift", side: "right", keyCode: 60 },
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

/**
 * The shortcut as the HUD's tooltip writes it: the glyph, then the name it is
 * usually spoken as -- "⌥ Opt". Fn is its own glyph, so it is not said twice,
 * and Command needs no word at all.
 */
export function hotkeyCaption(binding: HotkeyBinding): string {
  if (!binding.short) return binding.glyph;
  if (binding.glyph === binding.short.toLowerCase()) return binding.short;
  return `${binding.glyph} ${binding.short}`;
}

/** Points at the half of the keyboard the key is on; nothing for Fn, which is unpaired. */
export function hotkeyArrow(binding: HotkeyBinding): string {
  if (binding.side === "right") return "→";
  if (binding.side === "left") return "←";
  return "";
}

export function hotkeyKeyCode(id: HotkeyBindingId): number | null {
  return getHotkeyBinding(id)?.keyCode ?? null;
}

/** Maps a raw key code seen by the native helper back to a binding, for the recorder UI. */
export function hotkeyForKeyCode(keyCode: number): HotkeyBinding | null {
  return HOTKEY_BINDINGS.find((binding) => binding.keyCode === keyCode) ?? null;
}
