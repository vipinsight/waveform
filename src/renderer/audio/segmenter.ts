export interface SegmenterOptions {
  sampleRate: number;
  silenceThreshold?: number;
  trailingSilenceMs?: number;
  minimumSpeechMs?: number;
  /** Floor applied when the user ends the session, rather than at a pause. */
  flushMinimumSpeechMs?: number;
  preRollMs?: number;
  /** Room measured before speech detection starts. Zero disables it. */
  calibrationMs?: number;
  maximumSegmentMs?: number;
}

/**
 * Nothing quieter than this is speech, however quiet the room is.
 *
 * Without it, a silent input measures a floor of nearly zero and then treats
 * its own noise as speech, which is how a muted microphone produces phrases.
 */
const MINIMUM_THRESHOLD = 0.004;

/**
 * How far above the room a block has to sit to count as speech.
 *
 * 2.5 is about 8dB. Three (10dB) was what the voice-processing unit
 * delivered; a raw built-in microphone was measured at 2.8×, so three
 * dropped every phrase. Lower than this and a fan crosses it.
 */
const FLOOR_MARGIN = 2.5;

/**
 * How long the room is listened to before anything counts as speech.
 *
 * Without it the floor cannot be learned in a noisy room: the first blocks
 * already sit above the starting threshold, so they read as speech and the
 * floor never rises. These blocks are not discarded -- they go to the pre-roll,
 * which is why it is longer than this.
 */
const CALIBRATION_MS = 250;

export class SpeechSegmenter {
  /** Set only when a fixed threshold was asked for. See `threshold`. */
  private readonly silenceThreshold: number | null;
  /** The room, as measured between phrases. */
  private floor = 0;
  /** Samples of room still owed before speech detection starts. */
  private calibrating: number;
  private readonly trailingSilenceSamples: number;
  private readonly minimumSpeechSamples: number;
  private readonly flushMinimumSpeechSamples: number;
  private readonly preRollSamples: number;
  private readonly maximumSegmentSamples: number;
  private preRoll: Float32Array[] = [];
  private preRollLength = 0;
  private segment: Float32Array[] = [];
  private segmentLength = 0;
  private speechSamples = 0;
  private silenceSamples = 0;
  private speaking = false;

  constructor(options: SegmenterOptions) {
    // Measured rather than fixed, unless a caller insists. A fixed threshold
    // is only right for the stream it was tuned against: 0.014 was correct
    // for a noise-suppressed microphone and wrong for a raw one, which tied
    // the segmenter to a getUserMedia flag two files away.
    this.silenceThreshold = options.silenceThreshold ?? null;
    this.trailingSilenceSamples = millisecondsToSamples(
      options.trailingSilenceMs ?? 650,
      options.sampleRate,
    );
    // Speech is not continuous: gaps between words and unvoiced consonants
    // fall below the threshold, so a two-word phrase registers far less than
    // its wall-clock duration. A high floor here silently drops short
    // utterances entirely.
    this.minimumSpeechSamples = millisecondsToSamples(
      options.minimumSpeechMs ?? 120,
      options.sampleRate,
    );
    // Releasing the key says "I have finished", so the only thing worth
    // rejecting at that point is a stray click or an empty room.
    this.flushMinimumSpeechSamples = millisecondsToSamples(
      options.flushMinimumSpeechMs ?? 60,
      options.sampleRate,
    );
    // Longer than the calibration window on purpose: those samples are room
    // noise as far as detection goes, but they are also the run-up to a phrase
    // that started immediately, and dropping them clips the first word.
    this.preRollSamples = millisecondsToSamples(options.preRollMs ?? 320, options.sampleRate);
    this.calibrating = millisecondsToSamples(
      options.calibrationMs ?? CALIBRATION_MS,
      options.sampleRate,
    );
    this.maximumSegmentSamples = millisecondsToSamples(
      options.maximumSegmentMs ?? 15_000,
      options.sampleRate,
    );
  }

  /**
   * What a block has to reach to count as speech.
   *
   * Follows the room, so the same code works on a suppressed stream, a raw
   * one, a quiet study and a cafe.
   */
  threshold(): number {
    if (this.silenceThreshold !== null) return this.silenceThreshold;
    return Math.max(MINIMUM_THRESHOLD, this.floor * FLOOR_MARGIN);
  }

  push(input: Float32Array): Float32Array | null {
    const chunk = new Float32Array(input);
    const level = rootMeanSquare(chunk);

    if (this.calibrating > 0) {
      this.calibrating -= chunk.length;
      this.learnFloor(level, 0.3);
      this.addPreRoll(chunk);
      return null;
    }

    const isSpeech = level >= this.threshold();

    // Only silence teaches the floor, and only between phrases: folding speech
    // into it would raise the bar until the speaker fell under it.
    if (!isSpeech && !this.speaking) this.learnFloor(level, 0.1);

    if (!this.speaking) {
      if (!isSpeech) {
        this.addPreRoll(chunk);
        return null;
      }

      this.speaking = true;
      this.segment = [...this.preRoll, chunk];
      this.segmentLength = this.preRollLength + chunk.length;
      this.preRoll = [];
      this.preRollLength = 0;
    } else {
      this.segment.push(chunk);
      this.segmentLength += chunk.length;
    }

    if (isSpeech) {
      this.speechSamples += chunk.length;
      this.silenceSamples = 0;
    } else {
      this.silenceSamples += chunk.length;
    }

    if (
      this.silenceSamples >= this.trailingSilenceSamples ||
      this.segmentLength >= this.maximumSegmentSamples
    ) {
      return this.finishSegment();
    }

    return null;
  }

  /** Ends the session and returns whatever was captured. */
  flush(): Float32Array | null {
    return this.finishSegment(this.flushMinimumSpeechSamples);
  }

  /** The first measurement is taken whole, so nothing is judged against zero. */
  private learnFloor(level: number, weight: number): void {
    this.floor = this.floor === 0 ? level : this.floor * (1 - weight) + level * weight;
  }

  private addPreRoll(chunk: Float32Array): void {
    this.preRoll.push(chunk);
    this.preRollLength += chunk.length;

    while (this.preRollLength > this.preRollSamples && this.preRoll.length > 1) {
      const removed = this.preRoll.shift();
      if (removed) this.preRollLength -= removed.length;
    }
  }

  private finishSegment(minimumSpeechSamples = this.minimumSpeechSamples): Float32Array | null {
    const valid = this.speaking && this.speechSamples >= minimumSpeechSamples;
    const result = valid ? concatenate(this.segment, this.segmentLength) : null;

    this.segment = [];
    this.segmentLength = 0;
    this.speechSamples = 0;
    this.silenceSamples = 0;
    this.speaking = false;
    this.preRoll = [];
    this.preRollLength = 0;

    return result;
  }
}

export function rootMeanSquare(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

function millisecondsToSamples(milliseconds: number, sampleRate: number): number {
  return Math.round((milliseconds / 1000) * sampleRate);
}

function concatenate(chunks: Float32Array[], length: number): Float32Array {
  const result = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

