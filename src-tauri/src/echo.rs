//! Takes the far end back out of the microphone track.
//!
//! On speakers, the mic hears the meeting too: a delayed, roomy copy of
//! everything in `system.wav`. Summing the two for playback then plays every
//! remote word twice, a fraction of a second apart, which sounds like a big
//! empty room. This is an offline echo canceller over the finished tracks: a
//! short adaptive filter per frequency bin learns how the system track reaches
//! the mic (delay and room together), subtracts that estimate, and then turns
//! down whatever echo the filter could not model.
//!
//! Before that, the system track is lined up with where it lands in the mic.
//! The MacBook's own speakers are heard about 200 ms late, but a Bluetooth,
//! AirPlay or display speaker adds a lot more, and runs on its own clock, so
//! over an hour its delay drifts. The delay is found block by block through
//! the recording and followed, and the filter only has to model the room.

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

/// Rate the delay search runs at; speech correlates well enough below 4 kHz.
const SEARCH_RATE: f64 = 8_000.0;
/// Each delay estimate looks at this much audio, and estimates are this far
/// apart.
const BLOCK_SECONDS: f64 = 8.0;
const BLOCK_STEP_SECONDS: f64 = 4.0;
/// Longest delay looked for: AirPlay buffers about two seconds.
const MAX_DELAY_SECONDS: f64 = 2.5;
/// A block's peak must stand this far above the rest of the correlation, in
/// RMS, to count. Unrelated audio, as with headphones, peaks around 4 to 5.
const CLEAR: f32 = 8.0;
/// Below this RMS a block is taken as silent on that side.
const QUIET: f32 = 1e-3;
/// Samples of reference kept ahead of the found delay, so the direct path
/// sits inside the filter rather than at its very edge.
const LEAD: f64 = (2 * HOP) as f64;

