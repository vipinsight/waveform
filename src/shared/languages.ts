/**
 * The language a phrase is dictated in.
 *
 * Every engine here can detect the language itself, and every engine here does
 * it badly on a single dictated phrase: detection runs on the first seconds of
 * audio, and a short, noisy clip is routinely read as a neighbouring language,
 * which then produces a confidently wrong transcript. Naming the language
 * removes that failure mode and the work that goes with it.
 *
 * Codes are ISO 639-1, which is what all three engines take.
 */
export const SPEECH_LANGUAGES = [
  { code: "", label: "Detect automatically" },
  { code: "en", label: "English" },
  { code: "hi", label: "Hindi" },
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

export function speechLanguageLabel(code: string): string {
  return SPEECH_LANGUAGES.find((language) => language.code === code)?.label ?? code;
}
