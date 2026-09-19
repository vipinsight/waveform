//! Whisper through whisper.cpp, in this process.
//!
//! The Python engines each carry a virtual environment of about two and a half
//! gigabytes, reload their weights every time the worker restarts, and fall
//! back to the CPU whenever Metal is missing an operation. whisper.cpp is the
//! same model without any of that: it links into the app, keeps its weights in
//! memory, and runs its own Metal kernels.
//!
//! Weights are GGML `.bin` files, not the `.pt` files the Python package uses,
//! and neither can stand in for the other. Every Whisper entry in the
//! catalogue is one of these files: the size and quantization a user picks is
//! nothing more than which name is handed to `load`.

use std::path::PathBuf;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

/// What whisper.cpp wants, and the only rate it is trained on.
const WHISPER_RATE: u32 = 16_000;

/// Where the GGML weights live, whether the app fetched them or the script did.
pub fn weights_dir() -> Option<PathBuf> {
    crate::paths::whisper_dir()
}

pub fn weights_path(file: &str) -> Option<PathBuf> {
    crate::paths::whisper_file(file)
}

/// Loads a model. Blocking and slow enough to belong on a worker thread.
pub fn load(file: &str) -> Result<WhisperContext, String> {
    let path = weights_path(file).ok_or("Could not work out where Whisper's weights live.")?;
    if !path.is_file() {
        return Err(format!(
            "{} is missing. Download it from the Models section, then try again.",
            path.display()
        ));
    }
    WhisperContext::new_with_params(&path, WhisperContextParameters::default())
        .map_err(|error| format!("Could not load {file}: {error}"))
}

/// Transcribes one phrase. Blocking, for the same reason as `load`.
///
/// `language` is an ISO 639-1 code; empty asks whisper.cpp to detect one,
/// which it does from the opening seconds alone and therefore unreliably.
pub fn transcribe(
    context: &WhisperContext,
    audio: &[f32],
    language: &str,
) -> Result<String, String> {
    let mut state = context
        .create_state()
        .map_err(|error| format!("Could not start Whisper: {error}"))?;

    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(if language.is_empty() {
        None
    } else {
        Some(language)
    });
    params.set_translate(false);
    // Nothing reads whisper.cpp's stdout, and its progress lines would only
    // interleave with the app's own logging.
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    // One less than the cores available: the audio thread and the interface
    // still need one while a phrase is being transcribed.
    params.set_n_threads(worker_threads());

    state
        .full(params, audio)
        .map_err(|error| format!("Transcription failed: {error}"))?;

    let mut text = String::new();
    for segment in state.as_iter() {
        if let Ok(piece) = segment.to_str_lossy() {
            if is_speech(&piece) {
                text.push_str(&piece);
            }
        }
    }
    Ok(text.trim().to_string())
}

/// Whether a segment is words, rather than whisper.cpp describing the audio.
///
/// Silence comes back as the literal text `[BLANK_AUDIO]`, and non-speech as
/// `[MUSIC]`, `(buzzer)` and others -- ordinary output, not special tokens, so
/// `set_print_special(false)` does not touch them. Inserting them is worse than
/// inserting nothing: dictating into a pause typed `[BLANK_AUDIO]` into
/// whatever the cursor was in.
///
/// The rule is the shape rather than a list of the markers, because the list is
/// whisper's to change. A segment entirely inside brackets is a description of
/// the audio; speech that happens to contain brackets does not begin and end
/// with them.
fn is_speech(piece: &str) -> bool {
    let trimmed = piece.trim();
    if trimmed.is_empty() {
        return false;
    }
    let bracketed = |open: char, close: char| trimmed.starts_with(open) && trimmed.ends_with(close);
    !(bracketed('[', ']') || bracketed('(', ')') || bracketed('*', '*'))
}

fn worker_threads() -> i32 {
    let cores = std::thread::available_parallelism()
        .map(|value| value.get())
        .unwrap_or(4);
    cores.saturating_sub(1).max(1) as i32
}

