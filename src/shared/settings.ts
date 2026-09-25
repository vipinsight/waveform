import {
  DEFAULT_HOTKEY_ID,
  isHotkeyBindingId,
  type HotkeyBindingId,
} from "./hotkeys";
import {
  DEFAULT_SPEECH_LANGUAGE,
  isSpeechLanguage,
  type SpeechLanguageCode,
} from "./languages";
import {
  DEFAULT_SPEECH_MODEL_ID,
  isSpeechModelId,
  type SpeechModelId,
} from "./models";
import {
  DEFAULT_POLISH_LEVEL,
  isPolishLevel,
  type PolishLevel,
} from "./polish-levels";
import {
  DEFAULT_POLISH_MODEL_ID,
  isPolishModelId,
  type PolishModelId,
} from "./polish-models";
import {
  DEFAULT_OPENROUTER_MODEL,
  DEFAULT_POLISH_PROMPT,
  DEFAULT_TRANSFORM_PROMPT,
} from "./prompts";

export type ThemePreference = "system" | "light" | "dark";
/** Where a rewrite runs: a hosted model, or one downloaded onto this Mac. */
export type PolishEngine = "openrouter" | "local";
export type OverlayPlacement = "bottom" | "top";

export interface AppSettings {
  modelId: SpeechModelId;
  /** Language handed to the speech model. Empty asks it to detect. */
  speechLanguage: SpeechLanguageCode;
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

  /** Which engine both rewrite paths use. */
  polishEngine: PolishEngine;
  /** OpenRouter model id used for both rewrite paths. */
  openRouterModel: string;
  /**
   * Which downloaded model rewrites when the engine is local.
   *
   * Kept whether or not that engine is selected, so switching back does not
   * forget the choice -- and so a gigabyte already downloaded is not orphaned
   * by trying the hosted one.
   */
  localModelId: PolishModelId;
  /**
   * How much the model may change a dictation. `none` runs no model on the
   * dictation path at all.
   */
  polishLevel: PolishLevel;
  /**
   * Whether a dictation is run through the model before it is inserted.
   *
   * A view of `polishLevel`, not a setting of its own: normalization derives
   * it, so the two cannot disagree. It stays because it is the question the
   * dictation and rewrite paths actually ask, and because a settings file
   * written before levels existed carries only this.
   */
  transformOnDictate: boolean;
  /**
   * System prompt for the dictation path, at whichever level is selected.
   *
   * Choosing a level writes that level's default here, and the Instructions
   * editor overwrites it. So an edit belongs to the level that was selected
   * when it was made, and choosing a level again puts its default back.
   */
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
  /**
   * Look for a new version on launch, and once a day after that.
   *
   * The only request Waveform makes that nobody asked for. Pressing Check now
   * still checks.
   */
  automaticUpdateCheck: boolean;
  sidebarCollapsed: boolean;
  /**
   * Whether the first-run wizard has been through, or been dismissed.
   *
   * False on a fresh install, which is the only state that opens the wizard.
   * An install that has already dictated is marked done without ever seeing
   * it: this field arrived after the app did, so every existing settings file
   * reads as a fresh install, and dropping a five-page wizard in front of
   * someone mid-sentence is worse than never showing it at all.
   */
  onboardingCompleted: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  modelId: DEFAULT_SPEECH_MODEL_ID,
  speechLanguage: DEFAULT_SPEECH_LANGUAGE,
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
  // Light rather than following macOS. Only a fresh install takes this: a
  // settings file that names a theme keeps the one it names.
  theme: "light",
  // The hosted engine, because this setting arrived after the app did: a
  // settings file written before it exists takes the default, and for anyone
  // already polishing through OpenRouter that has to be what they had.
  polishEngine: "openrouter",
  openRouterModel: DEFAULT_OPENROUTER_MODEL,
  localModelId: DEFAULT_POLISH_MODEL_ID,
  polishLevel: DEFAULT_POLISH_LEVEL,
  transformOnDictate: false,
  transformPrompt: DEFAULT_TRANSFORM_PROMPT,
  polishPrompt: DEFAULT_POLISH_PROMPT,
  polishShortcut: "Alt+1",
  menuBarIcon: true,
  launchAtLogin: true,
  showFlowBarAlways: true,
  hideDockWhenClosed: true,
  automaticUpdateCheck: true,
  sidebarCollapsed: false,
  onboardingCompleted: false,
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
    speechLanguage: isSpeechLanguage(input.speechLanguage)
      ? input.speechLanguage
      : base.speechLanguage,
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
    polishEngine: isPolishEngine(input.polishEngine) ? input.polishEngine : base.polishEngine,
    openRouterModel: text(input.openRouterModel, base.openRouterModel, 200),
    localModelId: isPolishModelId(input.localModelId) ? input.localModelId : base.localModelId,
    polishLevel: polishLevel(input, base),
    // Derived, never read from the input: it is what `polishLevel` means for
    // the paths that only need to know whether a model runs.
    transformOnDictate: polishLevel(input, base) !== "none",
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
    automaticUpdateCheck:
      typeof input.automaticUpdateCheck === "boolean"
        ? input.automaticUpdateCheck
        : base.automaticUpdateCheck,
    sidebarCollapsed:
      typeof input.sidebarCollapsed === "boolean"
        ? input.sidebarCollapsed
        : base.sidebarCollapsed,
    onboardingCompleted:
      typeof input.onboardingCompleted === "boolean"
        ? input.onboardingCompleted
        : base.onboardingCompleted,
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

/**
 * The level, or the one the old on/off switch meant.
 *
 * A settings file written before levels existed names no level at all, only
 * `transformOnDictate`. Switched on, it removed filler and fixed punctuation,
 * which is the light level -- so that is what it becomes, rather than
 * everyone who had polish on losing it to the default.
 */
function polishLevel(input: Record<string, unknown>, base: AppSettings): PolishLevel {
  if (isPolishLevel(input.polishLevel)) return input.polishLevel;
  if (input.polishLevel === undefined && typeof input.transformOnDictate === "boolean") {
    return input.transformOnDictate ? "light" : "none";
  }
  return base.polishLevel;
}

function isPolishEngine(value: unknown): value is PolishEngine {
  return value === "openrouter" || value === "local";
}

function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
