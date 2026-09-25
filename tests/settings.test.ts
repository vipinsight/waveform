import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, normalizeSettings } from "../src/shared/settings";
import { DEFAULT_POLISH_PROMPT } from "../src/shared/prompts";

describe("DEFAULT_SETTINGS", () => {
  it("starts with the Mac, keeps the bar up, and stays out of the Dock", () => {
    expect(DEFAULT_SETTINGS.launchAtLogin).toBe(true);
    expect(DEFAULT_SETTINGS.showFlowBarAlways).toBe(true);
    expect(DEFAULT_SETTINGS.hideDockWhenClosed).toBe(true);
    // Hiding the Dock icon is ignored without the menu bar icon to return by.
    expect(DEFAULT_SETTINGS.menuBarIcon).toBe(true);
  });
});

describe("normalizeSettings", () => {
  it("falls back to defaults for an unusable file", () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings("garbage")).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps recognised values", () => {
    const result = normalizeSettings({ hotkeyId: "right-option", theme: "dark" });
    expect(result.hotkeyId).toBe("right-option");
    expect(result.theme).toBe("dark");
  });

  it("keeps the system toggles", () => {
    const result = normalizeSettings({ launchAtLogin: true, showFlowBarAlways: true });
    expect(result.launchAtLogin).toBe(true);
    expect(result.showFlowBarAlways).toBe(true);
  });

  it("checks for updates unless told not to", () => {
    // On by default, because an app nobody can update is worse than one that
    // asks. Off has to survive a reload, or the switch does nothing.
    expect(DEFAULT_SETTINGS.automaticUpdateCheck).toBe(true);
    expect(normalizeSettings({}).automaticUpdateCheck).toBe(true);
    expect(normalizeSettings({ automaticUpdateCheck: false }).automaticUpdateCheck).toBe(false);
    // Not a boolean is a corrupt file, not a decision.
    expect(normalizeSettings({ automaticUpdateCheck: "no" }).automaticUpdateCheck).toBe(true);
  });

  it("keeps a selected microphone, or an explicit system default", () => {
    const selected = normalizeSettings({
      microphoneDeviceId: "built-in-mic-id",
      microphoneDeviceName: "MacBook Pro Microphone",
    });
    expect(selected.microphoneDeviceId).toBe("built-in-mic-id");
    expect(selected.microphoneDeviceName).toBe("MacBook Pro Microphone");

    const defaulted = normalizeSettings(
      { microphoneDeviceId: "", microphoneDeviceName: "" },
      selected,
    );
    expect(defaulted.microphoneDeviceId).toBe("");
    expect(defaulted.microphoneDeviceName).toBe("");
  });

  it("rejects an unknown hotkey rather than disabling the shortcut", () => {
    expect(normalizeSettings({ hotkeyId: "f13" }).hotkeyId).toBe(
      DEFAULT_SETTINGS.hotkeyId,
    );
  });

  it("clamps timings into a usable range", () => {
    expect(normalizeSettings({ holdMs: 5 }).holdMs).toBe(120);
    expect(normalizeSettings({ holdMs: 99_999 }).holdMs).toBe(900);
    expect(normalizeSettings({ holdMs: "soon" }).holdMs).toBe(DEFAULT_SETTINGS.holdMs);
  });

  // A global accelerator is taken from every other app, so only the offered
  // combinations may be registered.
  it("only accepts polish shortcuts from the offered list", () => {
    expect(normalizeSettings({ polishShortcut: "Alt+2" }).polishShortcut).toBe("Alt+2");
    expect(normalizeSettings({ polishShortcut: "none" }).polishShortcut).toBe("none");
    expect(normalizeSettings({ polishShortcut: "Cmd+Q" }).polishShortcut).toBe(
      DEFAULT_SETTINGS.polishShortcut,
    );
    expect(normalizeSettings({ polishShortcut: "" }).polishShortcut).toBe(
      DEFAULT_SETTINGS.polishShortcut,
    );
  });

  // Polish used to mean OpenRouter and nothing else, so a settings file
  // written before this setting existed has to keep meaning that.
  it("keeps polishing where it already was for a file that predates the choice", () => {
    expect(DEFAULT_SETTINGS.polishEngine).toBe("openrouter");
    expect(normalizeSettings({}).polishEngine).toBe("openrouter");
    expect(normalizeSettings({ polishEngine: "local" }).polishEngine).toBe("local");
    expect(normalizeSettings({ polishEngine: "ollama" }).polishEngine).toBe("openrouter");
  });

  it("only accepts a local model the engine actually has", () => {
    expect(normalizeSettings({ localModelId: "qwen3-1.7b-q4" }).localModelId).toBe(
      "qwen3-1.7b-q4",
    );
    // A model from a later version, or a typed-in one: choosing it would load
    // something that is not there.
    expect(normalizeSettings({ localModelId: "gpt2-large" }).localModelId).toBe(
      DEFAULT_SETTINGS.localModelId,
    );
  });

  it("restores a prompt that was blanked out", () => {
    expect(normalizeSettings({ polishPrompt: "   " }).polishPrompt).toBe(
      DEFAULT_POLISH_PROMPT,
    );
  });

  it("keeps a custom prompt", () => {
    expect(normalizeSettings({ polishPrompt: "Make it rhyme." }).polishPrompt).toBe(
      "Make it rhyme.",
    );
  });

  it("treats null overlay coordinates as automatic placement", () => {
    const result = normalizeSettings(
      { overlayX: null, overlayY: null },
      { ...DEFAULT_SETTINGS, overlayX: 10, overlayY: 20 },
    );
    expect(result.overlayX).toBeNull();
    expect(result.overlayY).toBeNull();
  });

  it("patches over a previous value without losing the rest", () => {
    const previous = { ...DEFAULT_SETTINGS, openRouterModel: "openai/gpt-4o-mini" };
    const result = normalizeSettings({ ...previous, polishLevel: "medium" }, previous);
    expect(result.openRouterModel).toBe("openai/gpt-4o-mini");
    expect(result.polishLevel).toBe("medium");
  });

  // The level replaced an on/off switch, and a settings file written while
  // that switch existed names no level at all. Switched on, it did what Light
  // does, so anything else silently turns polish off for everyone who had it.
  it("gives a file that predates the levels the one its switch meant", () => {
    expect(normalizeSettings({ transformOnDictate: true }).polishLevel).toBe("light");
    expect(normalizeSettings({ transformOnDictate: false }).polishLevel).toBe("none");
    expect(normalizeSettings({}).polishLevel).toBe("none");
  });

  // The switch is a view of the level, so it cannot be stored against it.
  it("keeps the old switch in step with the level", () => {
    expect(normalizeSettings({ polishLevel: "none" }).transformOnDictate).toBe(false);
    expect(normalizeSettings({ polishLevel: "light" }).transformOnDictate).toBe(true);
    expect(normalizeSettings({ polishLevel: "medium" }).transformOnDictate).toBe(true);
    // A stale window sending both: the level wins.
    const conflicted = normalizeSettings({ polishLevel: "none", transformOnDictate: true });
    expect(conflicted.transformOnDictate).toBe(false);
  });

  it("rejects a level it does not have", () => {
    expect(normalizeSettings({ polishLevel: "heavy" }).polishLevel).toBe(
      DEFAULT_SETTINGS.polishLevel,
    );
  });

  // Light, not "system". The default lives twice -- here and in Rust's
  // AppSettings::default -- and the window is painted from whichever answers
  // first, so the two disagreeing would show as a flash of the wrong theme.
  it("starts a fresh install on the light theme, and leaves a stored one alone", () => {
    expect(DEFAULT_SETTINGS.theme).toBe("light");
    expect(normalizeSettings({}).theme).toBe("light");

    const rust = readFileSync("src-tauri/src/settings.rs", "utf8");
    expect(rust).toContain('theme: "light".to_string()');

    // Anybody already running keeps what they chose, including "system".
    expect(normalizeSettings({ theme: "system" }).theme).toBe("system");
    expect(normalizeSettings({ theme: "dark" }).theme).toBe("dark");
  });

  // The wizard writes this once and then never opens again, so it has to
  // survive every later write. A settings file that predates it reads as a
  // fresh install here, which is deliberate -- the window checks the lifetime
  // dictation count as well before showing anybody a first-run wizard.
  it("remembers that the first-run wizard has been through", () => {
    expect(DEFAULT_SETTINGS.onboardingCompleted).toBe(false);
    expect(normalizeSettings({}).onboardingCompleted).toBe(false);
    expect(normalizeSettings({ onboardingCompleted: true }).onboardingCompleted).toBe(true);

    const done = normalizeSettings({ onboardingCompleted: true });
    expect(normalizeSettings({ theme: "dark" }, done).onboardingCompleted).toBe(true);
    expect(normalizeSettings({ onboardingCompleted: "yes" }, done).onboardingCompleted).toBe(
      true,
    );
  });
});