/// Turns a WAV into what whisper.cpp takes: mono f32 at 16kHz.
///
/// The chunk table is walked rather than assumed. The app's own encoder writes
/// a fixed 44-byte header, but every other WAV in the world -- a sample used
/// in a test, a file a user drops in later -- puts metadata chunks ahead of
/// the audio, and reading those as samples produces a burst of noise instead
/// of an error.
pub fn decode_wav(bytes: &[u8]) -> Result<Vec<f32>, String> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("That is not a WAV file.".into());
    }

    let mut format: Option<(u16, u32, u16)> = None;
    let mut data: Option<&[u8]> = None;
    let mut cursor = 12;
    while cursor + 8 <= bytes.len() {
        let id = &bytes[cursor..cursor + 4];
        let size = u32::from_le_bytes([
            bytes[cursor + 4],
            bytes[cursor + 5],
            bytes[cursor + 6],
            bytes[cursor + 7],
        ]) as usize;
        let body = cursor + 8;
        // A truncated final chunk is taken as far as it goes: a recording cut
        // short is still worth transcribing.
        let end = body.saturating_add(size).min(bytes.len());
        match id {
            b"fmt " if size >= 16 => {
                format = Some((
                    u16::from_le_bytes([bytes[body + 2], bytes[body + 3]]),
                    u32::from_le_bytes([
                        bytes[body + 4],
                        bytes[body + 5],
                        bytes[body + 6],
                        bytes[body + 7],
                    ]),
                    u16::from_le_bytes([bytes[body + 14], bytes[body + 15]]),
                ));
            }
            b"data" => data = Some(&bytes[body..end]),
            _ => {}
        }
        // Chunks are word-aligned, and an odd-sized one is followed by a pad
        // byte that is not part of any chunk.
        cursor = body + size + (size & 1);
    }

    let (channels, rate, bits) = format.ok_or("The WAV file has no format chunk.")?;
    let data = data.ok_or("The WAV file has no audio in it.")?;
    if channels != 1 || bits != 16 {
        return Err(format!(
            "Expected mono 16-bit audio, got {channels} channel(s) at {bits}-bit."
        ));
    }
    if rate == 0 {
        return Err("The WAV header claims a sample rate of zero.".into());
    }

    let samples: Vec<f32> = data
        .chunks_exact(2)
        .map(|pair| i16::from_le_bytes([pair[0], pair[1]]) as f32 / 32_768.0)
        .collect();

    Ok(resample(&samples, rate, WHISPER_RATE))
}

/// Windowed-sinc resampling.
///
/// The microphone runs at whatever rate the audio hardware chose, usually
/// 48kHz, and Whisper is trained on 16kHz. Dropping samples to get there would
/// fold everything above 8kHz back down into the speech, which is exactly the
/// band the model listens to, so the kernel band-limits first.
fn resample(input: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to || input.is_empty() {
        return input.to_vec();
    }
    let ratio = to as f64 / from as f64;
    // Cutoff at the lower of the two Nyquist limits, which is what makes this
    // an anti-aliasing filter rather than just an interpolation.
    let cutoff = 0.5 * ratio.min(1.0);
    // Half-width in input samples. Wider is sharper and slower; three lobes of
    // a Blackman-windowed sinc is inaudible here and cheap.
    let half = (3.0 / cutoff).ceil() as isize;
    let output_len = ((input.len() as f64) * ratio).round() as usize;

    let mut output = Vec::with_capacity(output_len);
    for index in 0..output_len {
        let centre = index as f64 / ratio;
        let first = centre.floor() as isize - half;
        let mut sum = 0.0;
        let mut weight = 0.0;
        for tap in first..=(first + 2 * half) {
            if tap < 0 || tap as usize >= input.len() {
                continue;
            }
            let distance = centre - tap as f64;
            let value = sinc(2.0 * cutoff * distance) * blackman(distance, half as f64);
            sum += input[tap as usize] as f64 * value;
            weight += value;
        }
        output.push(if weight.abs() > f64::EPSILON {
            (sum / weight) as f32
        } else {
            0.0
        });
    }
    output
}

fn sinc(x: f64) -> f64 {
    if x.abs() < 1e-9 {
        return 1.0;
    }
    let pi_x = std::f64::consts::PI * x;
    pi_x.sin() / pi_x
}

