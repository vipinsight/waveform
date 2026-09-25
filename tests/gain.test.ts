import { describe, expect, it } from "vitest";
import { InputGain, normalizePhrase } from "../src/renderer/audio/gain";
import { SpeechSegmenter, rootMeanSquare } from "../src/renderer/audio/segmenter";
import { canReuseMicrophoneStream, AudioCapture, microphoneConstraints } from "../src/renderer/audio/capture";

function samples(length: number, amplitude: number): Float32Array {
  return new Float32Array(length).fill(amplitude);
}

function fakeStream(states: Array<MediaStreamTrackState>): MediaStream {
  return {
    getAudioTracks: () => states.map((readyState) => ({ readyState })),
  } as MediaStream;
}

describe("canReuseMicrophoneStream", () => {
  it("reuses a live stream for the same device", () => {
    expect(canReuseMicrophoneStream(fakeStream(["live"]), "", "")).toBe(true);
    expect(canReuseMicrophoneStream(fakeStream(["live"]), "built-in", "built-in")).toBe(true);
  });

  it("opens again when the device changed or the track has ended", () => {
    expect(canReuseMicrophoneStream(fakeStream(["live"]), "", "built-in")).toBe(false);
    expect(canReuseMicrophoneStream(fakeStream(["ended"]), "", "")).toBe(false);
    expect(canReuseMicrophoneStream(null, "", "")).toBe(false);
  });
});

describe("microphoneConstraints", () => {
  it("asks for a plain input, so WebKit does not start the voice-processing unit", () => {
    const constraints = microphoneConstraints("");
    expect(constraints.echoCancellation).toBe(false);
    expect(constraints.autoGainControl).toBe(false);
    expect(constraints.noiseSuppression).toBe(false);
    expect(constraints.deviceId).toBeUndefined();
  });

  it("pins a chosen device without turning the processing unit back on", () => {
    const constraints = microphoneConstraints("built-in");
    expect(constraints.deviceId).toEqual({ exact: "built-in" });
    expect(constraints.echoCancellation).toBe(false);
  });
});

describe("InputGain", () => {
  it("lifts the measured raw built-in peak above the segmenter's mute floor", () => {
    const gain = new InputGain();
    // 0.0036 was the loudest block of a whole session without the
    // voice-processing unit. The segmenter refuses anything under 0.004.
    const boosted = gain.apply(samples(1_000, 0.0036));
    expect(rootMeanSquare(boosted)).toBeGreaterThan(0.004);
  });

  it("leaves an already-loud interface alone", () => {
    const gain = new InputGain();
    const source = samples(1_000, 0.2);
    expect(gain.apply(source)).toBe(source);
    expect(gain.factor()).toBeCloseTo(1, 2);
  });

  it("scales room and speech by the same factor", () => {
    const gain = new InputGain();
    gain.apply(samples(1_000, 0.0013));
    const factor = gain.factor();
    const speech = gain.apply(samples(1_000, 0.0036));
    expect(gain.factor()).toBe(factor);
    expect(rootMeanSquare(speech)).toBeCloseTo(0.0036 * factor, 5);
  });

  it("keeps a muted raw microphone from becoming a phrase", () => {
    const gain = new InputGain();
    const segmenter = new SpeechSegmenter({
      sampleRate: 1000,
      calibrationMs: 250,
      trailingSilenceMs: 200,
    });
    for (let index = 0; index < 50; index += 1) {
      expect(segmenter.push(gain.apply(samples(100, 0.0005)))).toBeNull();
    }
    expect(segmenter.flush()).toBeNull();
  });

  it("captures raw built-in speech that used to sit under the mute floor", () => {
    const gain = new InputGain();
    const segmenter = new SpeechSegmenter({
      sampleRate: 1000,
      calibrationMs: 250,
      minimumSpeechMs: 100,
      trailingSilenceMs: 200,
    });
    // Room, then the measured raw speech peak, then room again.
    for (let index = 0; index < 3; index += 1) {
      expect(segmenter.push(gain.apply(samples(100, 0.0004)))).toBeNull();
    }
    expect(segmenter.push(gain.apply(samples(200, 0.0036)))).toBeNull();
    expect(segmenter.push(gain.apply(samples(200, 0.0004)))).not.toBeNull();
  });

  it("captures the measured session whose raw peak sat just under the mute floor", () => {
    const gain = new InputGain();
    const segmenter = new SpeechSegmenter({
      sampleRate: 1000,
      calibrationMs: 250,
      minimumSpeechMs: 100,
      trailingSilenceMs: 200,
    });
    // The reverted plain-input session: peak 0.0036, threshold 0.0040. The
    // mute floor is an absolute 0.004, so the room that produced it was at
    // most 0.004 / 3. Using that louder room is the harder case: gain that
    // only works against a near-silent floor still has to keep speech above
    // three times this one.
    for (let index = 0; index < 3; index += 1) {
      expect(segmenter.push(gain.apply(samples(100, 0.0013)))).toBeNull();
    }
    expect(segmenter.push(gain.apply(samples(200, 0.0036)))).toBeNull();
    expect(segmenter.push(gain.apply(samples(200, 0.0013)))).not.toBeNull();
  });
});

