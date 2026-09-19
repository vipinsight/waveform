import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_POLISH_MODEL_ID,
  POLISH_MODELS,
  isPolishModelId,
} from "../src/shared/polish-models";

describe("local polish model registry", () => {
  it("offers a ladder of small instruct models and nothing else", () => {
    // Three rows, not thirty: the choice is how much memory to spend, and
    // every entry has to be instruction-tuned to follow a rewrite prompt at
    // all. A base model like GPT-2 continues the prompt instead of obeying it.
    expect(POLISH_MODELS.map(({ id }) => id)).toEqual([
      "qwen3-0.6b-q4",
      "qwen3-0.6b-q8",
      "qwen3-1.7b-q4",
    ]);
    expect(DEFAULT_POLISH_MODEL_ID).toBe("qwen3-0.6b-q4");
    expect(isPolishModelId(DEFAULT_POLISH_MODEL_ID)).toBe(true);
  });

  it("validates values loaded from settings or IPC", () => {
    expect(isPolishModelId("qwen3-1.7b-q4")).toBe(true);
    expect(isPolishModelId("gpt2")).toBe(false);
    expect(isPolishModelId(null)).toBe(false);
  });

  /**
   * The catalogue exists twice -- here and in Rust, which is what actually runs
   * it -- for the same reason the speech one does, and with the same hazard: an
   * id in one list and not the other resolves to the default at runtime, so
   * choosing it would silently load a different model.
   */
  it("holds the same ids, in the same order, as the Rust table", () => {
    const source = readFileSync("src-tauri/src/local_llm.rs", "utf8");
    const table = source.slice(
      source.indexOf("pub const LOCAL_MODELS"),
      source.indexOf("pub const DEFAULT_LOCAL_MODEL_ID"),
    );
    expect(table).not.toBe("");

    const ids = Array.from(table.matchAll(/^\s+id: "([^"]+)"/gm)).map(([, id]) => id);
    expect(ids).toEqual(POLISH_MODELS.map(({ id }) => id));

    const labels = Array.from(table.matchAll(/^\s+label: "([^"]+)"/gm)).map(([, label]) => label);
    expect(labels).toEqual(POLISH_MODELS.map(({ label }) => label));

    const rustDefault = /pub const DEFAULT_LOCAL_MODEL_ID: &str = "([^"]+)"/.exec(source)?.[1];
    expect(rustDefault).toBe(DEFAULT_POLISH_MODEL_ID);
  });
});
