import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, normalizeSettings } from "../src/shared/settings";
import { DEFAULT_POLISH_PROMPT } from "../src/shared/prompts";

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
    const result = normalizeSettings({ ...previous, transformOnDictate: true }, previous);
    expect(result.openRouterModel).toBe("openai/gpt-4o-mini");
    expect(result.transformOnDictate).toBe(true);
  });
});