fn blackman(distance: f64, half: f64) -> f64 {
    if distance.abs() > half {
        return 0.0;
    }
    let t = (distance + half) / (2.0 * half);
    let two_pi_t = 2.0 * std::f64::consts::PI * t;
    0.42 - 0.5 * two_pi_t.cos() + 0.08 * (2.0 * two_pi_t).cos()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wav(samples: &[i16], rate: u32) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + samples.len() as u32 * 2).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&rate.to_le_bytes());
        bytes.extend_from_slice(&(rate * 2).to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&(samples.len() as u32 * 2).to_le_bytes());
        for sample in samples {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        bytes
    }

    #[test]
    fn audio_already_at_16k_is_left_alone() {
        let decoded = decode_wav(&wav(&[0, 16_384, -16_384, 0], 16_000)).unwrap();
        assert_eq!(decoded.len(), 4);
        assert!((decoded[1] - 0.5).abs() < 1e-3);
        assert!((decoded[2] + 0.5).abs() < 1e-3);
    }

    #[test]
    fn a_48k_recording_comes_back_at_a_third_the_length() {
        let samples: Vec<i16> = (0..4_800).map(|n| ((n % 100) as i16 - 50) * 200).collect();
        let decoded = decode_wav(&wav(&samples, 48_000)).unwrap();
        assert_eq!(decoded.len(), 1_600);
    }

    /// A resampler that let anything through above the new Nyquist limit would
    /// smear that energy across the speech band instead of removing it.
    #[test]
    fn a_tone_above_the_new_nyquist_limit_is_filtered_out() {
        // 12kHz at 48kHz in: above 8kHz, so it cannot survive the trip to 16k.
        let samples: Vec<i16> = (0..4_800)
            .map(|n| {
                let phase = 2.0 * std::f64::consts::PI * 12_000.0 * (n as f64) / 48_000.0;
                (phase.sin() * 20_000.0) as i16
            })
            .collect();
        let decoded = decode_wav(&wav(&samples, 48_000)).unwrap();
        let peak = decoded[100..1_500].iter().fold(0.0f32, |a, b| a.max(b.abs()));
        assert!(peak < 0.05, "12kHz tone survived at {peak}");
    }

    #[test]
    fn a_tone_inside_the_speech_band_survives() {
        let samples: Vec<i16> = (0..4_800)
            .map(|n| {
                let phase = 2.0 * std::f64::consts::PI * 1_000.0 * (n as f64) / 48_000.0;
                (phase.sin() * 20_000.0) as i16
            })
            .collect();
        let decoded = decode_wav(&wav(&samples, 48_000)).unwrap();
        let peak = decoded[100..1_500].iter().fold(0.0f32, |a, b| a.max(b.abs()));
        assert!(peak > 0.5, "1kHz tone came back at only {peak}");
    }

    #[test]
    fn descriptions_of_the_audio_are_not_speech() {
        assert!(!is_speech("[BLANK_AUDIO]"));
        assert!(!is_speech(" [ Silence ] "));
        assert!(!is_speech("(buzzer)"));
        assert!(!is_speech("*laughs*"));
        assert!(!is_speech("   "));
        assert!(is_speech("Hello there."));
        // Brackets inside speech are speech. Only a segment that is nothing
        // but a bracketed phrase is whisper describing what it heard.
        assert!(is_speech("the value [see below] is wrong"));
        assert!(is_speech("(as I said) it works"));
    }

    /// Silence must come back as nothing, not as a description of itself.
    ///
    /// Ignored by default: it needs the real weights. Run with
    /// `cargo test silence -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn silence_transcribes_to_nothing() {
        let context = load("ggml-small.bin").expect("could not load the weights");
        let quiet = vec![0.0f32; WHISPER_RATE as usize * 2];
        let text = transcribe(&context, &quiet, "en").expect("transcription failed");
        assert_eq!(text, "", "two seconds of silence produced {text:?}");
    }

    /// The whole path, on real speech, with real weights.
    ///
    /// Ignored by default: it needs `pnpm setup:whisper-cpp` to have run and a
    /// sample to point at, so it is a thing to run deliberately rather than
    /// something CI can be expected to have. Run with:
    ///
    /// ```text
    /// WAVEFORM_TEST_WAV=/path/to/speech.wav cargo test -- --ignored transcribes
    /// ```
    #[test]
    #[ignore]
    fn transcribes_real_speech() {
        let path = std::env::var("WAVEFORM_TEST_WAV").expect("set WAVEFORM_TEST_WAV");
        let bytes = std::fs::read(&path).expect("could not read the sample");
        let audio = decode_wav(&bytes).expect("could not decode the sample");
        let loading = std::time::Instant::now();
        let context = load("ggml-small.bin").expect("could not load the weights");
        let loaded = loading.elapsed();
        let running = std::time::Instant::now();
        let text = transcribe(&context, &audio, "en").expect("transcription failed");
        eprintln!(
            "load {:.2}s, transcribe {:.2}s for {:.1}s of audio\ntranscript: {text}",
            loaded.as_secs_f64(),
            running.elapsed().as_secs_f64(),
            audio.len() as f64 / 16_000.0,
        );
        assert!(!text.is_empty());
    }

    #[test]
    fn stereo_is_refused_rather_than_misread() {
        let mut bytes = wav(&[0, 0], 16_000);
        bytes[22] = 2;
        assert!(decode_wav(&bytes).is_err());
    }
}
