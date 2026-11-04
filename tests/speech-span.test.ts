import { describe, expect, it } from "vitest";
import { speechSpanMs } from "../src/renderer/audio/speech-span";
import { encodeMonoPcm16Wav } from "../src/renderer/audio/wav";

const RATE = 16_000;

/** Quiet room, then a tone, then quiet again, each `ms` long. */
function phrase(leadMs: number, speechMs: number, tailMs: number): Uint8Array {
  const total = Math.round(((leadMs + speechMs + tailMs) * RATE) / 1000);
  const speechStart = Math.round((leadMs * RATE) / 1000);
  const speechEnd = speechStart + Math.round((speechMs * RATE) / 1000);
  const samples = new Float32Array(total);
  for (let index = 0; index < total; index += 1) {
    const voiced = index >= speechStart && index < speechEnd;
    samples[index] = (voiced ? 0.5 : 0.005) * Math.sin((2 * Math.PI * 220 * index) / RATE);
  }
  return encodeMonoPcm16Wav(samples, RATE);
}

describe("speechSpanMs", () => {
  it("leaves out the pre-roll and the trailing pause", () => {
    expect(speechSpanMs(phrase(800, 2_000, 700))).toBeCloseTo(2_000, -2);
  });

  it("is the whole clip when it is all speech", () => {
    expect(speechSpanMs(phrase(0, 1_500, 0))).toBe(1_500);
  });

  it("is zero for an empty or silent clip", () => {
    expect(speechSpanMs(encodeMonoPcm16Wav(new Float32Array(0), RATE))).toBe(0);
    expect(speechSpanMs(encodeMonoPcm16Wav(new Float32Array(RATE), RATE))).toBe(0);
  });
});
