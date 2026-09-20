/**
 * How much the model may change a dictation before it is inserted.
 *
 * Three settings rather than a switch, because "tidy this" is not one thing.
 * Removing "um" and closing a sentence is a different act from cutting the
 * sentence in half, and someone dictating a commit message wants one while
 * someone dictating a message to a friend wants the other. A single on/off
 * made that choice for them.
 *
 * The level chooses the instruction the dictation path runs, which lives in
 * prompts.ts beside the one the polish shortcut uses. `none` runs no model at
 * all: the transcript is inserted as the speech engine returned it.
 */
export const POLISH_LEVELS = ["none", "light", "medium"] as const;

export type PolishLevel = (typeof POLISH_LEVELS)[number];

/**
 * Off, because this is the one setting that changes the words a person is
 * about to paste into their own document. Waveform does not start doing that
 * without being asked, and the hosted engine cannot do it at all until a key
 * has been added.
 */
export const DEFAULT_POLISH_LEVEL: PolishLevel = "none";

export function isPolishLevel(value: unknown): value is PolishLevel {
  return POLISH_LEVELS.includes(value as never);
}
