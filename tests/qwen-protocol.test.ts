import { describe, expect, it } from "vitest";
import { parseQwenWorkerMessage } from "../src/main/qwen-protocol";

describe("parseQwenWorkerMessage", () => {
  it("parses ready and transcription messages", () => {
    expect(parseQwenWorkerMessage('WAVEFORM:{"type":"ready","device":"mps"}')).toEqual({
      type: "ready",
      device: "mps",
    });
    expect(
      parseQwenWorkerMessage(
        'WAVEFORM:{"type":"result","id":"job-1","text":"hello","language":"English"}',
      ),
    ).toEqual({ type: "result", id: "job-1", text: "hello", language: "English" });
  });

  it("ignores ordinary library logs and malformed protocol data", () => {
    expect(parseQwenWorkerMessage("Loading checkpoint shards")).toBeNull();
    expect(parseQwenWorkerMessage("WAVEFORM:not-json")).toBeNull();
  });
});
