/**
 * A coarse spectrum from a time-domain block, for the HUD meter.
 *
 * Native capture has no AnalyserNode — that node lives on an AudioContext,
 * and an AudioContext attaches to the speakers. This is the same picture
 * without touching the output device.
 */
export function spectrumFromBlock(samples: Float32Array, bins = 128): Uint8Array<ArrayBuffer> {
  const spectrum = new Uint8Array(bins);
  if (samples.length === 0) return spectrum;

  const window = Math.min(samples.length, 256);
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
