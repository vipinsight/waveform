import { describe, expect, it } from "vitest";
import { isAudioFile, mixToMono } from "../src/renderer/audio/file-wav";

describe("isAudioFile", () => {
  it("accepts audio MIME types and common extensions", () => {
    expect(isAudioFile(new File([], "talk.wav", { type: "audio/wav" }))).toBe(true);
    expect(isAudioFile(new File([], "talk.mp3", { type: "" }))).toBe(true);
    expect(isAudioFile(new File([], "notes.txt", { type: "text/plain" }))).toBe(false);
  });
});

describe("mixToMono", () => {
  it("averages stereo channels into one", () => {
    const buffer = {
      numberOfChannels: 2,
      length: 2,
      getChannelData: (channel: number) =>
        channel === 0 ? new Float32Array([1, 0]) : new Float32Array([0, 1]),
    } as unknown as AudioBuffer;
    expect(Array.from(mixToMono(buffer))).toEqual([0.5, 0.5]);
  });

  it("copies a mono buffer", () => {
    const mono = new Float32Array([0.25, -0.5]);
    const buffer = {
      numberOfChannels: 1,
      length: 2,
      getChannelData: () => mono,
    } as unknown as AudioBuffer;
    const mixed = mixToMono(buffer);
    expect(mixed).not.toBe(mono);
    expect(Array.from(mixed)).toEqual([0.25, -0.5]);
  });
});
