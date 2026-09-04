import { describe, expect, it } from "vitest";
import { qwenRuntimeCandidates } from "../src/main/qwen-runtime";

describe("qwenRuntimeCandidates", () => {
  it("checks packaged-app runtime before legacy project runtime", () => {
    expect(
      qwenRuntimeCandidates("/Users/vipin/Library/Application Support/Waveform", "/project"),
    ).toEqual([
      "/Users/vipin/Library/Application Support/Waveform/qwen/bin/python3",
      "/project/.venv-qwen/bin/python3",
    ]);
  });

  it("prefers explicitly configured Python", () => {
    expect(qwenRuntimeCandidates("/user-data", "/project", "/custom/python3")).toEqual([
      "/custom/python3",
      "/user-data/qwen/bin/python3",
      "/project/.venv-qwen/bin/python3",
    ]);
  });
});
