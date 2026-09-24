import { describe, expect, it, vi } from "vitest";
import { AudioCapture } from "../src/renderer/audio/capture";
import { encodeMonoPcm16Wav } from "../src/renderer/audio/wav";
import {
  actionsForDictation,
  dictationEntryTitle,
  isFailedDictation,
} from "../src/renderer/history-entry";
import type { SavedDictation } from "../src/shared/contracts";

function silentCaptureHandlers(overrides: {
  onError?: (message: string) => void;
  onPhrase?: (text: string) => void;
  onPendingChange?: (pending: number) => void;
  transcribe?: (wav: Uint8Array) => Promise<{ text: string }>;
  stopNativeCapture?: () => Promise<void>;
} = {}) {
  return {
    onPhrase: overrides.onPhrase ?? (() => undefined),
    onPendingChange: overrides.onPendingChange ?? (() => undefined),
    onError: overrides.onError ?? (() => undefined),
    log: () => undefined,
    transcribe: overrides.transcribe ?? (async () => ({ text: "" })),
    startNativeCapture: async () => "mic",
    stopNativeCapture: overrides.stopNativeCapture ?? (async () => undefined),
  };
}

describe("AudioCapture retry clips", () => {
  it("keeps lastClips through a failed transcription and retryLast succeeds", async () => {
    const phrases: string[] = [];
    let attempts = 0;
    const capture = new AudioCapture(
      silentCaptureHandlers({
        onPhrase: (text) => phrases.push(text),
        transcribe: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("engine down");
          return { text: "hello again" };
        },
      }),
    );

    await capture.start();
    // One second of tone at a level the segmenter will treat as speech once
    // the room has been calibrated — feed enough blocks to emit a phrase.
    const rate = 16_000;
    for (let index = 0; index < 30; index += 1) {
      const block = new Float32Array(rate / 10);
      block.fill(index < 5 ? 0.0001 : 0.05);
      capture.feed(block, rate);
    }
    // Force the trailing segment out.
    capture.stop();
    // Wait for the in-flight transcription to settle.
    await vi.waitFor(() => expect(attempts).toBeGreaterThanOrEqual(1));

    expect(capture.hasRetryableClips).toBe(true);

    const result = await capture.retryLast();
    expect(result.error).toBeUndefined();
    expect(result.texts).toEqual(["hello again"]);
    expect(phrases).toContain("hello again");
  });

  it("start() clears clips from a previous session", async () => {
    const capture = new AudioCapture(
      silentCaptureHandlers({
        transcribe: async () => ({ text: "once" }),
      }),
    );
    await capture.retryFromWav(encodeMonoPcm16Wav(new Float32Array(32), 16_000));
    expect(capture.hasRetryableClips).toBe(true);

    await capture.start();
    expect(capture.hasRetryableClips).toBe(false);
    capture.cancel();
  });

  it("empty session has no retry", async () => {
    const errors: string[] = [];
    const capture = new AudioCapture(
      silentCaptureHandlers({
        onError: (message) => errors.push(message),
      }),
    );
    await capture.start();
    capture.stop();
    expect(capture.hasRetryableClips).toBe(false);
    expect(errors[0]).toMatch(/Heard nothing/);
  });
});

describe("failed history entry actions", () => {
  const failed: SavedDictation = {
    id: "1",
    text: "",
    createdAt: 1,
    status: "failed",
    message: "engine down",
    audioPath: "1.wav",
  };
  const ok: SavedDictation = {
    id: "2",
    text: "hello",
    createdAt: 2,
    status: "ok",
  };

  it("failed entry renders Play + Retry, not Copy", () => {
    expect(isFailedDictation(failed)).toBe(true);
    expect(actionsForDictation(failed)).toEqual(["play", "retry", "delete"]);
    expect(dictationEntryTitle(failed)).toBe("Transcribe failed");
  });

  it("successful entry keeps Copy + Delete", () => {
    expect(actionsForDictation(ok)).toEqual(["copy", "delete"]);
    expect(dictationEntryTitle(ok)).toBe("hello");
  });
});
