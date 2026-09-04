import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { MODEL_ID, ModelEvent, TranscriptionResult } from "../shared/contracts";

const DEFAULT_PORT = 8178;
const START_TIMEOUT_MS = 15 * 60 * 1000;

type EventListener = (event: ModelEvent) => void;

export class ModelServer {
  private child: ChildProcessWithoutNullStreams | null = null;
  private startPromise: Promise<void> | null = null;
  private ownsServer = false;
  private lastLogLine = "";
  private transcriptionQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly emit: EventListener) {}

  get port(): number {
    const configured = Number.parseInt(process.env.PARAKEET_FLOW_PORT ?? "", 10);
    return Number.isInteger(configured) && configured > 0 && configured < 65536
      ? configured
      : DEFAULT_PORT;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    if (await this.isReady()) {
      this.emit({ stage: "ready", message: "Model ready" });
      return;
    }

    if (!this.startPromise) {
      this.startPromise = this.startProcess().finally(() => {
        this.startPromise = null;
      });
    }

    return this.startPromise;
  }

  async stop(): Promise<void> {
    if (this.child && this.ownsServer && !this.child.killed) {
      this.child.kill("SIGTERM");
    }
    this.child = null;
    this.ownsServer = false;
  }

  transcribe(wavBytes: Uint8Array): Promise<TranscriptionResult> {
    const job = this.transcriptionQueue.then(() => this.sendTranscription(wavBytes));
    this.transcriptionQueue = job.catch(() => undefined);
    return job;
  }

  private async startProcess(): Promise<void> {
    this.emit({ stage: "starting", message: "Finding local speech engine…" });
    const binary = await findRuntime();

    if (!binary) {
      throw new Error(
        "nemo-speech is not installed. Run `pnpm setup:model`, then try again.",
      );
    }

    this.emit({ stage: "loading", message: "Loading Parakeet on Metal…" });
    const child = spawn(
      binary,
      [
        "serve",
        "--asr-model",
        MODEL_ID,
        "--device",
        process.platform === "darwin" && process.arch === "arm64" ? "metal" : "cpu",
        "--host",
        "127.0.0.1",
        "--port",
        String(this.port),
        "--no-ui",
      ],
      { env: process.env },
    );

    this.child = child;
    this.ownsServer = true;
    this.captureLogs(child);

    child.once("exit", (code, signal) => {
      if (this.child === child) {
        this.child = null;
        this.ownsServer = false;
      }
      if (code !== 0 && signal !== "SIGTERM") {
        this.emit({
          stage: "error",
          message: this.lastLogLine || `Speech engine stopped with code ${code ?? "unknown"}`,
        });
      }
    });

    try {
      await this.waitUntilReady(child);
      this.emit({ stage: "ready", message: "Listening locally" });
      return;
    } catch (error) {
      if (!child.killed) child.kill("SIGTERM");
      throw error;
    }
  }

  private captureLogs(child: ChildProcessWithoutNullStreams): void {
    const capture = (chunk: Buffer): void => {
      const lines = chunk
        .toString("utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

      for (const line of lines) {
        this.lastLogLine = line;
        const lower = line.toLowerCase();
        if (lower.includes("download")) {
          this.emit({ stage: "downloading", message: "Downloading model…" });
        } else if (lower.includes("load") || lower.includes("warm")) {
          this.emit({ stage: "loading", message: "Loading Parakeet on Metal…" });
        }
      }
    };

    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
  }

  private async waitUntilReady(child: ChildProcessWithoutNullStreams): Promise<void> {
    const deadline = Date.now() + START_TIMEOUT_MS;

    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(this.lastLogLine || `Speech engine stopped with code ${child.exitCode}`);
      }
      if (await this.isReady()) return;
      await delay(600);
    }

    throw new Error("Timed out while loading Parakeet model.");
  }

  private async isReady(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/ready`, {
        signal: AbortSignal.timeout(700),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async sendTranscription(wavBytes: Uint8Array): Promise<TranscriptionResult> {
    if (!(await this.isReady())) {
      throw new Error("Speech model is not ready.");
    }

    const audioBuffer = new ArrayBuffer(wavBytes.byteLength);
    new Uint8Array(audioBuffer).set(wavBytes);
    const form = new FormData();
    form.append("file", new Blob([audioBuffer], { type: "audio/wav" }), "speech.wav");
    form.append("model", "default");
    form.append("response_format", "json");

    const response = await fetch(`${this.baseUrl}/v1/audio/transcriptions`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(120_000),
    });

    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Transcription failed (${response.status}): ${body}`);
    }

    const parsed = JSON.parse(body) as { text?: unknown };
    if (typeof parsed.text !== "string") {
      throw new Error("Transcription response did not contain text.");
    }

    return { text: parsed.text.trim() };
  }
}

async function findRuntime(): Promise<string | null> {
  const pathDirectories = process.env.PATH?.split(delimiter) ?? [];
  const candidates = [
    process.env.NEMO_SPEECH_BIN,
    join(homedir(), ".local", "bin", "nemo-speech"),
    ...pathDirectories.map((directory) => join(directory, "nemo-speech")),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try next candidate.
    }
  }

  return null;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

