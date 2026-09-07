import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SPEECH_MODEL_ID,
  SPEECH_MODELS,
  getSpeechModel,
  isSpeechModelId,
} from "../src/shared/models";

describe("speech model registry", () => {
  it("offers every Whisper size, and Parakeet and Qwen3-ASR beside them", () => {
    // whisper.cpp is linked into the app, so each of these is a model a fresh
    // install can have by pressing a row -- which is why there are so many of
    // them, and only two of everything else.
    const whisper = SPEECH_MODELS.filter(({ engine }) => engine === "whisper-cpp");
    expect(whisper).toHaveLength(14);
    expect(SPEECH_MODELS.filter(({ engine }) => engine !== "whisper-cpp").map(({ id }) => id))
      .toEqual(["parakeet-tdt-0.6b-v3", "qwen3-asr-0.6b"]);

    // Each Whisper entry is one GGML weight file, and two entries naming the
    // same file would be two rows for one model.
    const files = whisper.map(({ modelId }) => modelId);
    expect(new Set(files).size).toBe(files.length);
    expect(files.every((file) => file.startsWith("ggml-") && file.endsWith(".bin"))).toBe(true);

    expect(getSpeechModel("qwen3-asr-0.6b").modelId).toBe("Qwen/Qwen3-ASR-0.6B");
    // GGML weights, which OpenAI's own Whisper package cannot read. That
    // package was a second entry for this same model and has been removed: it
    // wanted a 2.5 GB virtual environment to be slower.
    expect(getSpeechModel("whisper-cpp-small").modelId).toBe("ggml-small.bin");
    expect(getSpeechModel("whisper-cpp-small").engine).toBe("whisper-cpp");
  });

  it("defaults to Whisper Small, which runs on any Apple Silicon Mac", () => {
    // Named rather than positional: the list is ordered lightest first for the
    // models page to read, and Tiny is not a model to hand anyone unasked.
    expect(DEFAULT_SPEECH_MODEL_ID).toBe("whisper-cpp-small");
    expect(isSpeechModelId(DEFAULT_SPEECH_MODEL_ID)).toBe(true);
  });

  it("validates values loaded from local storage or IPC", () => {
    expect(isSpeechModelId("qwen3-asr-0.6b")).toBe(true);
    expect(isSpeechModelId("whisper-cpp-large-v3-turbo")).toBe(true);
    // Retired. A stored copy of it must not survive as a real selection.
    expect(isSpeechModelId("whisper-small")).toBe(false);
    expect(isSpeechModelId("unknown-model")).toBe(false);
    expect(isSpeechModelId(null)).toBe(false);
  });

  /**
   * The catalogue exists twice -- here and in Rust, which is what actually runs
   * it -- and until this test there was nothing to notice them drifting apart.
   * A model in one list and not the other fails at runtime: `model()` resolves
   * an id it does not know to the default, so choosing it would silently load
   * something else.
   *
   * Read out of the Rust source rather than over IPC, because the point is to
   * fail in `pnpm test` on the machine that edited one of the two files.
   */
  it("holds the same ids, in the same order, as the Rust table", () => {
    // Relative to the repository root, which is where vitest runs.
    const source = readFileSync("src-tauri/src/model_server.rs", "utf8");
    const table = source.slice(
      source.indexOf("pub const MODELS"),
      source.indexOf("pub const DEFAULT_MODEL_ID"),
    );
    expect(table).not.toBe("");

    const ids = Array.from(table.matchAll(/^\s+id: "([^"]+)"/gm)).map(([, id]) => id);
    expect(ids).toEqual(SPEECH_MODELS.map(({ id }) => id));

    const rustDefault = /pub const DEFAULT_MODEL_ID: &str = "([^"]+)"/.exec(source)?.[1];
    expect(rustDefault).toBe(DEFAULT_SPEECH_MODEL_ID);
  });
});
