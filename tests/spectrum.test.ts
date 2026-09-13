import { describe, expect, it } from "vitest";
import { spectrumFromBlock } from "../src/renderer/audio/spectrum";

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
