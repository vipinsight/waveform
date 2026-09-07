import { describe, expect, it } from "vitest";
import {
  DEFAULT_SPEECH_MODEL_ID,
  SPEECH_MODELS,
  getSpeechModel,
  isSpeechModelId,
} from "../src/shared/models";

describe("speech model registry", () => {
  it("defaults to whisper.cpp and offers Parakeet, Qwen3-ASR and Python Whisper", () => {
    // The engine that needs nothing installed beside the app goes first, so a
    // fresh install can dictate without picking a model.
    expect(DEFAULT_SPEECH_MODEL_ID).toBe("whisper-cpp-small");
    expect(SPEECH_MODELS.map(({ id }) => id)).toEqual([
      "whisper-cpp-small",
      "parakeet-tdt-0.6b-v3",
      "qwen3-asr-0.6b",
      "whisper-small",
    ]);
    expect(getSpeechModel("qwen3-asr-0.6b").modelId).toBe("Qwen/Qwen3-ASR-0.6B");
    // Whisper names its own weights; this is not a Hugging Face path.
    expect(getSpeechModel("whisper-small").modelId).toBe("small");
    // whisper.cpp takes GGML weights, which the Python package cannot read and
    // which are downloaded separately.
    expect(getSpeechModel("whisper-cpp-small").modelId).toBe("ggml-small.bin");
    expect(getSpeechModel("whisper-cpp-small").engine).toBe("whisper-cpp");
  });

  it("validates values loaded from local storage or IPC", () => {
    expect(isSpeechModelId("qwen3-asr-0.6b")).toBe(true);
    expect(isSpeechModelId("whisper-small")).toBe(true);
    expect(isSpeechModelId("whisper-cpp-small")).toBe(true);
    expect(isSpeechModelId("unknown-model")).toBe(false);
    expect(isSpeechModelId(null)).toBe(false);
  });
});
