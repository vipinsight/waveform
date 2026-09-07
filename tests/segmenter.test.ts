import { describe, expect, it } from "vitest";
import { SpeechSegmenter, rootMeanSquare } from "../src/renderer/audio/segmenter";

function samples(length: number, amplitude: number): Float32Array {
  return new Float32Array(length).fill(amplitude);
}

describe("SpeechSegmenter", () => {
  it("returns one phrase after trailing silence", () => {
    const segmenter = new SpeechSegmenter({
      sampleRate: 1000,
      calibrationMs: 0,
      preRollMs: 100,
      minimumSpeechMs: 200,
      trailingSilenceMs: 300,
    });

    expect(segmenter.push(samples(100, 0))).toBeNull();
    expect(segmenter.push(samples(200, 0.2))).toBeNull();
    expect(segmenter.push(samples(300, 0))).toHaveLength(600);
  });

  it("ignores clicks shorter than minimum speech duration", () => {
    const segmenter = new SpeechSegmenter({
      sampleRate: 1000,
      calibrationMs: 0,
      minimumSpeechMs: 200,
      trailingSilenceMs: 200,
    });

    expect(segmenter.push(samples(100, 0.3))).toBeNull();
    expect(segmenter.push(samples(200, 0))).toBeNull();
  });

  it("flushes a valid final phrase", () => {
    const segmenter = new SpeechSegmenter({ sampleRate: 1000, minimumSpeechMs: 100, calibrationMs: 0 });

    segmenter.push(samples(150, 0.2));

    expect(segmenter.flush()).toHaveLength(150);
    expect(segmenter.flush()).toBeNull();
  });
});

describe("SpeechSegmenter's measured floor", () => {
  it("follows the room rather than a number tuned against one stream", () => {
    const segmenter = new SpeechSegmenter({ sampleRate: 1000, trailingSilenceMs: 200 });
    // A noisy room: 0.02 would have been speech against the old fixed 0.014.
    for (let index = 0; index < 20; index += 1) segmenter.push(samples(100, 0.02));
    expect(segmenter.threshold()).toBeGreaterThan(0.02);
    // And a voice over that noise still is speech.
    expect(segmenter.push(samples(300, 0.2))).toBeNull();
    expect(segmenter.push(samples(200, 0.02))).not.toBeNull();
  });

  it("never treats a silent input as speech", () => {
    const segmenter = new SpeechSegmenter({ sampleRate: 1000, calibrationMs: 0 });
    // A muted microphone measures a floor of nothing; three times nothing is
    // still nothing, so the absolute minimum is what refuses it.
    for (let index = 0; index < 50; index += 1) {
      expect(segmenter.push(samples(100, 0.0005))).toBeNull();
    }
    expect(segmenter.threshold()).toBeGreaterThanOrEqual(0.004);
    expect(segmenter.flush()).toBeNull();
  });

  it("honours a fixed threshold when one is asked for", () => {
    const segmenter = new SpeechSegmenter({ sampleRate: 1000, silenceThreshold: 0.5 });
    expect(segmenter.threshold()).toBe(0.5);
    for (let index = 0; index < 20; index += 1) segmenter.push(samples(100, 0.2));
    expect(segmenter.threshold()).toBe(0.5);
  });
});

describe("rootMeanSquare", () => {
  it("measures signal power", () => {
    expect(rootMeanSquare(new Float32Array([1, -1, 1, -1]))).toBe(1);
    expect(rootMeanSquare(new Float32Array())).toBe(0);
  });
});


describe("SpeechSegmenter's measured floor", () => {
  it("follows the room rather than a number tuned against one stream", () => {
    const segmenter = new SpeechSegmenter({ sampleRate: 1000, trailingSilenceMs: 200 });
    // A noisy room: 0.02 would have been speech against the old fixed 0.014.
    for (let index = 0; index < 20; index += 1) segmenter.push(samples(100, 0.02));
    expect(segmenter.threshold()).toBeGreaterThan(0.02);
    // And a voice over that noise still is speech.
    expect(segmenter.push(samples(300, 0.2))).toBeNull();
    expect(segmenter.push(samples(200, 0.02))).not.toBeNull();
  });

  it("never treats a silent input as speech", () => {
    const segmenter = new SpeechSegmenter({ sampleRate: 1000, calibrationMs: 0 });
    // A muted microphone measures a floor of nothing; three times nothing is
    // still nothing, so the absolute minimum is what refuses it.
    for (let index = 0; index < 50; index += 1) {
      expect(segmenter.push(samples(100, 0.0005))).toBeNull();
    }
    expect(segmenter.threshold()).toBeGreaterThanOrEqual(0.004);
    expect(segmenter.flush()).toBeNull();
  });

  it("honours a fixed threshold when one is asked for", () => {
    const segmenter = new SpeechSegmenter({ sampleRate: 1000, silenceThreshold: 0.5 });
    expect(segmenter.threshold()).toBe(0.5);
    for (let index = 0; index < 20; index += 1) segmenter.push(samples(100, 0.2));
    expect(segmenter.threshold()).toBe(0.5);
  });
});

describe("rootMeanSquare", () => {
  it("measures signal power", () => {
    expect(rootMeanSquare(new Float32Array([1, -1, 1, -1]))).toBe(1);
    expect(rootMeanSquare(new Float32Array())).toBe(0);
  });
});


describe("short utterances", () => {
  /**
   * A real phrase is not continuous sound. Gaps between words and unvoiced
   * consonants fall below the speech threshold, so "open settings" may only
   * register a few hundred milliseconds of speech in total.
   */
  function speak(segmenter: SpeechSegmenter, wordMs: number, gapMs: number, words: number) {
    for (let index = 0; index < words; index += 1) {
      segmenter.push(samples(wordMs, 0.25));
      if (index < words - 1) segmenter.push(samples(gapMs, 0));
    }
  }

  it("keeps a two-word phrase when the key is released", () => {
    const segmenter = new SpeechSegmenter({ sampleRate: 1000, calibrationMs: 0 });
    speak(segmenter, 90, 60, 2);
    // Releasing the key is an explicit "I am done", so whatever was captured
    // should be transcribed rather than judged too short.
    expect(segmenter.flush()).not.toBeNull();
  });

  it("keeps a single short word when the key is released", () => {
    const segmenter = new SpeechSegmenter({ sampleRate: 1000, calibrationMs: 0 });
    segmenter.push(samples(150, 0.25));
    expect(segmenter.flush()).not.toBeNull();
  });

  it("still drops a release with no speech at all", () => {
    const segmenter = new SpeechSegmenter({ sampleRate: 1000, calibrationMs: 0 });
    segmenter.push(samples(500, 0));
    expect(segmenter.flush()).toBeNull();
  });

  it("still drops a stray click on release", () => {
    const segmenter = new SpeechSegmenter({ sampleRate: 1000, calibrationMs: 0 });
    segmenter.push(samples(20, 0.3));
    expect(segmenter.flush()).toBeNull();
  });

  it("keeps a short phrase that ends on a pause mid-session", () => {
    const segmenter = new SpeechSegmenter({ sampleRate: 1000, trailingSilenceMs: 300, calibrationMs: 0 });
    speak(segmenter, 90, 60, 2);
    expect(segmenter.push(samples(300, 0))).not.toBeNull();
  });
});
