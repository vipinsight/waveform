import { describe, expect, it } from "vitest";
import { wavPeaks } from "../src/renderer/audio/peaks";
import { encodeMonoPcm16Wav } from "../src/renderer/audio/wav";

describe("wavPeaks", () => {
  it("takes the loudest sample in each slice", () => {
    const samples = new Float32Array([0.1, -0.5, 0.2, 0.25, 0, -1, 0.75, 0.5]);
    const peaks = wavPeaks(encodeMonoPcm16Wav(samples, 16_000), 4);
    expect([...peaks].map((peak) => Number(peak.toFixed(2)))).toEqual([0.5, 0.25, 1, 0.75]);
  });

  it("gives no more slices than there are samples", () => {
    expect(wavPeaks(encodeMonoPcm16Wav(new Float32Array([0.5, 0.5]), 16_000), 100)).toHaveLength(2);
  });

  it("gives nothing for bytes that are not a WAV", () => {
    expect(wavPeaks(new Uint8Array(64), 10)).toHaveLength(0);
  });
});
