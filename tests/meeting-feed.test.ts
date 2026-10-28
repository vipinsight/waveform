import { describe, expect, it } from "vitest";
import type { MeetingLine } from "../src/shared/contracts";
import { MAX_LINES, clock, isFollowing, mergeLines, speakerName, voiceOf } from "../src/renderer/meeting-feed";

function line(idx: number, overrides: Partial<MeetingLine> = {}): MeetingLine {
  return { idx, startMs: idx * 1_000, endMs: idx * 1_000 + 900, track: "mic", speaker: "me", text: `line ${idx}`, ...overrides };
}

describe("mergeLines", () => {
  it("keeps each line once, in order", () => {
    const merged = mergeLines([line(0), line(2)], [line(2), line(1), line(3)]);
    expect(merged.map((l) => l.idx)).toEqual([0, 1, 2, 3]);
  });

  it("keeps only the latest lines", () => {
    const many = Array.from({ length: MAX_LINES + 5 }, (_, i) => line(i));
    const merged = mergeLines([], many);
    expect(merged).toHaveLength(MAX_LINES);
    expect(merged[0]?.idx).toBe(5);
    expect(merged.at(-1)?.idx).toBe(MAX_LINES + 4);
  });
});

describe("speakerName", () => {
  it("calls an untagged line from the call Them", () => {
    expect(speakerName(line(0, { track: "system", speaker: null }), {}, "Vipin")).toBe("Them");
  });

  it("uses the local name for the microphone", () => {
    expect(speakerName(line(0), {}, "Vipin")).toBe("Vipin");
    expect(speakerName(line(0), {}, null)).toBe("You");
  });

  it("prefers a name the user gave", () => {
    expect(speakerName(line(0, { speaker: "speaker_01" }), { speaker_01: "Ana" }, null)).toBe("Ana");
    expect(speakerName(line(0, { speaker: "speaker_01" }), {}, null)).toBe("Speaker 2");
  });
});

describe("voiceOf", () => {
  it("groups untagged lines by track", () => {
    expect(voiceOf(line(0, { track: "system", speaker: null }))).toBe("system");
    expect(voiceOf(line(0))).toBe("me");
  });
});

describe("isFollowing", () => {
  it("follows at or near the bottom only", () => {
    expect(isFollowing(600, 400, 1_000)).toBe(true);
    expect(isFollowing(580, 400, 1_000)).toBe(true);
    expect(isFollowing(300, 400, 1_000)).toBe(false);
  });
});

describe("clock", () => {
  it("adds hours only past the hour", () => {
    expect(clock(65_000)).toBe("01:05");
    expect(clock(3_725_000)).toBe("1:02:05");
  });
});
