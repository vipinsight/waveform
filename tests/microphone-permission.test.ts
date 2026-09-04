import { describe, expect, it, vi } from "vitest";
import { requestMicrophonePermission } from "../src/main/microphone-permission";

describe("requestMicrophonePermission", () => {
  it("uses an existing grant without prompting", async () => {
    const ask = vi.fn(async () => true);

    await expect(
      requestMicrophonePermission("darwin", () => "granted", ask),
    ).resolves.toEqual({ granted: true, status: "granted" });
    expect(ask).not.toHaveBeenCalled();
  });

  it("prompts when access has not been decided", async () => {
    const ask = vi.fn(async () => true);

    await expect(
      requestMicrophonePermission("darwin", () => "not-determined", ask),
    ).resolves.toEqual({ granted: true, status: "granted" });
    expect(ask).toHaveBeenCalledOnce();
  });

  it("returns a denied result without repeatedly prompting", async () => {
    const ask = vi.fn(async () => true);

    await expect(
      requestMicrophonePermission("darwin", () => "denied", ask),
    ).resolves.toEqual({ granted: false, status: "denied" });
    expect(ask).not.toHaveBeenCalled();
  });
});
