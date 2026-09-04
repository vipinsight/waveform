import { SpeechSegmenter } from "./audio/segmenter";
import { encodeMonoPcm16Wav } from "./audio/wav";
import type { UiStage } from "../shared/contracts";

const actionButton = requireElement<HTMLButtonElement>("action-button");
const actionLabel = requireElement<HTMLSpanElement>("action-label");
const status = requireElement<HTMLElement>("status");
const statusText = requireElement<HTMLSpanElement>("status-text");
const transcript = requireElement<HTMLElement>("transcript");
const emptyState = requireElement<HTMLElement>("empty-state");
const clearButton = requireElement<HTMLButtonElement>("clear-button");
const meterBars = Array.from(document.querySelectorAll<HTMLElement>(".meter-bar"));

let modelReady = false;
let listening = false;
let busy = false;
let mediaStream: MediaStream | null = null;
let audioContext: AudioContext | null = null;
let sourceNode: MediaStreamAudioSourceNode | null = null;
let processorNode: ScriptProcessorNode | null = null;
let segmenter: SpeechSegmenter | null = null;
let queuedTranscriptions = 0;

window.parakeetFlow.onModelEvent((event) => {
  setStatus(event.message, event.stage === "error" ? "error" : event.stage);
});

actionButton.addEventListener("click", () => {
  if (busy) return;
  if (listening) {
    stopListening();
  } else {
    void startListening();
  }
});

clearButton.addEventListener("click", () => {
  transcript.replaceChildren();
  emptyState.hidden = false;
  transcript.append(emptyState);
});

async function startListening(): Promise<void> {
  setBusy(true);

  try {
    if (!modelReady) {
      setStatus("Loading model… First run can take several minutes.", "loading");
      await window.parakeetFlow.startModel();
      modelReady = true;
    }

    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    audioContext = new AudioContext();
    await audioContext.resume();
    segmenter = new SpeechSegmenter({ sampleRate: audioContext.sampleRate });
    sourceNode = audioContext.createMediaStreamSource(mediaStream);
    processorNode = audioContext.createScriptProcessor(2048, 1, 1);
    processorNode.onaudioprocess = handleAudio;
    sourceNode.connect(processorNode);
    processorNode.connect(audioContext.destination);

    listening = true;
    actionButton.classList.add("is-listening");
    actionButton.setAttribute("aria-pressed", "true");
    setStatus("Listening — pause to transcribe", "ready");
  } catch (error) {
    modelReady = false;
    setStatus(errorMessage(error), "error");
  } finally {
    setBusy(false);
  }
}

function stopListening(): void {
  const finalSegment = segmenter?.flush();
  if (finalSegment && audioContext) queueTranscription(finalSegment, audioContext.sampleRate);

  processorNode?.disconnect();
  sourceNode?.disconnect();
  mediaStream?.getTracks().forEach((track) => track.stop());
  void audioContext?.close();

  mediaStream = null;
  audioContext = null;
  sourceNode = null;
  processorNode = null;
  segmenter = null;
  listening = false;
  updateMeter(0);
  actionButton.classList.remove("is-listening");
  actionButton.setAttribute("aria-pressed", "false");
  actionLabel.textContent = "Start listening";
  setStatus(queuedTranscriptions > 0 ? "Finishing transcript…" : "Model ready", "ready");
}

function handleAudio(event: AudioProcessingEvent): void {
  const samples = new Float32Array(event.inputBuffer.getChannelData(0));
  updateMeter(calculatePeak(samples));
  const completeSegment = segmenter?.push(samples);
  if (completeSegment && audioContext) {
    queueTranscription(completeSegment, audioContext.sampleRate);
  }
}

function queueTranscription(samples: Float32Array, sampleRate: number): void {
  queuedTranscriptions += 1;
  setStatus("Transcribing locally…", "transcribing");

  let failed = false;
  const wavBytes = encodeMonoPcm16Wav(samples, sampleRate);
  void window.parakeetFlow
    .transcribe(wavBytes)
    .then(({ text }) => {
      if (text) appendTranscript(text);
    })
    .catch((error) => {
      failed = true;
      setStatus(errorMessage(error), "error");
    })
    .finally(() => {
      queuedTranscriptions -= 1;
      if (queuedTranscriptions === 0 && !failed) {
        setStatus(listening ? "Listening — pause to transcribe" : "Model ready", "ready");
      }
    });
}

function appendTranscript(text: string): void {
  emptyState.remove();
  const phrase = document.createElement("span");
  phrase.className = "phrase";
  phrase.textContent = `${text} `;
  transcript.append(phrase);
  transcript.scrollTop = transcript.scrollHeight;
}

function setBusy(value: boolean): void {
  busy = value;
  actionButton.disabled = value;
  actionButton.classList.toggle("is-busy", value);
  actionLabel.textContent = value
    ? "Loading model"
    : listening
      ? "Stop listening"
      : modelReady
        ? "Start listening"
        : "Load model & start";
}

function setStatus(message: string, stage: UiStage): void {
  statusText.textContent = message;
  status.dataset.stage = stage;
}

function updateMeter(level: number): void {
  const normalized = Math.min(1, level * 8);
  meterBars.forEach((bar, index) => {
    const threshold = (index + 1) / meterBars.length;
    const height = normalized >= threshold ? 10 + normalized * 22 : 6;
    bar.style.height = `${height}px`;
  });
}

function calculatePeak(samples: Float32Array): number {
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  return peak;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}

