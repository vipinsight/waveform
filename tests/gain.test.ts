import { describe, expect, it } from "vitest";
import { InputGain } from "../src/renderer/audio/gain";
import { SpeechSegmenter, rootMeanSquare } from "../src/renderer/audio/segmenter";
import { canReuseMicrophoneStream, microphoneConstraints } from "../src/renderer/audio/capture";

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