function silentCaptureHandlers(overrides: {
  onError?: (message: string) => void;
  stopNativeCapture?: () => Promise<void>;
} = {}) {
  return {
    onClip: () => undefined,
    onPhrase: () => undefined,
    onPendingChange: () => undefined,
    onError: overrides.onError ?? (() => undefined),
    log: () => undefined,
    transcribe: async () => ({ text: "" }),
    startNativeCapture: async () => "mic",
    stopNativeCapture: overrides.stopNativeCapture ?? (async () => undefined),
  };
}

describe("AudioCapture.stop", () => {
  /*
   * The polish shortcut ends with overlay action "stop", the same command that
   * means the dictation key came up. Stopping a capture that never started
   * used to report "Heard nothing" and tear down native capture, which hung
   * the HUD when polish ran with no microphone session.
   */
  it("does nothing when no session was opened", () => {
    const errors: string[] = [];
    let stopped = 0;
    const capture = new AudioCapture(
      silentCaptureHandlers({
        onError: (message) => errors.push(message),
        stopNativeCapture: async () => {
          stopped += 1;
        },
      }),
    );
    capture.stop();
    expect(errors).toEqual([]);
    expect(stopped).toBe(0);
  });
});

describe("AudioCapture.retryLast", () => {
  it("re-transcribes held clips after a failure without opening the mic", async () => {
    let attempts = 0;
    const phrases: string[] = [];
    const errors: string[] = [];
    let starts = 0;
    const capture = new AudioCapture({
      ...silentCaptureHandlers({
        onError: (message) => errors.push(message),
      }),
      onPhrase: (text) => {
        phrases.push(text);
      },
      startNativeCapture: async () => {
        starts += 1;
        return "mic";
      },
      transcribe: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("engine busy");
        return { text: "hello again" };
      },
    });

    await capture.start();
    // Calibrate on room, speak, then stop so flush cuts the phrase.
    capture.feed(samples(300, 0.0004), 1_000);
    capture.feed(samples(400, 0.05), 1_000);
    capture.stop();
    await waitFor(() => errors.includes("engine busy"));
    expect(capture.canRetry).toBe(true);
    expect(starts).toBe(1);

    expect(capture.retryLast()).toBe(true);
    await waitFor(() => phrases.includes("hello again"));
    expect(capture.canRetry).toBe(false);
    expect(starts).toBe(1);
  });

  it("clears held clips when a new session starts", async () => {
    let attempts = 0;
    const capture = new AudioCapture({
      ...silentCaptureHandlers(),
      transcribe: async () => {
        attempts += 1;
        throw new Error("fail");
      },
    });
    await capture.start();
    capture.feed(samples(300, 0.0004), 1_000);
    capture.feed(samples(400, 0.05), 1_000);
    capture.stop();
    await waitFor(() => capture.canRetry);
    await capture.start();
    expect(capture.canRetry).toBe(false);
    expect(capture.retryLast()).toBe(false);
    expect(attempts).toBe(1);
  });

  it("has nothing to retry when the session heard no phrases", async () => {
    const errors: string[] = [];
    const capture = new AudioCapture(
      silentCaptureHandlers({
        onError: (message) => errors.push(message),
      }),
    );
    await capture.start();
    capture.feed(samples(500, 0.0001), 1_000);
    capture.stop();
    await waitFor(() => errors.length > 0);
    expect(capture.canRetry).toBe(false);
    expect(capture.retryLast()).toBe(false);
  });

  it("finishes delivering a phrase before pending drops to zero", async () => {
    const order: string[] = [];
    let releasePhrase: (() => void) | null = null;
    const capture = new AudioCapture({
      ...silentCaptureHandlers(),
      onPhrase: async () => {
        order.push("phrase-start");
        await new Promise<void>((resolve) => {
          releasePhrase = resolve;
        });
        order.push("phrase-done");
      },
      onPendingChange: (pending) => {
        if (pending === 0) order.push("pending-zero");
      },
      transcribe: async () => ({ text: "logged" }),
    });
    await capture.start();
    capture.feed(samples(300, 0.0004), 1_000);
    capture.feed(samples(400, 0.05), 1_000);
    capture.stop();
    await waitFor(() => releasePhrase !== null);
    expect(order).toEqual(["phrase-start"]);
    releasePhrase!();
    await waitFor(() => order.includes("pending-zero"));
    expect(order).toEqual(["phrase-start", "phrase-done", "pending-zero"]);
  });

  it("stashes audio before transcription and reports empty before pending hits zero", async () => {
    const order: string[] = [];
    const capture = new AudioCapture({
      ...silentCaptureHandlers(),
      onClip: () => {
        order.push("clip");
      },
      onError: (message) => {
        order.push(`error:${message.startsWith("No words")}`);
      },
      onPendingChange: (pending) => {
        if (pending === 0) order.push("pending-zero");
      },
      transcribe: async () => ({ text: "" }),
    });
    await capture.start();
    capture.feed(samples(300, 0.0004), 1_000);
    capture.feed(samples(400, 0.05), 1_000);
    capture.stop();
    await waitFor(() => order.includes("pending-zero"));
    expect(order).toEqual(["clip", "error:true", "pending-zero"]);
    expect(capture.canRetry).toBe(true);
  });
});

