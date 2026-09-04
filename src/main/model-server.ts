import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import type { ModelEvent, ModelStage, TranscriptionResult } from "../shared/contracts";
import {
  DEFAULT_SPEECH_MODEL_ID,
  getSpeechModel,
  type SpeechModelId,
} from "../shared/models";
import { parseQwenWorkerMessage } from "./qwen-protocol";

const DEFAULT_PORT = 8178;
const START_TIMEOUT_MS = 15 * 60 * 1000;
const TRANSCRIPTION_TIMEOUT_MS = 2 * 60 * 1000;
const PROJECT_ROOT = join(__dirname, "../../..");

type EventListener = (event: ModelEvent) => void;
type PendingQwenJob = {
  resolve: (result: TranscriptionResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export class ModelServer {
  private child: ChildProcessWithoutNullStreams | null = null;
  private startPromise: Promise<void> | null = null;
  private lastLogLine = "";
  private transcriptionQueue: Promise<unknown> = Promise.resolve();
  private selectedModelId: SpeechModelId = DEFAULT_SPEECH_MODEL_ID;
  private qwenReady = false;
  private qwenJobSequence = 0;
  private readonly qwenJobs = new Map<string, PendingQwenJob>();

  constructor(private readonly emit: EventListener) {}

  get port(): number {
    const configured = Number.parseInt(
      process.env.WAVEFORM_PORT ?? process.env.PARAKEET_FLOW_PORT ?? "",
      10,
    );
    return Number.isInteger(configured) && configured > 0 && configured < 65536
      ? configured
      : DEFAULT_PORT;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async selectModel(modelId: SpeechModelId): Promise<void> {
    if (modelId !== this.selectedModelId) {
      await this.stop();
      this.selectedModelId = modelId;
    }
    await this.start();
  }

  async start(): Promise<void> {
    const model = getSpeechModel(this.selectedModelId);
    const ready =
      model.engine === "nemo"
        ? await this.isParakeetReady()
        : this.qwenReady && this.child !== null;

    if (ready) {
      this.emitStage("ready", `${model.shortLabel} ready`);
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
    const child = this.child;
    this.child = null;
    this.qwenReady = false;
    if (child && !child.killed) child.kill("SIGTERM");
    this.rejectQwenJobs(new Error("Speech model changed before transcription finished."));
  }

  transcribe(wavBytes: Uint8Array): Promise<TranscriptionResult> {
    const job = this.transcriptionQueue.then(() => this.sendTranscription(wavBytes));
    this.transcriptionQueue = job.catch(() => undefined);
    return job;
  }

  private async startProcess(): Promise<void> {
    const model = getSpeechModel(this.selectedModelId);
    this.lastLogLine = "";
    this.emitStage("starting", `Starting ${model.shortLabel}…`);

    if (model.engine === "nemo") {
      await this.startParakeet(model.modelId);
    } else {
      await this.startQwen(model.modelId);
    }

    this.emitStage("ready", `${model.shortLabel} ready`);
  }

  private async startParakeet(modelId: string): Promise<void> {
    const binary = await findNemoRuntime();
    if (!binary) {
      throw new Error(
        "nemo-speech is not installed. Run `pnpm setup:model`, then try again.",
      );
    }

    this.emitStage("loading", "Loading Parakeet on Metal…");
    const child = spawn(
      binary,
      [
        "serve",
        "--asr-model",
        modelId,
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
    this.captureParakeetLogs(child);
    this.handleChildExit(child);

    try {
      await this.waitUntilParakeetReady(child);
    } catch (error) {
      if (!child.killed) child.kill("SIGTERM");
      throw error;
    }
  }

  private async startQwen(modelId: string): Promise<void> {
    const python = await findQwenRuntime();
    if (!python) {
      throw new Error(
        "Qwen3-ASR is not installed. Run `pnpm setup:qwen`, then try again.",
      );
    }

    this.emitStage("loading", "Loading Qwen3-ASR on Apple Silicon…");
    const child = spawn(
      python,
      [join(PROJECT_ROOT, "scripts", "qwen-worker.py"), "--model", modelId],
      {
        env: {
          ...process.env,
          PYTHONUNBUFFERED: "1",
          PYTORCH_ENABLE_MPS_FALLBACK: "1",
        },
      },
    );

    this.child = child;
    this.captureQwenMessages(child);
    this.handleChildExit(child);

    try {
      await this.waitUntilQwenReady(child);
    } catch (error) {
      if (!child.killed) child.kill("SIGTERM");
      throw error;
    }
  }

  private handleChildExit(child: ChildProcessWithoutNullStreams): void {
    child.once("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.qwenReady = false;
      this.rejectQwenJobs(new Error(this.lastLogLine || "Speech engine stopped."));
      if (code !== 0 && signal !== "SIGTERM") {
        this.emitStage(
          "error",
          this.lastLogLine || `Speech engine stopped with code ${code ?? "unknown"}`,
        );
      }
    });
  }

  private captureParakeetLogs(child: ChildProcessWithoutNullStreams): void {
    const capture = (chunk: Buffer): void => {
      for (const line of splitLogLines(chunk)) this.recordModelLog(line);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
  }

  private captureQwenMessages(child: ChildProcessWithoutNullStreams): void {
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const message = parseQwenWorkerMessage(line.trim());
      if (!message) {
        this.recordModelLog(line);
        return;
      }

      if (message.type === "ready") {
        this.qwenReady = true;
        this.lastLogLine = `Qwen3-ASR ready on ${message.device}`;
        return;
      }

      if (message.type === "result") {
        const job = this.qwenJobs.get(message.id);
        if (!job) return;
        clearTimeout(job.timeout);
        this.qwenJobs.delete(message.id);
        job.resolve({ text: message.text.trim() });
        return;
      }

      this.lastLogLine = message.message;
      if (message.id) {
        const job = this.qwenJobs.get(message.id);
        if (!job) return;
        clearTimeout(job.timeout);
        this.qwenJobs.delete(message.id);
        job.reject(new Error(message.message));
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      for (const line of splitLogLines(chunk)) this.recordModelLog(line);
    });
  }

  private recordModelLog(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    this.lastLogLine = trimmed;
    const lower = trimmed.toLowerCase();
    if (lower.includes("download") || lower.includes("fetch")) {
      this.emitStage("downloading", "Downloading model…");
    } else if (
      lower.includes("load") ||
      lower.includes("checkpoint") ||
      lower.includes("warm")
    ) {
      const model = getSpeechModel(this.selectedModelId);
      this.emitStage("loading", `Loading ${model.shortLabel}…`);
    }
  }

  private async waitUntilParakeetReady(child: ChildProcessWithoutNullStreams): Promise<void> {
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw this.engineStoppedError(child.exitCode);
      if (await this.isParakeetReady()) return;
      await delay(600);
    }
    throw new Error("Timed out while loading Parakeet model.");
  }

  private async waitUntilQwenReady(child: ChildProcessWithoutNullStreams): Promise<void> {
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw this.engineStoppedError(child.exitCode);
      if (this.qwenReady) return;
      await delay(300);
    }
    throw new Error("Timed out while loading Qwen3-ASR model.");
  }

  private engineStoppedError(code: number): Error {
    return new Error(this.lastLogLine || `Speech engine stopped with code ${code}`);
  }

  private async isParakeetReady(): Promise<boolean> {
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
    return getSpeechModel(this.selectedModelId).engine === "qwen"
      ? this.sendQwenTranscription(wavBytes)
      : this.sendParakeetTranscription(wavBytes);
  }

  private async sendParakeetTranscription(
    wavBytes: Uint8Array,
  ): Promise<TranscriptionResult> {
    if (!(await this.isParakeetReady())) throw new Error("Speech model is not ready.");

    const audioBuffer = new ArrayBuffer(wavBytes.byteLength);
    new Uint8Array(audioBuffer).set(wavBytes);
    const form = new FormData();
    form.append("file", new Blob([audioBuffer], { type: "audio/wav" }), "speech.wav");
    form.append("model", "default");
    form.append("response_format", "json");

    const response = await fetch(`${this.baseUrl}/v1/audio/transcriptions`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
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

  private sendQwenTranscription(wavBytes: Uint8Array): Promise<TranscriptionResult> {
    const child = this.child;
    if (!child || !this.qwenReady) {
      return Promise.reject(new Error("Qwen3-ASR is not ready."));
    }

    const id = `qwen-${++this.qwenJobSequence}`;
    return new Promise<TranscriptionResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.qwenJobs.delete(id);
        reject(new Error("Qwen3-ASR transcription timed out."));
      }, TRANSCRIPTION_TIMEOUT_MS);
      this.qwenJobs.set(id, { resolve, reject, timeout });

      const request = JSON.stringify({
        id,
        audio: Buffer.from(wavBytes).toString("base64"),
      });
      child.stdin.write(`${request}\n`, (error) => {
        if (!error) return;
        clearTimeout(timeout);
        this.qwenJobs.delete(id);
        reject(error);
      });
    });
  }

  private rejectQwenJobs(error: Error): void {
    for (const job of this.qwenJobs.values()) {
      clearTimeout(job.timeout);
      job.reject(error);
    }
    this.qwenJobs.clear();
  }

  private emitStage(stage: ModelStage, message: string): void {
    this.emit({ stage, message, modelId: this.selectedModelId });
  }
}

async function findNemoRuntime(): Promise<string | null> {
  const pathDirectories = process.env.PATH?.split(delimiter) ?? [];
  const candidates = [
    process.env.NEMO_SPEECH_BIN,
    join(homedir(), ".local", "bin", "nemo-speech"),
    ...pathDirectories.map((directory) => join(directory, "nemo-speech")),
  ].filter((candidate): candidate is string => Boolean(candidate));
  return findExecutable(candidates);
}

async function findQwenRuntime(): Promise<string | null> {
  const candidates = [
    process.env.QWEN_ASR_PYTHON,
    join(PROJECT_ROOT, ".venv-qwen", "bin", "python3"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  return findExecutable(candidates);
}

async function findExecutable(candidates: string[]): Promise<string | null> {
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

function splitLogLines(chunk: Buffer): string[] {
  return chunk.toString("utf8").split(/\r?\n/).filter(Boolean);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
