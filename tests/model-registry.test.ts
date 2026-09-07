import { describe, expect, it } from "vitest";
import {
  DEFAULT_SPEECH_MODEL_ID,
  SPEECH_MODELS,
  getSpeechModel,
  isSpeechModelId,
} from "../src/shared/models";

describe("speech model registry", () => {
  it("defaults to whisper.cpp and offers Parakeet and Qwen3-ASR", () => {
    // The engine that needs nothing installed beside the app goes first, so a
    // fresh install can dictate without picking a model.
    expect(DEFAULT_SPEECH_MODEL_ID).toBe("whisper-cpp-small");
    expect(SPEECH_MODELS.map(({ id }) => id)).toEqual([
      "whisper-cpp-small",
      "parakeet-tdt-0.6b-v3",
      "qwen3-asr-0.6b",
    ]);
    expect(getSpeechModel("qwen3-asr-0.6b").modelId).toBe("Qwen/Qwen3-ASR-0.6B");
    // GGML weights, which OpenAI's own Whisper package cannot read. That
    // package was a second entry for this same model and has been removed: it
    // wanted a 2.5 GB virtual environment to be slower.
    expect(getSpeechModel("whisper-cpp-small").modelId).toBe("ggml-small.bin");
    expect(getSpeechModel("whisper-cpp-small").engine).toBe("whisper-cpp");
  });

  it("validates values loaded from local storage or IPC", () => {
    expect(isSpeechModelId("qwen3-asr-0.6b")).toBe(true);
    expect(isSpeechModelId("whisper-cpp-small")).toBe(true);
    // Retired. A stored copy of it must not survive as a real selection.
    expect(isSpeechModelId("whisper-small")).toBe(false);
    expect(isSpeechModelId("unknown-model")).toBe(false);
    expect(isSpeechModelId(null)).toBe(false);
  });
});