/*
 * The session gain was applied to the samples, and at a laptop mic's 32x it
 * pushed ordinary speech past full scale: 1-6% of samples in real recordings
 * were clipped, and that is what the engine heard and history kept.
 */
describe("phrase audio", () => {
  it("is scaled once so its loudest sample sits below full scale", () => {
    const raw = new Float32Array([0.01, -0.05, 0.02, 0.1, -0.03]);
    const { samples: scaled, factor } = normalizePhrase(raw);
    expect(factor).toBeCloseTo(9);
    expect(Math.max(...scaled.map(Math.abs))).toBeCloseTo(0.9);
    // One factor for the whole phrase: the shape is untouched.
    expect(scaled[1]! / scaled[3]!).toBeCloseTo(raw[1]! / raw[3]!);
  });

  it("leaves silence alone", () => {
    const silent = new Float32Array(10);
    expect(normalizePhrase(silent).factor).toBe(1);
  });

  it("is not clipped when the session gain would have clipped it", async () => {
    const clips: Uint8Array[] = [];
    const capture = new AudioCapture({
      ...silentCaptureHandlers(),
      onClip: (wav) => {
        clips.push(wav);
      },
    });
    await capture.start();
    // A quiet room sets the held gain to 32x; speech at 0.05 would reach 1.6.
    capture.feed(samples(300, 0.0004), 1_000);
    capture.feed(samples(400, 0.05), 1_000);
    capture.stop();
    await waitFor(() => clips.length > 0);

    const wav = clips[0]!;
    const pcm = new Int16Array(wav.buffer, wav.byteOffset + 44, (wav.length - 44) / 2);
    const peak = Math.max(...Array.from(pcm, Math.abs));
    expect(peak).toBeLessThan(32_000);
    expect(peak).toBeGreaterThan(28_000);
  });
});

async function waitFor(predicate: () => boolean, tries = 40): Promise<void> {
  for (let index = 0; index < tries; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for condition");
}
