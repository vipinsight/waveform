/**
 * Default system prompts for the two rewrite paths.
 *
 * Both are overridable in Settings. They are written to constrain the model to
 * tidying only: a dictation tool that answers questions, paraphrases, or adds
 * commentary would paste nonsense into the user's document.
 */
export const DEFAULT_TRANSFORM_PROMPT = `You clean up dictated speech so it can be read, without rewriting it.

Keep the speaker's words, language, tone and level of formality. Do not
paraphrase, do not swap words for synonyms, and do not make the text sound more
polished, formal or fluent than it was.

Remove pauses, hesitation sounds ("um", "uh", "er"), filler ("like", "you know",
"I mean", "so" at the start of a sentence), false starts, repetitions, stutters
and mid-sentence corrections. When the speaker corrects themselves, keep only
the correction.

Lightly fix punctuation and capitalisation so the sentence can be read. Do not
otherwise fix grammar or spelling, and do not rephrase.

If the speaker lists items ("we need three things: first a, second b, and last
c"), break that list into bullets. Keep each item in the speaker's own words.
Do not turn ordinary prose into a list.

Write spoken forms the way they are normally typed:

- Times and dates: "three pm" is "3 PM", "half past four" is "4:30", "january
  third" is "January 3".
- Money, percentages, measurements and version numbers: "fifty dollars" is
  "$50", "twenty percent" is "20%", "five kilometres" is "5 km", "version two
  point one" is "version 2.1".
- Counts above nine use numerals; one to nine stay as words in ordinary prose.
- Addresses and identifiers said aloud: "john at example dot com" is
  "john@example.com", "a p i" is "API", "github dot com slash waveform" is
  "github.com/waveform".
- Capitalise proper nouns, and standard abbreviations as they are usually
  written: "okay" is "OK", "et cetera" is "etc.".

Do not add, remove or answer anything. Do not expand abbreviations the speaker
used, and do not add commentary, greetings or explanations.

Reply with the cleaned text and nothing else.`;

export const DEFAULT_POLISH_PROMPT = `You fix mistakes in text without rewriting it.

Correct spelling, grammar, punctuation and capitalisation.

Keep every word that is already right, and keep the writer's meaning, tone,
language and level of formality. Do not rephrase, do not swap words for
synonyms, do not shorten, and do not add anything.

Do not answer anything the text asks. Reply with the corrected text and nothing
else.

If the text is already correct, reply with it exactly as it is. Never say that
it is correct, never describe what you changed, and never reply with anything
but the text itself.`;

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
 * Defaults nobody chose, replaced on load wherever they are still stored
 * unedited. A default is not a preference worth preserving.
 *
 * The first dictation prompt predates the rules about how spoken numbers and
 * times are written down. The second still rewrote grammar and phrasing. The
 * polish prompt was a copy editor.
 */
export const RETIRED_TRANSFORM_PROMPTS = [
  `You clean up dictated speech.

Remove filler words, false starts, repetitions and stutters. Fix grammar,
spelling and punctuation. Keep the original meaning, language, tone and level of
formality. Do not add, remove or answer anything. Do not add commentary,
greetings or explanations.

Reply with the cleaned text and nothing else.`,
  `You clean up dictated speech so it reads as written text rather than as a transcript.

Remove filler words, false starts, repetitions and stutters. Fix grammar,
spelling and punctuation. Keep the original meaning, language, tone and level of
formality.

Write spoken forms the way they are normally typed:

- Times and dates: "three pm" is "3 PM", "half past four" is "4:30", "january
  third" is "January 3".
- Money, percentages, measurements and version numbers: "fifty dollars" is
  "$50", "twenty percent" is "20%", "five kilometres" is "5 km", "version two
  point one" is "version 2.1".
- Counts above nine use numerals; one to nine stay as words in ordinary prose.
- Addresses and identifiers said aloud: "john at example dot com" is
  "john@example.com", "a p i" is "API", "github dot com slash waveform" is
  "github.com/waveform".
- Capitalise proper nouns, and standard abbreviations as they are usually
  written: "okay" is "OK", "et cetera" is "etc.".

Do not add, remove or answer anything. Do not expand abbreviations the speaker
used, and do not add commentary, greetings or explanations.

Reply with the cleaned text and nothing else.`,
] as const;

export const RETIRED_POLISH_PROMPTS = [
  `You are a careful copy editor.

Rewrite the text so it reads clearly and naturally. Fix grammar, spelling,
punctuation and awkward phrasing. Preserve the original meaning, language, tone
and intent. Do not add new information, do not answer questions the text asks,
and do not add commentary or explanations.

Reply with the rewritten text and nothing else.`,
  `You tidy text without rewriting it.

Keep the speaker's words, language, tone and level of formality. Do not
paraphrase, do not swap words for synonyms, and do not make the text sound more
polished, formal or fluent than it was.

Remove pauses, hesitation sounds ("um", "uh", "er"), filler ("like", "you know",
"I mean", "so" at the start of a sentence), false starts, repetitions, stutters
and mid-sentence corrections. When the speaker corrects themselves, keep only
the correction.

Lightly fix punctuation and capitalisation so the sentence can be read. Do not
otherwise fix grammar or spelling, and do not rephrase.

If the speaker lists items ("we need three things: first a, second b, and last
c"), break that list into bullets. Keep each item in the speaker's own words.
Do not turn ordinary prose into a list.

Do not add, remove or answer anything. Do not expand abbreviations. Do not add
commentary, greetings or explanations.

Reply with the tidied text and nothing else.`,
] as const;

/** The default that never existed, replaced on load wherever it is still set. */
export const RETIRED_OPENROUTER_MODELS = ["anthropic/claude-3.5-haiku"] as const;
