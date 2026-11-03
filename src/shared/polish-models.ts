/**
 * The models the local polish engine can run, in the order the AI Polish page
 * lists them: the Qwen3 ladder lightest first, then the other families.
 *
 * src-tauri/src/local_llm.rs holds the same ids in the same order, and carries
 * what actually runs them: the weight file, its hash, and the memory it wants.
 * `polish-model-registry.test.ts` compares the two lists, because nothing else
 * would notice them drifting apart.
 *
 * A model here has to follow an instruction rather than continue a sentence,
 * which rules out GPT-2 and the other base models however small they are, and
 * it has to be quantized to GGUF, which is what llama.cpp reads. Qwen3 is the
 * smallest instruction-tuned family that clears both bars; Gemma 4 and
 * gpt-oss are there for a Mac with the memory to run something larger.
 */
export const POLISH_MODELS = [
  { id: "qwen3-0.6b-q4", label: "Qwen3 0.6B · Q4" },
  { id: "qwen3-0.6b-q8", label: "Qwen3 0.6B · Q8" },
  { id: "qwen3-1.7b-q4", label: "Qwen3 1.7B · Q4" },
  { id: "qwen3-4b-q4", label: "Qwen3 4B · Q4" },
  { id: "qwen3-8b-q4", label: "Qwen3 8B · Q4" },
  { id: "qwen3-14b-q4", label: "Qwen3 14B · Q4" },
  { id: "gemma4-12b-q4", label: "Gemma 4 12B · Q4" },
  { id: "gpt-oss-20b-mxfp4", label: "gpt-oss 20B · MXFP4" },
] as const;

export type PolishModelId = (typeof POLISH_MODELS)[number]["id"];

/** The lightest, and the only one most Macs need for tidying a paragraph. */
export const DEFAULT_POLISH_MODEL_ID: PolishModelId = "qwen3-0.6b-q4";

export function isPolishModelId(value: unknown): value is PolishModelId {
  return POLISH_MODELS.some((model) => model.id === value);
}