/// The microphone with the reference's echo removed. Both are mono at
/// `rate`; the result is as long as `mic`.
pub fn cancel(mic: &[f32], reference: &[f32], rate: u32) -> Vec<f32> {
    if mic.len() < FRAME {
        return mic.to_vec();
    }
    let delays = delays(mic, reference, rate);
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

    let mut analyse = |sample: &dyn Fn(usize) -> f32, start: usize, spectrum: &mut [Complex32], time: &mut [f32]| {
        for (i, slot) in time.iter_mut().enumerate() {
            *slot = sample(start + i) * window[i];
        }
        forward.process_with_scratch(time, spectrum, &mut scratch).expect("forward fft");
    };

    for frame in 0..frames {
        let start = frame * HOP;
        head = (head + TAPS - 1) % TAPS;
        // No echo found leaves this at zero: the reference as recorded.
        let delay = (lag_at(&delays, start) - LEAD).max(0.0);
        analyse(
            &|t: usize| sample_at(reference, t as f64 - delay),
            start,
            &mut history[head * bins..(head + 1) * bins],
            &mut time,
        );
        analyse(&|t: usize| mic.get(t).copied().unwrap_or(0.0), start, &mut mic_spectrum, &mut time);

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

/// Where the reference turns up in the mic, as (sample, lag in samples)
/// points through the recording, from blocks where both sides have sound and
/// the match is clear. Empty when nothing matched, as with headphones.
fn delays(mic: &[f32], reference: &[f32], rate: u32) -> Vec<(usize, f64)> {
    let factor = ((rate as f64 / SEARCH_RATE).round() as usize).max(1);
    let search_rate = rate as f64 / factor as f64;
    let mic = decimate(mic, factor);
    let reference = decimate(reference, factor);
    let block = (BLOCK_SECONDS * search_rate) as usize;
    let step = (BLOCK_STEP_SECONDS * search_rate) as usize;
    let max_lag = (MAX_DELAY_SECONDS * search_rate) as usize;
    let size = (block + max_lag).next_power_of_two();

    let mut planner = RealFftPlanner::<f32>::new();
    let forward = planner.plan_fft_forward(size);
    let inverse = planner.plan_fft_inverse(size);
    let mut mic_time = forward.make_input_vec();
    let mut reference_time = forward.make_input_vec();
    let mut mic_spectrum = forward.make_output_vec();
    let mut reference_spectrum = forward.make_output_vec();
    let mut correlation = inverse.make_output_vec();

    let mut found: Vec<(usize, f64)> = Vec::new();
    let mut start = 0;
    while start + block <= mic.len() {
        let mic_block = &mic[start..start + block];
        // The reference from `max_lag` before the block to its end, so index
        // k of the correlation is a lag of `max_lag - k`.
        reference_time.fill(0.0);
        for (i, slot) in reference_time[..block + max_lag].iter_mut().enumerate() {
            *slot = (start + i)
                .checked_sub(max_lag)
                .and_then(|at| reference.get(at))
                .copied()
                .unwrap_or(0.0);
        }
        if rms(mic_block) < QUIET || rms(&reference_time[max_lag..max_lag + block]) < QUIET {
            start += step;
            continue;
        }
        mic_time.fill(0.0);
        mic_time[..block].copy_from_slice(mic_block);
        forward.process(&mut mic_time, &mut mic_spectrum).expect("forward fft");
        forward.process(&mut reference_time, &mut reference_spectrum).expect("forward fft");
        // Phase only (GCC-PHAT): a sharp peak whatever the speech's spectrum.
        for (m, r) in mic_spectrum.iter_mut().zip(&reference_spectrum) {
            let cross = m.conj() * r;
            let magnitude = cross.norm();
            *m = if magnitude > 1e-12 { cross / magnitude } else { Complex32::default() };
        }
        let last = mic_spectrum.len() - 1;
        mic_spectrum[0].im = 0.0;
        mic_spectrum[last].im = 0.0;
        inverse.process(&mut mic_spectrum, &mut correlation).expect("inverse fft");

        let valid = &correlation[..=max_lag];
        let (peak_at, peak) = valid
            .iter()
            .copied()
            .enumerate()
            .fold((0, f32::MIN), |best, (k, v)| if v > best.1 { (k, v) } else { best });
        if peak > CLEAR * rms(valid) {
            found.push(((start + block / 2) * factor, ((max_lag - peak_at) * factor) as f64));
        }
        start += step;
    }

    // A median of three drops the odd block that matched the wrong thing.
    let lags: Vec<f64> = found.iter().map(|point| point.1).collect();
    for (i, point) in found.iter_mut().enumerate() {
        let mut near = lags[i.saturating_sub(1)..(i + 2).min(lags.len())].to_vec();
        near.sort_by(|a, b| a.total_cmp(b));
        point.1 = near[near.len() / 2];
    }
    found
}

/// The lag at sample `t`, straight between the points either side of it and
/// held level beyond the first and last.
fn lag_at(points: &[(usize, f64)], t: usize) -> f64 {
    let next = points.partition_point(|point| point.0 <= t);
    match (next.checked_sub(1).map(|i| points[i]), points.get(next)) {
        (Some((t0, l0)), Some(&(t1, l1))) => l0 + (l1 - l0) * (t - t0) as f64 / (t1 - t0) as f64,
        (Some((_, lag)), None) | (None, Some(&(_, lag))) => lag,
        (None, None) => 0.0,
    }
}

/// `signal` at a fractional position, zero outside it.
fn sample_at(signal: &[f32], position: f64) -> f32 {
    if position < 0.0 {
        return 0.0;
    }
    let index = position as usize;
    let fraction = (position - index as f64) as f32;
    let a = signal.get(index).copied().unwrap_or(0.0);
    let b = signal.get(index + 1).copied().unwrap_or(0.0);
    a + (b - a) * fraction
}

/// Every `factor` samples averaged into one: a rough low-pass, enough for
/// finding a delay.
fn decimate(signal: &[f32], factor: usize) -> Vec<f32> {
    if factor == 1 {
        return signal.to_vec();
    }
    signal
        .chunks(factor)
        .map(|chunk| chunk.iter().sum::<f32>() / chunk.len() as f32)
        .collect()
}

fn rms(x: &[f32]) -> f32 {
    if x.is_empty() {
        return 0.0;
    }
    (x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32).sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A noise-like far end, deterministic so the test is too.
    fn far_end(len: usize) -> Vec<f32> {
        noise(len, 0x1234_5678)
    }

    fn noise(len: usize, seed: u32) -> Vec<f32> {
        let mut state = seed;
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
        let cleaned = cancel(&mic, &system, rate as u32);
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
        let cleaned = cancel(&voice, &silence, rate as u32);
        let middle = rate / 2..rate * 3 / 2;
        let ratio = rms(&cleaned[middle.clone()]) / rms(&voice[middle]);
        assert!((ratio - 1.0).abs() < 0.02, "{ratio}");
    }

    /// The far end heard through a room: `delay(i)` samples late, fractional,
    /// plus two reflections.
    fn through_speaker(system: &[f32], delay: impl Fn(usize) -> f64) -> Vec<f32> {
        (0..system.len())
            .map(|i| {
                let at = i as f64 - delay(i);
                0.4 * sample_at(system, at) + 0.15 * sample_at(system, at - 900.0) + 0.05 * sample_at(system, at - 2_400.0)
            })
            .collect()
    }

    #[test]
    fn a_bluetooth_speakers_long_delay_is_found_and_removed() {
        let rate = 48_000;
        let system = far_end(rate * 20);
        // 200 ms of Mac and 600 ms of Bluetooth: beyond the filter alone.
        let mic = through_speaker(&system, |_| 38_400.0);
        let found = delays(&mic, &system, rate as u32);
        assert!(!found.is_empty());
        for (_, lag) in &found {
            assert!((lag - 38_400.0).abs() <= 12.0, "{lag}");
        }
        let cleaned = cancel(&mic, &system, rate as u32);
        let tail = rate * 12..;
        assert!(
            rms(&cleaned[tail.clone()]) < rms(&mic[tail.clone()]) * 0.1,
            "{} vs {}",
            rms(&cleaned[tail.clone()]),
            rms(&mic[tail])
        );
    }

    #[test]
    fn a_speaker_on_its_own_clock_is_followed_as_it_drifts() {
        let rate = 48_000;
        let system = far_end(rate * 40);
        // 900 ms growing by 0.05%: 20 ms over the recording, faster than a
        // real clock, so the test is short.
        let mic = through_speaker(&system, |i| 43_200.0 + i as f64 * 0.0005);
        let cleaned = cancel(&mic, &system, rate as u32);
        let tail = rate * 20..;
        assert!(
            rms(&cleaned[tail.clone()]) < rms(&mic[tail.clone()]) * 0.15,
            "{} vs {}",
            rms(&cleaned[tail.clone()]),
            rms(&mic[tail])
        );
    }

    #[test]
    fn unrelated_audio_finds_no_delay() {
        let rate = 48_000;
        let system = far_end(rate * 20);
        let voice = noise(rate * 20, 0x9e37_79b9);
        assert!(delays(&voice, &system, rate as u32).is_empty());
    }
}
