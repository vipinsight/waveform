/**
 * Models offered for rewriting, best first.
 *
 * Every id here was checked against OpenRouter's catalogue: the previous
 * default, `anthropic/claude-3.5-haiku`, is not a model OpenRouter serves, so
 * every rewrite request 404ed and the raw transcript was inserted instead --
 * silently, because a failed rewrite falls back rather than losing what was
 * said.
 *
 * The order is from measurement, not from price. Given the dictation prompt and
 * "Um so, like I think we should uh probably ship it tomorrow, okay?", the first
 * two return the same sentence and the first costs a fifth as much; the last two
 * are cheaper again but weaker -- one drops "probably", changing the meaning,
 * and the other leaves the trailing "okay?".
 */
export const SUGGESTED_MODELS = [
  "openai/gpt-4.1-mini",
  "anthropic/claude-haiku-4.5",
  "google/gemini-2.5-flash",
  "google/gemini-2.5-flash-lite",
  "openai/gpt-4.1-nano",
] as const;

export const DEFAULT_OPENROUTER_MODEL = SUGGESTED_MODELS[0];

/**
 * The suggested models as a person would say them. The ids above are what
 * OpenRouter needs; "openai/gpt-4.1-mini" is not what anyone wants to read in
 * a menu. An id not listed here -- one typed in -- is shown as itself.
 */
const OPENROUTER_MODEL_NAMES: Record<string, string> = {
  "openai/gpt-4.1-mini": "GPT-4.1 mini",
  "anthropic/claude-haiku-4.5": "Claude Haiku 4.5",
  "google/gemini-2.5-flash": "Gemini 2.5 Flash",
  "google/gemini-2.5-flash-lite": "Gemini 2.5 Flash Lite",
  "openai/gpt-4.1-nano": "GPT-4.1 nano",
};

export function openRouterModelName(id: string): string {
  return OPENROUTER_MODEL_NAMES[id] ?? id;
}
