import { rootMeanSquare } from "./segmenter";

/**
 * The speech level the voice-processing unit used to deliver on this hardware.
 *
 * A raw built-in microphone measures about twenty-five times quieter (~0.0036
 * against ~0.088). Whisper and the segmenter both want the louder number; the
 * quieter one sits under the segmenter's mute floor and is dropped as silence.
 */
const TARGET_PEAK = 0.08;

/**
 * Enough to lift that measured raw peak to the target, and not so much that a
 * muted microphone's own noise becomes a phrase.
 */
const MAX_GAIN = 32;

/**
 * Raises a raw microphone to a usable level without the voice-processing unit.
 *
 * That unit is what made getUserMedia take about a second, and what made macOS
 * duck other apps. The gain here is the same work, done on the samples, so the
 * microphone can open as a plain input.
 *
 * A quiet laptop mic is lifted; an interface that is already loud is left
 * alone. The factor is held for the session so room and speech stay in
 * proportion — dropping it when speech arrived is what used to hide a 2.8×
 * raw ratio under the segmenter's floor.
 */
export class InputGain {
  private peak = 0;
  /** Zero until the first block, so a loud interface is not opened at 32×. */
  private applied = 0;

  apply(samples: Float32Array): Float32Array {
    const level = rootMeanSquare(samples);
    this.peak = Math.max(level, this.peak * 0.995);
    const desired = this.desiredFactor();
    // Hold the factor once chosen. Dropping it when speech arrives — louder
    // than the room that set it — was compressing the ratio the segmenter
    // needs. A source already at the target is the exception: it never
    // wanted lift.
    if (this.applied === 0 || desired > this.applied || this.peak >= TARGET_PEAK) {
      this.applied = desired;
    }
    if (this.applied <= 1.01) return samples;

    const boosted = new Float32Array(samples.length);
    for (let index = 0; index < samples.length; index += 1) {
      boosted[index] = Math.max(-1, Math.min(1, (samples[index] ?? 0) * this.applied));
    }
    return boosted;
  }

  /** The factor last applied, for the session log. Never attenuates. */
  factor(): number {
    return this.applied || this.desiredFactor();
  }

  private desiredFactor(): number {
    return Math.min(
      MAX_GAIN,
      Math.max(1, TARGET_PEAK / Math.max(this.peak, TARGET_PEAK / MAX_GAIN)),
    );
  }
}
