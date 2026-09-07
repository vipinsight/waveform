export interface SegmenterOptions {
  sampleRate: number;
  silenceThreshold?: number;
  trailingSilenceMs?: number;
  minimumSpeechMs?: number;
  /** Floor applied when the user ends the session, rather than at a pause. */
  flushMinimumSpeechMs?: number;
  preRollMs?: number;
  maximumSegmentMs?: number;
}

export class SpeechSegmenter {
  private readonly silenceThreshold: number;
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
    // Tuned against a noise-suppressed stream. It is a fixed floor rather than
    // a measured one, so it is only correct while capture.ts asks for
    // noiseSuppression -- the two settings are one decision, not two.
    this.silenceThreshold = options.silenceThreshold ?? 0.014;
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
    this.preRollSamples = millisecondsToSamples(options.preRollMs ?? 220, options.sampleRate);
    this.maximumSegmentSamples = millisecondsToSamples(
      options.maximumSegmentMs ?? 15_000,
      options.sampleRate,
    );
  }

  push(input: Float32Array): Float32Array | null {
    const chunk = new Float32Array(input);
    const isSpeech = rootMeanSquare(chunk) >= this.silenceThreshold;

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

