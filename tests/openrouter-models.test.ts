import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPENROUTER_MODEL,
  SUGGESTED_MODELS,
  openRouterModelsForSelect,
} from "../src/shared/prompts";

describe("openRouterModelsForSelect", () => {
  it("lists only the suggested models when the choice is among them", () => {
    expect(openRouterModelsForSelect(DEFAULT_OPENROUTER_MODEL)).toEqual([
      ...SUGGESTED_MODELS,
    ]);
    expect(openRouterModelsForSelect(SUGGESTED_MODELS[2])).toEqual([...SUGGESTED_MODELS]);
  });

  it("adds the current custom id once when it is not suggested", () => {
    expect(openRouterModelsForSelect("openai/gpt-4o-mini")).toEqual([
      ...SUGGESTED_MODELS,
      "openai/gpt-4o-mini",
    ]);
  });

  it("never carries a previous custom beside a new one", () => {
    const first = openRouterModelsForSelect("vendor/old-custom");
    const second = openRouterModelsForSelect("vendor/new-custom");
    expect(first).toEqual([...SUGGESTED_MODELS, "vendor/old-custom"]);
    expect(second).toEqual([...SUGGESTED_MODELS, "vendor/new-custom"]);
    expect(second).not.toContain("vendor/old-custom");
  });

  it("drops the custom entry once a suggested model is selected again", () => {
    expect(openRouterModelsForSelect("vendor/custom")).toContain("vendor/custom");
    expect(openRouterModelsForSelect(DEFAULT_OPENROUTER_MODEL)).not.toContain("vendor/custom");
  });
});
