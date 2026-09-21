/**
 * The speech models a first run may be started on, ordered fastest first.
 *
 * The catalogue is a table to read down: sixteen entries, four numbers each,
 * two of them engines a fresh install cannot run without a terminal. That is
 * the right shape for someone comparing models and the wrong one for someone
 * who has owned the app for nine seconds -- so the wizard asks the only
 * question they can actually answer, "faster or more accurate?", and this is
 * what the answers mean.
 *
 * Every rung is whisper.cpp, because whisper.cpp is linked into the app and so
 * is the only engine whose weights the app can fetch by itself. Parakeet and
 * Qwen are better on paper and both need Python first; offering them here
 * would be offering a first dictation that fails.
 *
 * The quantized build wins every rung it appears on. `ggml-small-q5_1` scores
 * the same 3.43 WER as `ggml-small` on half the resident memory, so the
 * unquantized ones are not choices, they are the same choice at twice the
 * cost. Tiny is left out for the opposite reason: at 7.54 WER a first
 * dictation comes back wrong, and nobody who has just installed a dictation
 * app knows to blame the model.
 *
 * `model-ladder.test.ts` checks this against the catalogue, which holds the
 * error rates and the memory these descriptions are claims about.
 */
import type { ModelFit } from "./contracts";
import { getSpeechModel, type SpeechModelId } from "./models";

export interface LadderRung {
  id: SpeechModelId;
  /** The position's name, printed under the slider as it moves. */
  name: string;
  /** What is being traded away, in the terms the slider is asking about. */
  trade: string;
}

export const MODEL_LADDER: readonly LadderRung[] = [
  {
    id: "whisper-cpp-base",
    name: "Fastest",
    trade: "Back almost before you let go. Trips on names and technical words.",
  },
  {
    id: "whisper-cpp-small-q5",
    name: "Fast",
    trade: "Quick, and right about most ordinary sentences.",
  },
  {
    id: "whisper-cpp-medium-q5",
    name: "Balanced",
    trade: "A short pause after you let go, and noticeably fewer corrections.",
  },
  {
    id: "whisper-cpp-large-v3-turbo-q5",
    name: "Accurate",
    trade: "Near the best transcription there is, at a fraction of its cost.",
  },
  {
    id: "whisper-cpp-large-v3-q5",
    name: "Most accurate",
    trade: "The last fraction of a percent, for twice the wait and the disk.",
  },
];

/**
 * Where the slider starts, and what the escape hatch under it picks.
 *
 * Large v3 Turbo is the rung where the curve flattens: it is within 0.09 WER
 * of the most accurate model on the list for a third less memory and half the
 * wait. Anyone who does not want to think about this should land here, which
 * is why it is both the slider's resting position and what the "use the
 * default" button chooses.
 */
export const DEFAULT_LADDER_INDEX = 3;

export const DEFAULT_LADDER_MODEL_ID: SpeechModelId =
  MODEL_LADDER[DEFAULT_LADDER_INDEX]!.id;

/**
 * The rung at a position, clamped to the ends of the ladder.
 *
 * `NaN` is checked for rather than left to `Math.max`, which propagates it:
 * the clamp would return `NaN`, the index would miss, and a function typed as
 * returning a rung would hand back `undefined` for the caller to dereference.
 */
export function ladderRung(index: number): LadderRung {
  if (!Number.isFinite(index)) return MODEL_LADDER[0]!;
  const clamped = Math.min(MODEL_LADDER.length - 1, Math.max(0, Math.round(index)));
  return MODEL_LADDER[clamped]!;
}

/** Which rung a model sits on, or `null` for one the ladder does not offer. */
export function ladderIndexOf(id: SpeechModelId): number | null {
  const index = MODEL_LADDER.findIndex((rung) => rung.id === id);
  return index === -1 ? null : index;
}

export interface LadderChoice {
  id: SpeechModelId;
  label: string;
  /** Where the choice actually landed, which is the slider's position unless
      the Mac could not hold what was asked for. */
  index: number;
  /** The rung that was asked for, when it is not the one being offered. */
  askedFor: LadderRung | null;
}

/**
 * The best model this Mac can hold at or below the requested position.
 *
 * "Best" is the highest rung the slider was moved to, and then only as high as
 * the machine goes: a model reported `too-large` will load, swap, and make
 * dictation slower than the rung below it -- which is the opposite of what
 * someone asking for accuracy wants, and they would have no way to know.
 * Stepping down is said out loud rather than done quietly, because otherwise
 * the slider would visibly disagree with the model name beside it.
 *
 * `fits` answers for one model id. It returns `null` for a model whose fit
 * could not be read, and an unread fit is not a refusal: nothing is claimed,
 * so nothing is stepped down.
 */
export function chooseModel(
  index: number,
  fits: (id: SpeechModelId) => ModelFit | null,
): LadderChoice {
  const asked = ladderRung(index);
  const askedIndex = MODEL_LADDER.indexOf(asked);

  for (let at = askedIndex; at >= 0; at -= 1) {
    const rung = MODEL_LADDER[at]!;
    if (fits(rung.id) === "too-large") continue;
    return {
      id: rung.id,
      label: getSpeechModel(rung.id).label,
      index: at,
      askedFor: at === askedIndex ? null : asked,
    };
  }

  // Every rung is too large for this Mac, which takes 2 GB of memory and an
  // Apple Silicon requirement to reach. The lightest is still the best answer.
  const lightest = MODEL_LADDER[0]!;
  return {
    id: lightest.id,
    label: getSpeechModel(lightest.id).label,
    index: 0,
    askedFor: askedIndex === 0 ? null : asked,
  };
}
