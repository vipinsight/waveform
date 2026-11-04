/**
 * How long the speech in a phrase WAV lasts, in milliseconds: first voiced
 * frame to last, so the pre-roll ahead of a phrase and the pause the
 * segmenter waited out after it do not count. Pauses between words stay in,
 * because they are part of how fast someone talks.
 *
 * Voiced is relative to the phrase's own loudest frame, since clips are
 * normalised before they get here and an absolute level would mean nothing.
 * Expects the mono PCM16 files `encodeMonoPcm16Wav` writes.
 */

const WAV_HEADER_BYTES = 44;
const FRAME_MS = 20;
/** A frame within 20dB of the loudest one is speech; quieter is the room. */
const VOICED_SHARE = 0.1;

export function speechSpanMs(wav: Uint8Array): number {
  if (wav.length <= WAV_HEADER_BYTES) return 0;
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const sampleRate = view.getUint32(24, true);
  if (sampleRate === 0) return 0;
  const samples = Math.floor((wav.length - WAV_HEADER_BYTES) / 2);
  const frame = Math.max(1, Math.round((sampleRate * FRAME_MS) / 1000));

  const levels: number[] = [];
  for (let start = 0; start < samples; start += frame) {
    const end = Math.min(samples, start + frame);
    let sum = 0;
    for (let index = start; index < end; index += 1) {
      const sample = view.getInt16(WAV_HEADER_BYTES + index * 2, true) / 0x8000;
      sum += sample * sample;
    }
    levels.push(Math.sqrt(sum / (end - start)));
  }

  const peak = Math.max(0, ...levels);
  if (peak === 0) return 0;
  const threshold = peak * VOICED_SHARE;
  const first = levels.findIndex((level) => level >= threshold);
  let last = levels.length - 1;
  while (last > first && (levels[last] ?? 0) < threshold) last -= 1;
  const spanSamples = Math.min(samples, (last + 1) * frame) - first * frame;
  return Math.round((spanSamples / sampleRate) * 1000);
}
