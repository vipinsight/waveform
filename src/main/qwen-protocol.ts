export const QWEN_PROTOCOL_PREFIX = "LOCAL_SPEECH:";

export type QwenWorkerMessage =
  | { type: "ready"; device: string }
  | { type: "result"; id: string; text: string; language: string }
  | { type: "error"; id?: string; message: string };

export function parseQwenWorkerMessage(line: string): QwenWorkerMessage | null {
  if (!line.startsWith(QWEN_PROTOCOL_PREFIX)) return null;

  try {
    const value = JSON.parse(line.slice(QWEN_PROTOCOL_PREFIX.length)) as Record<string, unknown>;
    if (value.type === "ready" && typeof value.device === "string") {
      return { type: "ready", device: value.device };
    }
    if (
      value.type === "result" &&
      typeof value.id === "string" &&
      typeof value.text === "string" &&
      typeof value.language === "string"
    ) {
      return {
        type: "result",
        id: value.id,
        text: value.text,
        language: value.language,
      };
    }
    if (
      value.type === "error" &&
      (value.id === undefined || typeof value.id === "string") &&
      typeof value.message === "string"
    ) {
      return value.id === undefined
        ? { type: "error", message: value.message }
        : { type: "error", id: value.id, message: value.message };
    }
  } catch {
    return null;
  }

  return null;
}
