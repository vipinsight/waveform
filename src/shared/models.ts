/**
 * Every model the interface knows about, in the order the models page lists
 * them: Parakeet and Qwen first, then Whisper lightest-first within each group.
 *
 * Whisper fills most of it because whisper.cpp is linked into the app, so each
 * size and quantization of it is a model the app can fetch by itself.
 *
 * src-tauri/src/model_server.rs holds the same ids in the same order, and
 * carries what actually runs them: an engine, a weight source, a download, and
 * the memory each one wants. `speech-model-registry.test.ts` compares the two
 * lists, because nothing else would notice them drifting apart.
 *
 * One name per model, matching Rust's `short_label`. There used to be a second,
 * longer one here, which is how the same model came to be called "Parakeet
 * 0.6B" on one page and "NVIDIA Parakeet TDT 0.6B v3" on another.
 */
export const SPEECH_MODELS = [
  {
    id: "parakeet-tdt-0.6b-v3",
    label: "Parakeet 0.6B",
    modelId: "nvidia/parakeet-tdt-0.6b-v3",
    engine: "nemo",
  },
  {
    id: "qwen3-asr-0.6b",
    label: "Qwen3-ASR 0.6B",
    modelId: "Qwen/Qwen3-ASR-0.6B",
    engine: "qwen",
  },
  { id: "whisper-cpp-tiny", label: "Whisper Tiny", modelId: "ggml-tiny.bin", engine: "whisper-cpp" },
  { id: "whisper-cpp-base", label: "Whisper Base", modelId: "ggml-base.bin", engine: "whisper-cpp" },
  { id: "whisper-cpp-small", label: "Whisper Small", modelId: "ggml-small.bin", engine: "whisper-cpp" },
  {
    id: "whisper-cpp-small-q5",
    label: "Whisper Small · Q5",
    modelId: "ggml-small-q5_1.bin",
    engine: "whisper-cpp",
  },
  {
    id: "whisper-cpp-medium",
    label: "Whisper Medium",
    modelId: "ggml-medium.bin",
    engine: "whisper-cpp",
  },
  {
    id: "whisper-cpp-medium-q5",
    label: "Whisper Medium · Q5",
    modelId: "ggml-medium-q5_0.bin",
    engine: "whisper-cpp",
  },
  {
    id: "whisper-cpp-large-v3-turbo",
    label: "Whisper Large v3 Turbo",
    modelId: "ggml-large-v3-turbo.bin",
    engine: "whisper-cpp",
  },
  {
    id: "whisper-cpp-large-v3-turbo-q5",
    label: "Whisper Large v3 Turbo · Q5",
    modelId: "ggml-large-v3-turbo-q5_0.bin",
    engine: "whisper-cpp",
  },
  {
    id: "whisper-cpp-large-v3-q5",
    label: "Whisper Large v3 · Q5",
    modelId: "ggml-large-v3-q5_0.bin",
    engine: "whisper-cpp",
  },
  {
    id: "whisper-cpp-large-v3",
    label: "Whisper Large v3",
    modelId: "ggml-large-v3.bin",
    engine: "whisper-cpp",
  },
  {
    id: "whisper-cpp-tiny-en",
    label: "Whisper Tiny · English",
    modelId: "ggml-tiny.en.bin",
    engine: "whisper-cpp",
  },
  {
    id: "whisper-cpp-base-en",
    label: "Whisper Base · English",
    modelId: "ggml-base.en.bin",
    engine: "whisper-cpp",
  },
  {
    id: "whisper-cpp-small-en",
    label: "Whisper Small · English",
    modelId: "ggml-small.en.bin",
    engine: "whisper-cpp",
  },
  {
    id: "whisper-cpp-medium-en",
    label: "Whisper Medium · English",
    modelId: "ggml-medium.en.bin",
    engine: "whisper-cpp",
  },
] as const;

export type SpeechModelDefinition = (typeof SPEECH_MODELS)[number];
export type SpeechModelId = SpeechModelDefinition["id"];
export type SpeechEngine = SpeechModelDefinition["engine"];

/**
 * What a fresh install starts on, and what an unrecognised stored id falls
 * back to. `DEFAULT_MODEL_ID` in model_server.rs is the same choice.
 *
 * Named rather than "the first entry", because the table is ordered for the
 * models page to read, Parakeet first, and that is not a model a fresh install
 * can run without a terminal. Small runs on every Apple Silicon Mac and is
 * accurate enough that a first dictation is not a bad first impression.
 */
export const DEFAULT_SPEECH_MODEL_ID: SpeechModelId = "whisper-cpp-small";

export function isSpeechModelId(value: unknown): value is SpeechModelId {
  return SPEECH_MODELS.some(({ id }) => id === value);
}

export function getSpeechModel(id: SpeechModelId): SpeechModelDefinition {
  const model = SPEECH_MODELS.find((candidate) => candidate.id === id);
  if (!model) throw new Error(`Unknown speech model: ${id}`);
  return model;
}
