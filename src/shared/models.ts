export const SPEECH_MODELS = [
  {
    id: "parakeet-tdt-0.6b-v3",
    label: "NVIDIA Parakeet TDT 0.6B v3",
    shortLabel: "Parakeet 0.6B",
    modelId: "nvidia/parakeet-tdt-0.6b-v3",
    engine: "nemo",
  },
  {
    id: "qwen3-asr-0.6b",
    label: "Qwen3-ASR 0.6B",
    shortLabel: "Qwen3-ASR 0.6B",
    modelId: "Qwen/Qwen3-ASR-0.6B",
    engine: "qwen",
  },
] as const;

export type SpeechModelDefinition = (typeof SPEECH_MODELS)[number];
export type SpeechModelId = SpeechModelDefinition["id"];
export type SpeechEngine = SpeechModelDefinition["engine"];

export const DEFAULT_SPEECH_MODEL_ID: SpeechModelId = SPEECH_MODELS[0].id;

export function isSpeechModelId(value: unknown): value is SpeechModelId {
  return SPEECH_MODELS.some(({ id }) => id === value);
}

export function getSpeechModel(id: SpeechModelId): SpeechModelDefinition {
  const model = SPEECH_MODELS.find((candidate) => candidate.id === id);
  if (!model) throw new Error(`Unknown speech model: ${id}`);
  return model;
}
