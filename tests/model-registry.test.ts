import { describe, expect, it } from "vitest";
import {
  DEFAULT_SPEECH_MODEL_ID,
  SPEECH_MODELS,
  getSpeechModel,
  isSpeechModelId,
} from "../src/shared/models";

describe("speech model registry", () => {
  it("keeps Parakeet as the default and offers Qwen3-ASR 0.6B", () => {
    expect(DEFAULT_SPEECH_MODEL_ID).toBe("parakeet-tdt-0.6b-v3");
    expect(SPEECH_MODELS.map(({ id }) => id)).toEqual([
      "parakeet-tdt-0.6b-v3",
      "qwen3-asr-0.6b",
    ]);
    expect(getSpeechModel("qwen3-asr-0.6b").modelId).toBe("Qwen/Qwen3-ASR-0.6B");
  });

  it("validates values loaded from local storage or IPC", () => {
    expect(isSpeechModelId("qwen3-asr-0.6b")).toBe(true);
    expect(isSpeechModelId("unknown-model")).toBe(false);
    expect(isSpeechModelId(null)).toBe(false);
  });
});
