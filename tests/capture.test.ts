import { describe, expect, it } from "vitest";
import { AudioCapture, type CaptureHandlers } from "../src/renderer/audio/capture";

const RATE = 8_000;
const BLOCK = 400; // 50ms
/** A quiet room, not digital zero: exact zeros are a stream that has not started. */
const ROOM = 0.002;

function block(amplitude: number): Float32Array {
  return new Float32Array(BLOCK).fill(amplitude);
}

function feedMs(capture: AudioCapture, ms: number, amplitude: number): void {
  for (let fed = 0; fed < ms; fed += 50) capture.feed(block(amplitude), RATE);
}

/** Room, a phrase, and the pause that cuts it. */
function speak(capture: AudioCapture): void {
  feedMs(capture, 1_000, 0.2);
  feedMs(capture, 800, ROOM);
}

function harness(
  transcribe: CaptureHandlers["transcribe"],
): { capture: AudioCapture; phrases: string[]; priors: string[]; errors: string[] } {
  const phrases: string[] = [];
  const priors: string[] = [];
  const errors: string[] = [];
  const capture = new AudioCapture({
    onClip: () => {},
    onPhrase: (text) => {
      phrases.push(text);
    },
    onPendingChange: () => {},
    onError: (message) => {
      errors.push(message);
    },
    log: () => {},
    transcribe: (wav, prior) => {
      priors.push(prior);
      return transcribe(wav, prior);
    },
    startNativeCapture: async () => "test input",
    stopNativeCapture: async () => {},
  });
  return { capture, phrases, priors, errors };
}

async function settled(capture: AudioCapture): Promise<void> {
  while (capture.pendingCount > 0) await new Promise((resolve) => setTimeout(resolve, 5));
}

describe("AudioCapture", () => {
  it("primes each phrase with the text of the ones before it, in order", async () => {
    let calls = 0;
    const { capture, phrases, priors } = harness(async () => {
      calls += 1;
      // The first decode is slow and the second fast: were they not taken in
      // turn, the second would come back first and be primed with nothing.
      const text = calls === 1 ? "Hello there," : "how are you?";
      await new Promise((resolve) => setTimeout(resolve, calls === 1 ? 60 : 0));
      return { text };
    });

    await capture.start();
    // Calibration: 250ms of room before anything counts as speech.
    feedMs(capture, 300, ROOM);
    speak(capture);
    speak(capture);
    capture.stop();
    await settled(capture);

    expect(priors).toEqual(["", "Hello there,"]);
    expect(phrases).toEqual(["Hello there,", "how are you?"]);
  });

  it("starts a new session with no context from the last one", async () => {
    const { capture, priors } = harness(async () => ({ text: "words" }));

    await capture.start();
    feedMs(capture, 300, ROOM);
    speak(capture);
    capture.stop();
    await settled(capture);

    await capture.start();
    feedMs(capture, 300, ROOM);
    speak(capture);
    capture.stop();
    await settled(capture);

    expect(priors).toEqual(["", ""]);
  });

  it("rebuilds the context from scratch on retry", async () => {
    let fail = true;
    const { capture, priors, phrases } = harness(async () => {
      if (fail) throw new Error("engine down");
      return { text: "ok" };
    });

    await capture.start();
    feedMs(capture, 300, ROOM);
    speak(capture);
    speak(capture);
    capture.stop();
    await settled(capture);
    expect(phrases).toEqual([]);
    expect(capture.canRetry).toBe(true);

    fail = false;
    priors.length = 0;
    expect(capture.retryLast()).toBe(true);
    await settled(capture);

    expect(priors).toEqual(["", "ok"]);
    expect(phrases).toEqual(["ok", "ok"]);
  });

  it("lets later phrases through when one fails", async () => {
    let calls = 0;
    const { capture, phrases, errors } = harness(async () => {
      calls += 1;
      if (calls === 1) throw new Error("engine hiccup");
      return { text: "second" };
    });

    await capture.start();
    feedMs(capture, 300, ROOM);
    speak(capture);
    speak(capture);
    capture.stop();
    await settled(capture);

    expect(errors).toEqual(["engine hiccup"]);
    expect(phrases).toEqual(["second"]);
  });
});
