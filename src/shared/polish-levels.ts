/**
 * How much the model may change a dictation before it is inserted.
 *
 * Off, or Active (stored as `light`, the name it had when there were three).
 * A Medium level that also cut and rephrased was dropped: two choices are one
 * decision, three were a comparison nobody wanted to make on every install.
 * A saved `medium` reads as `light`.
 *
 * The level chooses the instruction the dictation path runs, which lives in
 * prompts.ts beside the one the polish shortcut uses. `none` runs no model at
 * all: the transcript is inserted as the speech engine returned it.
 */
export const POLISH_LEVELS = ["none", "light"] as const;

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
