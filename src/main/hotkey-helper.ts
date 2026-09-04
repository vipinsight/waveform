import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

export interface HelperPermissions {
  /** Required to post the synthetic ⌘V that inserts text into other apps. */
  accessibility: boolean;
  /** Required for the event tap that observes the dictation key. */
  inputMonitoring: boolean;
}

export type HelperEvent =
  | { type: "ready" }
  | { type: "key"; phase: "down" | "up"; keyCode: number }
  | { type: "tap"; active: boolean; reason?: string }
  | ({ type: "permissions" } & HelperPermissions)
  | { type: "paste"; ok: boolean; reason?: string };

export const HELPER_BINARY_PATH = join(__dirname, "waveform-hotkey");

export async function isHelperAvailable(path = HELPER_BINARY_PATH): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parses one line of the helper's stdout. Returns null for anything unrecognised
 * so a future helper version, or stray logging, cannot crash the main process.
 */
export function parseHelperEvent(line: string): HelperEvent | null {
  let payload: unknown;
  try {
    payload = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;

  const message = payload as Record<string, unknown>;
  switch (message.type) {
    case "ready":
      return { type: "ready" };
    case "key":
      if (
        (message.phase === "down" || message.phase === "up") &&
        typeof message.keyCode === "number"
      ) {
        return { type: "key", phase: message.phase, keyCode: message.keyCode };
      }
      return null;
    case "tap":
      if (typeof message.active !== "boolean") return null;
      return {
        type: "tap",
        active: message.active,
        ...(typeof message.reason === "string" ? { reason: message.reason } : {}),
      };
    case "permissions":
      return {
        type: "permissions",
        accessibility: message.accessibility === true,
        inputMonitoring: message.inputMonitoring === true,
      };
    case "paste":
      if (typeof message.ok !== "boolean") return null;
      return {
        type: "paste",
        ok: message.ok,
        ...(typeof message.reason === "string" ? { reason: message.reason } : {}),
      };
    default:
      return null;
  }
}

/**
 * Owns the native helper process: keeps it alive, restarts it if it dies, and
 * exposes a typed command surface.
 */
export class HotkeyHelper {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stopped = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private watchedKeyCode: number | null = null;

  constructor(
    private readonly onEvent: (event: HelperEvent) => void,
    private readonly binaryPath: string = HELPER_BINARY_PATH,
  ) {}

  get isRunning(): boolean {
    return this.child !== null;
  }

  async start(): Promise<boolean> {
    if (this.child) return true;
    if (!(await isHelperAvailable(this.binaryPath))) return false;

    this.stopped = false;
    const child = spawn(this.binaryPath, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;

    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const event = parseHelperEvent(line.trim());
      if (event) this.onEvent(event);
    });

    child.once("exit", () => {
      if (this.child !== child) return;
      this.child = null;
      if (!this.stopped) this.scheduleRestart();
    });
    child.on("error", () => {
      /* Surfaced through exit. */
    });

    // Re-apply the binding so a restarted helper resumes watching the same key.
    if (this.watchedKeyCode !== null) this.watch(this.watchedKeyCode);
    return true;
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const child = this.child;
    this.child = null;
    if (child && !child.killed) child.kill("SIGTERM");
  }

  watch(keyCode: number): void {
    this.watchedKeyCode = keyCode;
    this.send({ type: "watch", keyCode });
  }

  unwatch(): void {
    this.watchedKeyCode = null;
    this.send({ type: "unwatch" });
  }

  paste(text: string): void {
    this.send({ type: "paste", text });
  }

  refreshPermissions(): void {
    this.send({ type: "permissions" });
  }

  requestPermission(scope: "accessibility" | "input-monitoring"): void {
    this.send({ type: "request", scope });
  }

  private send(command: Record<string, unknown>): void {
    if (!this.child?.stdin.writable) return;
    this.child.stdin.write(`${JSON.stringify(command)}\n`, () => {
      /* A dead pipe surfaces as an exit; nothing to do here. */
    });
  }

  private scheduleRestart(): void {
    if (this.restartTimer) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.start();
    }, 1_500);
  }
}
