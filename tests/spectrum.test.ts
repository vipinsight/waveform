import { describe, expect, it } from "vitest";
import { SPECTRUM_WINDOW, spectrumFromBlock, speechBands } from "../src/renderer/audio/spectrum";

/** Native capture's usual rate. The DFT window is 256 samples of that. */
const SAMPLE_RATE = 48_000;

function tone(hz: number): Float32Array {
  return Float32Array.from(
    { length: SPECTRUM_WINDOW },
    (_, index) => Math.sin((2 * Math.PI * hz * index) / SAMPLE_RATE),
  );
}

function mix(frequencies: number[]): Float32Array {
  const samples = new Float32Array(SPECTRUM_WINDOW);
  for (const hz of frequencies) {
    const partial = tone(hz);
    for (let index = 0; index < SPECTRUM_WINDOW; index += 1) {
      samples[index] = (samples[index] ?? 0) + (partial[index] ?? 0) / frequencies.length;
    }
  }
  return samples;
}

describe("spectrumFromBlock", () => {
  it("is silent for silence", () => {
    const spectrum = spectrumFromBlock(new Float32Array(256));
    expect(spectrum.some((bin) => bin > 0)).toBe(false);
  });

  it("puts energy in a low bin for a slow oscillation, not a flat spinner", () => {
    const samples = Float32Array.from({ length: 256 }, (_, index) =>
      Math.sin((2 * Math.PI * 2 * index) / 256),
    );
    const spectrum = spectrumFromBlock(samples);
    const low = spectrum[2] ?? 0;
    const high = spectrum[40] ?? 0;
    expect(low).toBeGreaterThan(high);
    expect(low).toBeGreaterThan(0);
  });
});

describe("speechBands", () => {
  it("is silent for silence", () => {
    const bands = speechBands(spectrumFromBlock(new Float32Array(256)), 4, SAMPLE_RATE);
    expect(bands.every((peak) => peak === 0)).toBe(true);
  });

  it("spreads a voice-like mix across every band, not only the lowest", () => {
    // Fundamentals plus formants, the energy a spoken phrase actually has.
    // Linearly slicing the lower 42% of a 48 kHz DFT put all of this in the
    // first band — the two centre bars — and left the rest of the meter still.
    const spectrum = spectrumFromBlock(mix([220, 500, 1400, 3000]));
    const bands = speechBands(spectrum, 4, SAMPLE_RATE);
    expect(bands).toHaveLength(4);
    expect(bands.every((peak) => peak > 0)).toBe(true);
  });

  it("still puts a low tone in the lowest band, not as a flat spinner", () => {
    const bands = speechBands(spectrumFromBlock(tone(220)), 4, SAMPLE_RATE);
    expect(bands[0] ?? 0).toBeGreaterThan(bands[3] ?? 0);
    expect(bands[0] ?? 0).toBeGreaterThan(0);
  });
});
