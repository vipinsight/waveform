import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LADDER_INDEX,
  DEFAULT_LADDER_MODEL_ID,
  MODEL_LADDER,
  chooseModel,
  ladderIndexOf,
  ladderRung,
} from "../src/shared/model-ladder";
import { getSpeechModel } from "../src/shared/models";
import type { ModelFit } from "../src/shared/contracts";

/**
 * The ladder makes claims -- faster, more accurate -- about models whose error
 * rates and memory live in Rust. Nothing else compares the two, so a rung
 * reordered here would quietly tell a first run that the slower model is the
 * fast one.
 */
const rust = readFileSync("src-tauri/src/model_server.rs", "utf8");

function factOf(id: string, field: "wer" | "memory_mb"): number {
  const entry = rust.slice(rust.indexOf(`id: "${id}"`));
  const pattern =
    field === "wer" ? /wer: Some\(([\d.]+)\)/ : /memory_mb: ([\d_]+)/;
  const found = entry.match(pattern);
  if (!found) throw new Error(`No ${field} for ${id}`);
  return Number(found[1]!.replace(/_/g, ""));
}

const nothingKnown = (): ModelFit | null => null;
const everythingFits = (): ModelFit => "comfortable";

describe("the speed/accuracy ladder", () => {
  it("offers only models the app can fetch by itself", () => {
    // Parakeet and Qwen need Python installed first. A first run that picked
    // one would download nothing and fail on the first phrase.
    for (const rung of MODEL_LADDER) {
      expect(getSpeechModel(rung.id).engine).toBe("whisper-cpp");
    }
    expect(new Set(MODEL_LADDER.map((rung) => rung.id)).size).toBe(MODEL_LADDER.length);
  });

  it("climbs in accuracy and in memory together, which is the trade it names", () => {
    for (let at = 1; at < MODEL_LADDER.length; at += 1) {
      const below = MODEL_LADDER[at - 1]!.id;
      const above = MODEL_LADDER[at]!.id;
      // Lower WER is better, so accuracy rising means this falling.
      expect(factOf(above, "wer")).toBeLessThan(factOf(below, "wer"));
      expect(factOf(above, "memory_mb")).toBeGreaterThan(factOf(below, "memory_mb"));
    }
  });

  it("starts on Large v3 Turbo, and offers it as the escape hatch too", () => {
    expect(DEFAULT_LADDER_MODEL_ID).toBe("whisper-cpp-large-v3-turbo-q5");
    expect(ladderRung(DEFAULT_LADDER_INDEX).id).toBe(DEFAULT_LADDER_MODEL_ID);
    expect(ladderIndexOf(DEFAULT_LADDER_MODEL_ID)).toBe(DEFAULT_LADDER_INDEX);
    // The rung where the curve flattens: within a tenth of a percent of the
    // most accurate model on the ladder, for a third less memory.
    const best = MODEL_LADDER[MODEL_LADDER.length - 1]!.id;
    expect(factOf(DEFAULT_LADDER_MODEL_ID, "wer") - factOf(best, "wer")).toBeLessThan(0.1);
    expect(factOf(DEFAULT_LADDER_MODEL_ID, "memory_mb")).toBeLessThan(
      factOf(best, "memory_mb"),
    );
  });

  it("does not offer Tiny, which gets a first dictation wrong", () => {
    expect(ladderIndexOf("whisper-cpp-tiny")).toBeNull();
  });

  it("gives back what the slider asked for when the Mac can hold it", () => {
    const choice = chooseModel(DEFAULT_LADDER_INDEX, everythingFits);
    expect(choice.id).toBe(DEFAULT_LADDER_MODEL_ID);
    expect(choice.index).toBe(DEFAULT_LADDER_INDEX);
    expect(choice.askedFor).toBeNull();
  });

  it("steps down to the best rung that fits, and says which was asked for", () => {
    const tooBig = new Set(["whisper-cpp-large-v3-q5", "whisper-cpp-large-v3-turbo-q5"]);
    const choice = chooseModel(4, (id) => (tooBig.has(id) ? "too-large" : "comfortable"));
    expect(choice.id).toBe("whisper-cpp-medium-q5");
    expect(choice.index).toBe(2);
    expect(choice.askedFor?.id).toBe("whisper-cpp-large-v3-q5");
  });

  it("claims nothing about a Mac whose memory could not be read", () => {
    // An unread fit is not a refusal. Stepping down on one would quietly hand
    // every machine the lightest model the moment the reading failed.
    const choice = chooseModel(4, nothingKnown);
    expect(choice.id).toBe("whisper-cpp-large-v3-q5");
    expect(choice.askedFor).toBeNull();
  });

  it("falls back to the lightest rung when nothing at all fits", () => {
    const choice = chooseModel(4, () => "too-large");
    expect(choice.id).toBe(MODEL_LADDER[0]!.id);
    expect(choice.index).toBe(0);
    expect(choice.askedFor?.id).toBe("whisper-cpp-large-v3-q5");
  });

  it("clamps a position off either end rather than throwing", () => {
    expect(ladderRung(-3).id).toBe(MODEL_LADDER[0]!.id);
    expect(ladderRung(99).id).toBe(MODEL_LADDER[MODEL_LADDER.length - 1]!.id);
    // NaN propagates through Math.max, so without its own check the clamp
    // returns NaN, the lookup misses, and this hands back undefined.
    expect(ladderRung(Number.NaN)).toBe(MODEL_LADDER[0]);
    expect(chooseModel(Number.NaN, everythingFits).id).toBe(MODEL_LADDER[0]!.id);
    expect(chooseModel(Number.NaN, everythingFits).askedFor).toBeNull();
  });
});
