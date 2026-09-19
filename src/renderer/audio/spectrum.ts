/**
 * A coarse spectrum from a time-domain block, for the HUD meter.
 *
 * Native capture has no AnalyserNode — that node lives on an AudioContext,
 * and an AudioContext attaches to the speakers. This is the same picture
 * without touching the output device.
 */

/** Samples the DFT looks at. Matches a native capture block's tail. */
export const SPECTRUM_WINDOW = 256;

/**
 * Speech lives well below Nyquist at 48 kHz. Mapping bars across the whole
 * DFT (or even the lower 40%) puts the voice in the first band and leaves
 * the outer bars sitting still.
 */
const SPEECH_LOW_HZ = 120;
const SPEECH_HIGH_HZ = 3_800;

export function spectrumFromBlock(samples: Float32Array, bins = 128): Uint8Array<ArrayBuffer> {
  const spectrum = new Uint8Array(bins);
  if (samples.length === 0) return spectrum;

  const window = Math.min(samples.length, SPECTRUM_WINDOW);
  const start = samples.length - window;
  for (let bin = 1; bin < bins; bin += 1) {
    let real = 0;
    let imag = 0;
    for (let index = 0; index < window; index += 1) {
      const angle = (2 * Math.PI * bin * index) / window;
      const sample = samples[start + index] ?? 0;
      real += sample * Math.cos(angle);
      imag -= sample * Math.sin(angle);
    }
    const magnitude = Math.hypot(real, imag) / window;
    spectrum[bin] = Math.min(255, Math.round(magnitude * 8_000));
  }
  return spectrum;
}

/**
 * Peak magnitude in each speech band, lowest frequency first.
 *
 * The HUD mirrors this around the centre: index 0 is the two middle bars,
 * the last index is the outsides. Bands are log-spaced across the voice
 * range for this sample rate, so a spoken phrase has energy in every one
 * rather than only in the lowest.
 */
export function speechBands(
  spectrum: Uint8Array,
  bandCount: number,
  sampleRate: number,
  window = SPECTRUM_WINDOW,
): number[] {
  const bands = new Array<number>(bandCount).fill(0);
  if (spectrum.length === 0 || bandCount <= 0 || sampleRate <= 0 || window <= 0) {
    return bands;
  }

  const hzPerBin = sampleRate / window;
  const highHz = Math.min(SPEECH_HIGH_HZ, sampleRate / 2 - hzPerBin);
  if (highHz <= SPEECH_LOW_HZ) return bands;

  const ratio = highHz / SPEECH_LOW_HZ;
  let cursor = 1;
  for (let index = 0; index < bandCount; index += 1) {
    const toHz = SPEECH_LOW_HZ * ratio ** ((index + 1) / bandCount);
    const to = Math.max(cursor + 1, Math.min(spectrum.length, Math.ceil(toHz / hzPerBin)));
    let peak = 0;
    for (let bin = cursor; bin < to; bin += 1) peak = Math.max(peak, spectrum[bin] ?? 0);
    bands[index] = peak;
    cursor = to;
  }
  return bands;
}
