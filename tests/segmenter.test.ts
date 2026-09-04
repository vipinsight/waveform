import { describe, expect, it } from "vitest";
import { SpeechSegmenter, rootMeanSquare } from "../src/renderer/audio/segmenter";

function samples(length: number, amplitude: number): Float32Array {
  return new Float32Array(length).fill(amplitude);
}

describe("SpeechSegmenter", () => {
  it("returns one phrase after trailing silence", () => {
    const segmenter = new SpeechSegmenter({
      sampleRate: 1000,
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
      minimumSpeechMs: 200,
      trailingSilenceMs: 200,
    });

    expect(segmenter.push(samples(100, 0.3))).toBeNull();
    expect(segmenter.push(samples(200, 0))).toBeNull();
  });

  it("flushes a valid final phrase", () => {
    const segmenter = new SpeechSegmenter({ sampleRate: 1000, minimumSpeechMs: 100 });

    segmenter.push(samples(150, 0.2));

    expect(segmenter.flush()).toHaveLength(150);
    expect(segmenter.flush()).toBeNull();
  });
});

describe("rootMeanSquare", () => {
  it("measures signal power", () => {
    expect(rootMeanSquare(new Float32Array([1, -1, 1, -1]))).toBe(1);
    expect(rootMeanSquare(new Float32Array())).toBe(0);
  });
});

