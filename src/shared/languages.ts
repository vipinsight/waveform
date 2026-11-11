/**
 * The language a phrase is dictated in.
 *
 * Every engine here can detect the language itself, and every engine here does
 * it badly on a single dictated phrase: detection runs on the first seconds of
 * audio, and a short, noisy clip is routinely read as a neighbouring language,
 * which then produces a confidently wrong transcript. Naming the language
 * removes that failure mode and the work that goes with it.
 *
 * Codes are ISO 639-1, which is what all three engines take. Hinglish, Hindi
 * and English mixed and typed in Roman script, has no code of its own: the
 * engines are told English and primed with Roman-script Hinglish, and what
 * still comes back in Devanagari is romanised (src-tauri/src/hinglish.rs).
 */
export const SPEECH_LANGUAGES = [
  { code: "", label: "Detect automatically" },
  { code: "en", label: "English" },
  { code: "hi", label: "Hindi" },
  { code: "hinglish", label: "Hinglish (Hindi + English)" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "it", label: "Italian" },
  { code: "pt", label: "Portuguese" },
  { code: "nl", label: "Dutch" },
  { code: "ru", label: "Russian" },
  { code: "ar", label: "Arabic" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "zh", label: "Chinese" },
] as const;

export type SpeechLanguageCode = (typeof SPEECH_LANGUAGES)[number]["code"];

/** English, not detection: a wrong language is worse than a fixed one. */
export const DEFAULT_SPEECH_LANGUAGE: SpeechLanguageCode = "en";

export function isSpeechLanguage(value: unknown): value is SpeechLanguageCode {
  return SPEECH_LANGUAGES.some(({ code }) => code === value);
}

/**
 * Whether a speech engine can hear `code` at all. Parakeet's 25 languages are
 * all European, so for Hindi and Hinglish it can only guess at English words.
 */
export function engineHearsLanguage(engine: string, code: string): boolean {
  return !(engine === "nemo" && (code === "hi" || code === "hinglish"));
}

export function speechLanguageLabel(code: string): string {
  return SPEECH_LANGUAGES.find((language) => language.code === code)?.label ?? code;
}
