import { describe, expect, it } from "vitest";
import { concatMonoPcm16Wavs, encodeMonoPcm16Wav } from "../src/renderer/audio/wav";

describe("encodeMonoPcm16Wav", () => {
  it("writes a valid mono PCM16 WAV header and clamps samples", () => {
    const wav = encodeMonoPcm16Wav(new Float32Array([-2, 0, 2]), 16_000);
    const view = new DataView(wav.buffer);

    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(wav.slice(8, 12))).toBe("WAVE");
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(6);
    expect(view.getInt16(44, true)).toBe(-32768);
    expect(view.getInt16(46, true)).toBe(0);
    expect(view.getInt16(48, true)).toBe(32767);
  });
});

describe("concatMonoPcm16Wavs", () => {
  it("joins phrase PCM into one playable WAV", () => {
    const first = encodeMonoPcm16Wav(new Float32Array([0.5, -0.5]), 16_000);
    const second = encodeMonoPcm16Wav(new Float32Array([0.25]), 16_000);
    const joined = concatMonoPcm16Wavs([first, second]);
    const view = new DataView(joined.buffer);

    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(40, true)).toBe(6);
    expect(joined.length).toBe(44 + 6);
  });
});