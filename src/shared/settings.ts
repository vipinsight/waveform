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
import {
  DEFAULT_OPENROUTER_MODEL,
  DEFAULT_POLISH_PROMPT,
  DEFAULT_TRANSFORM_PROMPT,
} from "./prompts";

export type ThemePreference = "system" | "light" | "dark";
export type OverlayPlacement = "bottom" | "top";

export interface AppSettings {
  modelId: SpeechModelId;
  /** Empty means let macOS choose its current default input. */
  microphoneDeviceId: string;
  /** Last readable device label, used by the menu bar while the window is hidden. */
  microphoneDeviceName: string;
  /** Modifier key that starts dictation anywhere in macOS. */
  hotkeyId: HotkeyBindingId;
  /** Press longer than this and the release ends dictation (push-to-talk). */
  holdMs: number;
  /** Two taps inside this window latch dictation on until the key is pressed again. */
  doubleTapMs: number;
  overlayPlacement: OverlayPlacement;
  /** Where the user dragged the HUD, in screen coordinates. Null means follow
      `overlayPlacement` on whichever display the pointer is on. */
  overlayX: number | null;
  overlayY: number | null;
  /** Where the pill's centre sat inside its window when the position above was
      recorded, so the window can grow around the pill without moving it. */
  overlayCx: number | null;
  overlayCy: number | null;
  theme: ThemePreference;

  /** OpenRouter model id used for both rewrite paths. */
  openRouterModel: string;
  /** Run every dictated phrase through the model before inserting it. */
  transformOnDictate: boolean;
  /** System prompt for the dictation cleanup path. */
  transformPrompt: string;
  /** System prompt for the polish shortcut. */
  polishPrompt: string;
  /** Electron accelerator that polishes the current selection, or "none". */
  polishShortcut: string;
  /** Show a menu bar icon. */
  menuBarIcon: boolean;
  /** Start Waveform when this Mac's user signs in. */
  launchAtLogin: boolean;
  /** Keep the compact listening indicator visible while idle. */
  showFlowBarAlways: boolean;
  /** Leave the Dock while the window is closed; needs `menuBarIcon`. */
  hideDockWhenClosed: boolean;
  /** Fold the sidebar away. Kept here so it survives a restart. */
  sidebarCollapsed: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  modelId: DEFAULT_SPEECH_MODEL_ID,
  microphoneDeviceId: "",
  microphoneDeviceName: "",
  hotkeyId: DEFAULT_HOTKEY_ID,
  holdMs: 300,
  doubleTapMs: 420,
  overlayPlacement: "bottom",
  overlayX: null,
  overlayY: null,
  overlayCx: null,
  overlayCy: null,
  theme: "system",
  openRouterModel: DEFAULT_OPENROUTER_MODEL,
  transformOnDictate: false,
  transformPrompt: DEFAULT_TRANSFORM_PROMPT,
  polishPrompt: DEFAULT_POLISH_PROMPT,
  polishShortcut: "Alt+1",
  menuBarIcon: true,
  launchAtLogin: false,
  showFlowBarAlways: false,
  hideDockWhenClosed: false,
  sidebarCollapsed: false,
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
    microphoneDeviceId: optionalText(input.microphoneDeviceId, base.microphoneDeviceId, 1_024),
    microphoneDeviceName: optionalText(input.microphoneDeviceName, base.microphoneDeviceName, 200),
    hotkeyId: isHotkeyBindingId(input.hotkeyId) ? input.hotkeyId : base.hotkeyId,
    holdMs: clampNumber(input.holdMs, HOLD_RANGE, base.holdMs),
    doubleTapMs: clampNumber(input.doubleTapMs, DOUBLE_TAP_RANGE, base.doubleTapMs),
    overlayPlacement:
      input.overlayPlacement === "top" || input.overlayPlacement === "bottom"
        ? input.overlayPlacement
        : base.overlayPlacement,
    overlayX: coordinate(input.overlayX, base.overlayX),
    overlayY: coordinate(input.overlayY, base.overlayY),
    overlayCx: coordinate(input.overlayCx, base.overlayCx),
    overlayCy: coordinate(input.overlayCy, base.overlayCy),
    theme: isThemePreference(input.theme) ? input.theme : base.theme,
    openRouterModel: text(input.openRouterModel, base.openRouterModel, 200),
    transformOnDictate:
      typeof input.transformOnDictate === "boolean"
        ? input.transformOnDictate
        : base.transformOnDictate,
    transformPrompt: text(input.transformPrompt, base.transformPrompt, 8_000),
    polishPrompt: text(input.polishPrompt, base.polishPrompt, 8_000),
    polishShortcut: isAccelerator(input.polishShortcut)
      ? input.polishShortcut
      : base.polishShortcut,
    menuBarIcon:
      typeof input.menuBarIcon === "boolean" ? input.menuBarIcon : base.menuBarIcon,
    launchAtLogin:
      typeof input.launchAtLogin === "boolean" ? input.launchAtLogin : base.launchAtLogin,
    showFlowBarAlways:
      typeof input.showFlowBarAlways === "boolean"
        ? input.showFlowBarAlways
        : base.showFlowBarAlways,
    hideDockWhenClosed:
      typeof input.hideDockWhenClosed === "boolean"
        ? input.hideDockWhenClosed
        : base.hideDockWhenClosed,
    sidebarCollapsed:
      typeof input.sidebarCollapsed === "boolean"
        ? input.sidebarCollapsed
        : base.sidebarCollapsed,
  };
}

/** Trims and length-caps free text; blank falls back so a field cannot be lost. */
function text(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return trimmed.slice(0, maxLength);
}

/** Unlike prompts, an empty microphone id is meaningful: it selects system default. */
function optionalText(value: unknown, fallback: string, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : fallback;
}

/**
 * Accepts only the accelerators we offer, plus "none".
 *
 * These are registered globally, so an arbitrary string could quietly steal a
 * system-wide key combination from every other app.
 */
export const POLISH_SHORTCUTS = ["none", "Alt+1", "Alt+2", "Alt+3", "Alt+P"] as const;

function isAccelerator(value: unknown): value is string {
  return typeof value === "string" && POLISH_SHORTCUTS.includes(value as never);
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
