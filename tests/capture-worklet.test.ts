import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("src/renderer/audio/capture-worklet.js", "utf8");

/**
 * The worklet cannot be imported the way the rest of the code is: it runs in
 * AudioWorkletGlobalScope, where `AudioWorkletProcessor` and
 * `registerProcessor` are globals the browser provides. Both are stubbed here
 * so the file can be evaluated and the class it registers pulled out.
 *
 * Worth testing rather than trusting: this replaced a node whose failure mode
 * was silently dropping audio, and the same mistake here would look identical.
 */
function loadProcessor(): {
  process(inputs: Float32Array[][]): boolean;
  posted: Float32Array[];
} {
  const posted: Float32Array[] = [];
  let registered: unknown;

  // Evaluated rather than imported: the module's own globals do not exist
  // outside an audio thread, and a cached import would keep the first stub.
  const base = class {
    port = { postMessage: (data: Float32Array) => posted.push(data) };
  };
  new Function("AudioWorkletProcessor", "registerProcessor", source)(
    base,
    (_name: string, processor: unknown) => {
      registered = processor;
    },
  );

  const Processor = registered as new () => { process(inputs: Float32Array[][]): boolean };
  return Object.assign(new Processor(), { posted });
}

/** One render quantum, as the browser delivers it. */
function quantum(from: number): Float32Array {
  return Float32Array.from({ length: 128 }, (_, index) => (from + index) / 100_000);
}

describe("capture worklet", () => {
  it("posts whole blocks, in order, with nothing lost between them", () => {
    const processor = loadProcessor();
    // 2048 frames is sixteen quanta, so two blocks take exactly 32.
    for (let index = 0; index < 32; index += 1) {
      expect(processor.process([[quantum(index * 128)]])).toBe(true);
    }

    expect(processor.posted).toHaveLength(2);
    const joined = new Float32Array(4096);
    joined.set(processor.posted[0]!, 0);
    joined.set(processor.posted[1]!, 2048);
    // Float32 rounding, so the comparison is to seven places rather than to
    // the exact value the test wrote.
    for (let index = 0; index < 4096; index += 1) {
      expect(joined[index]).toBeCloseTo(index / 100_000, 7);
    }
  });

  it("keeps a partial block rather than padding it with silence", () => {
    const processor = loadProcessor();
    for (let index = 0; index < 15; index += 1) processor.process([[quantum(index * 128)]]);
    // Fifteen quanta is 1920 frames: not a block yet, and padding the rest
    // would splice 128 samples of silence into the middle of a word.
    expect(processor.posted).toHaveLength(0);
    processor.process([[quantum(15 * 128)]]);
    expect(processor.posted).toHaveLength(1);
    expect(processor.posted[0]![2047]).toBeCloseTo(2047 / 100_000, 7);
  });

  it("survives a quantum with no input, as when the track has not started", () => {
    const processor = loadProcessor();
    expect(processor.process([[]])).toBe(true);
    expect(processor.process([])).toBe(true);
    expect(processor.posted).toHaveLength(0);
  });
});
