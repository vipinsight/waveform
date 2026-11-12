//! Takes the far end back out of the microphone track.
//!
//! On speakers, the mic hears the meeting too: a delayed, roomy copy of
//! everything in `system.wav`. Summing the two for playback then plays every
//! remote word twice, a fraction of a second apart, which sounds like a big
//! empty room. This is an offline echo canceller over the finished tracks: a
//! short adaptive filter per frequency bin learns how the system track reaches
//! the mic (delay and room together), subtracts that estimate, and then turns
//! down whatever echo the filter could not model.

use realfft::num_complex::Complex32;
use realfft::RealFftPlanner;

const FRAME: usize = 1024;
const HOP: usize = FRAME / 2;
/// How far back the filter looks, in hops: 40 × 512 samples is about 430 ms
/// at 48 kHz, enough for the output buffer, the speaker, the room, and the
/// input buffer together.
const TAPS: usize = 40;
const STEP: f32 = 0.5;
/// Least gain the suppressor applies to a bin, so speech under the echo is
/// thinned rather than gated into silence.
const FLOOR: f32 = 0.05;
/// How much more than its estimate the echo is assumed to be when deciding
/// how far to turn a bin down; the filter undershoots more often than not.
const OVERESTIMATE: f32 = 2.0;

/// The microphone with the reference's echo removed. Both are mono at the
/// same rate; the result is as long as `mic`.
pub fn cancel(mic: &[f32], reference: &[f32]) -> Vec<f32> {
    if mic.len() < FRAME {
        return mic.to_vec();
    }
    let mut planner = RealFftPlanner::<f32>::new();
    let forward = planner.plan_fft_forward(FRAME);
    let inverse = planner.plan_fft_inverse(FRAME);
    let bins = FRAME / 2 + 1;
    // A periodic Hann window's square root, for analysis and synthesis
    // alike: the two multiply back to Hann, which sums to one at half overlap.
    let window: Vec<f32> = (0..FRAME)
        .map(|i| (0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / FRAME as f32).cos()).sqrt())
        .collect();

    let frames = (mic.len() - FRAME) / HOP + 1;
    let mut weights = vec![Complex32::default(); TAPS * bins];
    // The last TAPS reference spectra, newest at `head`.
    let mut history = vec![Complex32::default(); TAPS * bins];
    let mut head = 0;
    let mut power = vec![0f32; bins];
    let mut out = vec![0f32; mic.len()];

    let mut time = vec![0f32; FRAME];
    let mut mic_spectrum = vec![Complex32::default(); bins];
    let mut estimate = vec![Complex32::default(); bins];
    let mut scratch = forward.make_scratch_vec();

    let mut analyse = |signal: &[f32], start: usize, spectrum: &mut [Complex32], time: &mut [f32]| {
        for (i, sample) in time.iter_mut().enumerate() {
            *sample = signal.get(start + i).copied().unwrap_or(0.0) * window[i];
        }
        forward.process_with_scratch(time, spectrum, &mut scratch).expect("forward fft");
    };

    for frame in 0..frames {
        let start = frame * HOP;
        head = (head + TAPS - 1) % TAPS;
        analyse(reference, start, &mut history[head * bins..(head + 1) * bins], &mut time);
        analyse(mic, start, &mut mic_spectrum, &mut time);

        for bin in 0..bins {
            let mut y = Complex32::default();
            let mut energy = 0.0;
            for tap in 0..TAPS {
                let x = history[((head + tap) % TAPS) * bins + bin];
                y += weights[tap * bins + bin] * x;
                energy += x.norm_sqr();
            }
            let error = mic_spectrum[bin] - y;
            // Normalised by the reference energy, held up so a sudden quiet
            // after loud speech does not blow the step size up.
            power[bin] = (power[bin] * 0.99).max(energy);
            let step = STEP / (power[bin] + 1e-3);
            for tap in 0..TAPS {
                let x = history[((head + tap) % TAPS) * bins + bin];
                weights[tap * bins + bin] += x.conj() * error * step;
            }
            let residual = error.norm_sqr();
            let gain = (1.0 - OVERESTIMATE * y.norm_sqr() / (residual + 1e-10)).clamp(FLOOR, 1.0);
            estimate[bin] = error * gain;
        }

        // A real signal's spectrum has no imaginary part at DC or Nyquist.
        estimate[0].im = 0.0;
        estimate[bins - 1].im = 0.0;
        inverse.process(&mut estimate, &mut time).expect("inverse fft");
        for (i, sample) in time.iter().enumerate() {
            if let Some(slot) = out.get_mut(start + i) {
                *slot += sample * window[i] / FRAME as f32;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rms(x: &[f32]) -> f32 {
        (x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32).sqrt()
    }

    /// A noise-like far end, deterministic so the test is too.
    fn far_end(len: usize) -> Vec<f32> {
        let mut state = 0x1234_5678u32;
        (0..len)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                (state as f32 / u32::MAX as f32 - 0.5) * 0.4
            })
            .collect()
    }

    #[test]
    fn a_delayed_copy_of_the_far_end_is_removed() {
        let rate = 48_000;
        let system = far_end(rate * 6);
        // The speaker, 200 ms and two reflections later, quieter.
        let mut mic = vec![0f32; system.len()];
        for (i, slot) in mic.iter_mut().enumerate() {
            for (delay, gain) in [(9_600, 0.4), (10_500, 0.15), (12_000, 0.05)] {
                if i >= delay {
                    *slot += system[i - delay] * gain;
                }
            }
        }
        let cleaned = cancel(&mic, &system);
        assert_eq!(cleaned.len(), mic.len());
        // Judged once the filter has had a couple of seconds to learn.
        let tail = rate * 3..;
        assert!(
            rms(&cleaned[tail.clone()]) < rms(&mic[tail.clone()]) * 0.1,
            "{} vs {}",
            rms(&cleaned[tail.clone()]),
            rms(&mic[tail])
        );
    }

    #[test]
    fn the_near_end_survives_when_the_far_end_is_silent() {
        let rate = 48_000;
        let voice: Vec<f32> = (0..rate * 2)
            .map(|i| (i as f32 * 220.0 * std::f32::consts::TAU / rate as f32).sin() * 0.3)
            .collect();
        let silence = vec![0f32; voice.len()];
        let cleaned = cancel(&voice, &silence);
        let middle = rate / 2..rate * 3 / 2;
        let ratio = rms(&cleaned[middle.clone()]) / rms(&voice[middle]);
        assert!((ratio - 1.0).abs() < 0.02, "{ratio}");
    }
}
