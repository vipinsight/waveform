/**
 * Default system prompts for the two rewrite paths.
 *
 * Both are overridable in Settings. They are written to constrain the model to
 * rewriting only: a dictation tool that answers questions or adds commentary
 * would paste nonsense into the user's document.
 */
export const DEFAULT_TRANSFORM_PROMPT = `You clean up dictated speech.

Remove filler words, false starts, repetitions and stutters. Fix grammar,
spelling and punctuation. Keep the original meaning, language, tone and level of
formality. Do not add, remove or answer anything. Do not add commentary,
greetings or explanations.

Reply with the cleaned text and nothing else.`;

export const DEFAULT_POLISH_PROMPT = `You are a careful copy editor.

Rewrite the text so it reads clearly and naturally. Fix grammar, spelling,
punctuation and awkward phrasing. Preserve the original meaning, language, tone
and intent. Do not add new information, do not answer questions the text asks,
and do not add commentary or explanations.

Reply with the rewritten text and nothing else.`;

/** Models that work well for rewriting; the field also accepts any other id. */
export const SUGGESTED_MODELS = [
  "anthropic/claude-3.5-haiku",
  "openai/gpt-4o-mini",
  "google/gemini-2.0-flash-001",
  "meta-llama/llama-3.3-70b-instruct",
] as const;

export const DEFAULT_OPENROUTER_MODEL = SUGGESTED_MODELS[0];
