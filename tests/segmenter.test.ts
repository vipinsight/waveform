import { describe, expect, it } from "vitest";
import { SpeechSegmenter, rootMeanSquare } from "../src/renderer/audio/segmenter";

function samples(length: number, amplitude: number): Float32Array {
  return new Float32Array(length).fill(amplitude);
}

/** A quiet room, not digital zero: exact zeros are a stream that has not started. */
const ROOM = 0.002;

describe("SpeechSegmenter", () => {
  it("returns one phrase after trailing silence", () => {
    const segmenter = new SpeechSegmenter({
      sampleRate: 1000,
      calibrationMs: 0,
      preRollMs: 100,
      minimumSpeechMs: 200,
      trailingSilenceMs: 300,
    });

    expect(segmenter.push(samples(100, ROOM))).toBeNull();
    expect(segmenter.push(samples(200, 0.2))).toBeNull();
    expect(segmenter.push(samples(300, ROOM))).toHaveLength(600);
  });

  it("ignores clicks shorter than minimum speech duration", () => {
    const segmenter = new SpeechSegmenter({
      sampleRate: 1000,
      calibrationMs: 0,
      minimumSpeechMs: 200,
      trailingSilenceMs: 200,
    });

    expect(segmenter.push(samples(100, 0.3))).toBeNull();
    expect(segmenter.push(samples(200, ROOM))).toBeNull();
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
    segmenter.push(samples(500, ROOM));
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
    expect(segmenter.push(samples(300, ROOM))).not.toBeNull();
  });
  /*
   * People start talking as the bar appears. The room used to be the average
   * of the calibration window, so it came out as their voice, the threshold
   * sat above it, and only a louder word late in the sentence was kept.
   */
  describe("speech from the first block", () => {
    const rate = 1000;
    const block = 10;
    function sentence(segmenter: SpeechSegmenter, ms: number, loudAfter = Infinity): Float32Array[] {
      const phrases: Float32Array[] = [];
      for (let t = 0; t < ms; t += block) {
        const inWord = t % 330 < 250;
        const level = inWord ? (t >= loudAfter ? 0.15 : 0.05) : 0.01;
        const phrase = segmenter.push(samples(block, level));
        if (phrase) phrases.push(phrase);
      }
      const tail = segmenter.flush();
      if (tail) phrases.push(tail);
      return phrases;
    }

    it("keeps the whole sentence", () => {
      const phrases = sentence(new SpeechSegmenter({ sampleRate: rate }), 3000);
      expect(phrases.reduce((sum, phrase) => sum + phrase.length, 0)).toBe(3000);
    });

    it("keeps the start even when only the end is loud", () => {
      const phrases = sentence(new SpeechSegmenter({ sampleRate: rate }), 3000, 2000);
      expect(phrases.reduce((sum, phrase) => sum + phrase.length, 0)).toBe(3000);
    });
  });

  // The failure seen on a real recording: a stream that opens at digital
  // silence must not be mistaken for the room.
  it("waits out warm-up silence before calibrating", () => {
    const segmenter = new SpeechSegmenter({
      sampleRate: 1000,
      preRollMs: 100,
      minimumSpeechMs: 100,
      trailingSilenceMs: 300,
    });
    const feed = (ms: number, amplitude: number) => {
      const out = [];
      for (let fed = 0; fed < ms; fed += 50) {
        const phrase = segmenter.push(samples(50, amplitude));
        if (phrase) out.push(phrase);
      }
      return out;
    };
    expect(feed(300, 0.00003)).toHaveLength(0); // warm-up, not calibration
    expect(feed(300, 0.01)).toHaveLength(0); // the room, calibrated on
    const phrases = [...feed(1000, 0.06), ...feed(1000, 0.01)];
    expect(phrases).toHaveLength(1);
    expect(phrases[0]!.length).toBeLessThan(2000);
  });

  // A floor learned too low -- a room that was near-silent when the key went
  // down and then filled -- heals itself at the first capped phrase.
  it("relearns the floor from a stretch that never fell silent", () => {
    const segmenter = new SpeechSegmenter({
      sampleRate: 1000,
      preRollMs: 100,
      minimumSpeechMs: 100,
      trailingSilenceMs: 300,
      maximumSegmentMs: 5000,
    });
    const feed = (ms: number, amplitude: number) => {
      const out = [];
      for (let fed = 0; fed < ms; fed += 50) {
        const phrase = segmenter.push(samples(50, amplitude));
        if (phrase) out.push(phrase);
      }
      return out;
    };
    feed(300, 0.0003); // calibrated on a room far quieter than what follows
    // Speech with gaps, all reading as speech on the wrong floor, until the
    // floor is relearned a few seconds in; the stretch then ends on its own.
    const phrases = [];
    for (let i = 0; i < 4; i += 1) {
      phrases.push(...feed(1000, 0.06), ...feed(1000, 0.01));
    }
    expect(phrases.length).toBeGreaterThanOrEqual(1);
    expect(phrases[0]!.length).toBeLessThanOrEqual(5000);
    expect(phrases.length).toBeGreaterThanOrEqual(2);
    // After the cap the floor is the room, so speech then room cuts at the pause.
    const after = [...feed(1000, 0.06), ...feed(1000, 0.01)];
    expect(after).toHaveLength(1);
    expect(after[0]!.length).toBeLessThan(3000);
  });
});
