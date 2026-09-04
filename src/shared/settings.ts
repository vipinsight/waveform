import {
  DEFAULT_HOTKEY_ID,
  isHotkeyBindingId,
  type HotkeyBindingId,
} from "./hotkeys";
import {
  DEFAULT_SPEECH_MODEL_ID,
  isSpeechModelId,
  type SpeechModelId,
} from "./models";

export type ThemePreference = "system" | "light" | "dark";
export type OverlayPlacement = "bottom" | "top";

export interface AppSettings {
  modelId: SpeechModelId;
  /** Modifier key that starts dictation anywhere in macOS. */
  hotkeyId: HotkeyBindingId;
  /** Paste each finished phrase into whichever app is frontmost. */
  insertIntoFocusedApp: boolean;
  /** Press longer than this and the release ends dictation (push-to-talk). */
  holdMs: number;
  /** Two taps inside this window latch dictation on until the key is pressed again. */
  doubleTapMs: number;
  overlayPlacement: OverlayPlacement;
  /** Where the user dragged the HUD, in screen coordinates. Null means follow
      `overlayPlacement` on whichever display the pointer is on. */
  overlayX: number | null;
  overlayY: number | null;
  theme: ThemePreference;
}

export const DEFAULT_SETTINGS: AppSettings = {
  modelId: DEFAULT_SPEECH_MODEL_ID,
  hotkeyId: DEFAULT_HOTKEY_ID,
  insertIntoFocusedApp: true,
  holdMs: 300,
  doubleTapMs: 420,
  overlayPlacement: "bottom",
  overlayX: null,
  overlayY: null,
  theme: "system",
};

const HOLD_RANGE = { min: 120, max: 900 } as const;
const DOUBLE_TAP_RANGE = { min: 180, max: 900 } as const;

/**
 * Rebuilds a full settings object from arbitrary input, falling back field by
 * field. Used for both the on-disk file and renderer-supplied patches, so a
 * corrupt file or a stale renderer can never put the app into a broken state.
 */
export function normalizeSettings(
  value: unknown,
  base: AppSettings = DEFAULT_SETTINGS,
): AppSettings {
  const input = isRecord(value) ? value : {};
  return {
    modelId: isSpeechModelId(input.modelId) ? input.modelId : base.modelId,
    hotkeyId: isHotkeyBindingId(input.hotkeyId) ? input.hotkeyId : base.hotkeyId,
    insertIntoFocusedApp:
      typeof input.insertIntoFocusedApp === "boolean"
        ? input.insertIntoFocusedApp
        : base.insertIntoFocusedApp,
    holdMs: clampNumber(input.holdMs, HOLD_RANGE, base.holdMs),
    doubleTapMs: clampNumber(input.doubleTapMs, DOUBLE_TAP_RANGE, base.doubleTapMs),
    overlayPlacement:
      input.overlayPlacement === "top" || input.overlayPlacement === "bottom"
        ? input.overlayPlacement
        : base.overlayPlacement,
    overlayX: coordinate(input.overlayX, base.overlayX),
    overlayY: coordinate(input.overlayY, base.overlayY),
    theme: isThemePreference(input.theme) ? input.theme : base.theme,
  };
}

/** Screen coordinates are unbounded but must be finite; null resets to auto. */
function coordinate(value: unknown, fallback: number | null): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.round(value);
}

function clampNumber(
  value: unknown,
  range: { min: number; max: number },
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(range.max, Math.max(range.min, Math.round(value)));
}

function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
