//! Cutting a stream of PCM into phrases, and writing it to disk.
//!
//! A port of the renderer's `segmenter.ts` and `gain.ts`, kept in step with
//! them: dictation cuts phrases in the overlay's webview, which is always
//! running, but a meeting recording cannot depend on a webview at all -- it
//! runs for an hour and must survive the window being closed. The same
//! thresholds and the same reasoning apply; the comments there are the
//! longer story.

use std::fs::{File, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::path::Path;

/// Nothing quieter than this is speech, however quiet the room is.
const MINIMUM_THRESHOLD: f32 = 0.004;
/// How far above the room a block has to sit to count as speech (about 8 dB).
const FLOOR_MARGIN: f32 = 2.5;
/// How long the room is listened to before anything counts as speech.
const CALIBRATION_MS: u32 = 250;
/// Which calibration block stands for the room: the tenth percentile.
const CALIBRATION_PERCENTILE: f32 = 0.1;
/// Below this a block is a dropout, not a room.
const DROPOUT_LEVEL: f32 = 1e-5;
/// How much audio is kept ahead of the first phrase.
const LEAD_IN_MS: u32 = 3_000;

/// A phrase cut from the stream, with where it sat in the recording.
pub struct Phrase {
    pub samples: Vec<f32>,
    /// Milliseconds from the start of the stream to the first sample.
    pub start_ms: u64,
    pub end_ms: u64,
}

pub struct SegmenterOptions {
    pub sample_rate: u32,
    pub trailing_silence_ms: u32,
    pub minimum_speech_ms: u32,
    pub flush_minimum_speech_ms: u32,
    pub pre_roll_ms: u32,
    pub maximum_segment_ms: u32,
}

impl SegmenterOptions {
    /// What dictation uses; see `segmenter.ts` for why each number.
    pub fn dictation(sample_rate: u32) -> Self {
        Self {
            sample_rate,
            trailing_silence_ms: 650,
            minimum_speech_ms: 120,
            flush_minimum_speech_ms: 60,
            pre_roll_ms: 320,
            maximum_segment_ms: 15_000,
        }
    }

    /// A meeting: people talk over longer stretches and pause for longer, so
    /// phrases run longer before a cut and a pause has to be clearer.
    pub fn meeting(sample_rate: u32) -> Self {
        Self {
            trailing_silence_ms: 800,
            maximum_segment_ms: 25_000,
            ..Self::dictation(sample_rate)
        }
    }
}

/// Splits PCM at natural pauses. Feed it blocks; it hands back phrases.
pub struct Segmenter {
    sample_rate: u32,
    floor: f32,
    calibrating: i64,
    calibration_levels: Vec<f32>,
    trailing_silence: usize,
    minimum_speech: usize,
    flush_minimum_speech: usize,
    pre_roll_limit: usize,
    lead_in_limit: usize,
    maximum_segment: usize,
    heard_phrase: bool,
    pre_roll: Vec<Vec<f32>>,
    pre_roll_len: usize,
    segment: Vec<Vec<f32>>,
    segment_len: usize,
    /// Where the current segment's first sample sits in the stream.
    segment_start: u64,
    speech_samples: usize,
    silence_samples: usize,
    speaking: bool,
    /// Samples seen so far, for timestamps.
    position: u64,
    gain: InputGain,
}

impl Segmenter {
    pub fn new(options: SegmenterOptions) -> Self {
        let rate = options.sample_rate;
        let to_samples = |ms: u32| (ms as u64 * rate as u64 / 1_000) as usize;
        let pre_roll_limit = to_samples(options.pre_roll_ms);
        Self {
            sample_rate: rate,
            floor: 0.0,
            calibrating: to_samples(CALIBRATION_MS) as i64,
            calibration_levels: Vec::new(),
            trailing_silence: to_samples(options.trailing_silence_ms),
            minimum_speech: to_samples(options.minimum_speech_ms),
            flush_minimum_speech: to_samples(options.flush_minimum_speech_ms),
            pre_roll_limit,
            lead_in_limit: pre_roll_limit.max(to_samples(LEAD_IN_MS)),
            maximum_segment: to_samples(options.maximum_segment_ms),
            heard_phrase: false,
            pre_roll: Vec::new(),
            pre_roll_len: 0,
            segment: Vec::new(),
            segment_len: 0,
            segment_start: 0,
            speech_samples: 0,
            silence_samples: 0,
            speaking: false,
            position: 0,
            gain: InputGain::default(),
        }
    }

    pub fn threshold(&self) -> f32 {
        MINIMUM_THRESHOLD.max(self.floor * FLOOR_MARGIN)
    }

    /// Feeds one block. Returns a phrase when this block completed one.
    pub fn push(&mut self, block: &[f32]) -> Option<Phrase> {
        let block_start = self.position;
        self.position += block.len() as u64;
        let factor = self.gain.measure(block);
        let level = rms(block) * factor;

        if self.calibrating > 0 {
            self.calibrating -= block.len() as i64;
            if level > DROPOUT_LEVEL {
                self.calibration_levels.push(level);
            }
            if self.calibrating <= 0 {
                self.settle_calibration();
            }
            self.add_pre_roll(block);
            return None;
        }

        let is_speech = level >= self.threshold();
        if !is_speech && !self.speaking {
            let weight = if level < self.floor { 0.5 } else { 0.05 };
            self.learn_floor(level, weight);
        }

        if !self.speaking {
            if !is_speech {
                self.add_pre_roll(block);
                return None;
            }
            self.speaking = true;
            self.segment_start = block_start.saturating_sub(self.pre_roll_len as u64);
            self.segment = std::mem::take(&mut self.pre_roll);
            self.segment.push(block.to_vec());
            self.segment_len = self.pre_roll_len + block.len();
            self.pre_roll_len = 0;
        } else {
            self.segment.push(block.to_vec());
            self.segment_len += block.len();
        }

        if is_speech {
            self.speech_samples += block.len();
            self.silence_samples = 0;
        } else {
            self.silence_samples += block.len();
        }

        if self.silence_samples >= self.trailing_silence || self.segment_len >= self.maximum_segment {
            return self.finish(self.minimum_speech);
        }
        None
    }

    /// Ends the stream and returns whatever was captured.
    pub fn flush(&mut self) -> Option<Phrase> {
        self.finish(self.flush_minimum_speech)
    }

    fn settle_calibration(&mut self) {
        let mut levels = std::mem::take(&mut self.calibration_levels);
        if levels.is_empty() {
            return;
        }
        levels.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let index = ((levels.len() - 1) as f32 * CALIBRATION_PERCENTILE).floor() as usize;
        self.floor = levels[index];
    }

    fn learn_floor(&mut self, level: f32, weight: f32) {
        self.floor = if self.floor == 0.0 {
            level
        } else {
            self.floor * (1.0 - weight) + level * weight
        };
    }

    fn add_pre_roll(&mut self, block: &[f32]) {
        self.pre_roll.push(block.to_vec());
        self.pre_roll_len += block.len();
        let limit = if self.heard_phrase {
            self.pre_roll_limit
        } else {
            self.lead_in_limit
        };
        while self.pre_roll_len > limit && self.pre_roll.len() > 1 {
            let removed = self.pre_roll.remove(0);
            self.pre_roll_len -= removed.len();
        }
    }

    fn finish(&mut self, minimum_speech: usize) -> Option<Phrase> {
        let valid = self.speaking && self.speech_samples >= minimum_speech;
        let result = if valid {
            self.heard_phrase = true;
            let samples: Vec<f32> = self.segment.concat();
            let start_ms = self.segment_start * 1_000 / self.sample_rate as u64;
            let end_ms = (self.segment_start + samples.len() as u64) * 1_000 / self.sample_rate as u64;
            Some(Phrase {
                samples,
                start_ms,
                end_ms,
            })
        } else {
            None
        };
        self.segment.clear();
        self.segment_len = 0;
        self.speech_samples = 0;
        self.silence_samples = 0;
        self.speaking = false;
        self.pre_roll.clear();
        self.pre_roll_len = 0;
        result
    }
}

/// Follows the input level so a quiet microphone still trips detection.
/// Detection only: the samples themselves are never boosted.
#[derive(Default)]
pub struct InputGain {
    peak: f32,
    applied: f32,
}

const TARGET_PEAK: f32 = 0.08;
const MAX_GAIN: f32 = 32.0;

impl InputGain {
    pub fn measure(&mut self, samples: &[f32]) -> f32 {
        let level = rms(samples);
        self.peak = level.max(self.peak * 0.995);
        let desired = self.desired();
        if self.applied == 0.0 || desired > self.applied || self.peak >= TARGET_PEAK {
            self.applied = desired;
        }
        self.applied
    }

    fn desired(&self) -> f32 {
        (TARGET_PEAK / self.peak.max(TARGET_PEAK / MAX_GAIN))
            .max(1.0)
            .min(MAX_GAIN)
    }
}

pub fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum: f32 = samples.iter().map(|s| s * s).sum();
    (sum / samples.len() as f32).sqrt()
}

/// Scales a phrase so its peak sits near full scale, as dictation does
/// before handing a phrase to the engine.
pub fn normalize_phrase(samples: &[f32]) -> Vec<f32> {
    let peak = samples.iter().fold(0.0f32, |peak, s| peak.max(s.abs()));
    if peak == 0.0 {
        return samples.to_vec();
    }
    let factor = (0.9 / peak).min(MAX_GAIN);
    samples.iter().map(|s| s * factor).collect()
}

/// Mono 16-bit PCM WAV bytes, as `wav.ts` writes them.
pub fn encode_wav(samples: &[f32], sample_rate: u32) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(44 + samples.len() * 2);
    bytes.extend_from_slice(&wav_header(sample_rate, samples.len() * 2));
    for sample in samples {
        let clamped = sample.clamp(-1.0, 1.0);
        let value = if clamped < 0.0 {
            (clamped * 0x8000 as f32) as i16
        } else {
            (clamped * 0x7fff as f32) as i16
        };
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes
}

fn wav_header(sample_rate: u32, data_bytes: usize) -> [u8; 44] {
    let mut header = [0u8; 44];
    header[0..4].copy_from_slice(b"RIFF");
    header[4..8].copy_from_slice(&((36 + data_bytes) as u32).to_le_bytes());
    header[8..12].copy_from_slice(b"WAVE");
    header[12..16].copy_from_slice(b"fmt ");
    header[16..20].copy_from_slice(&16u32.to_le_bytes());
    header[20..22].copy_from_slice(&1u16.to_le_bytes());
    header[22..24].copy_from_slice(&1u16.to_le_bytes());
    header[24..28].copy_from_slice(&sample_rate.to_le_bytes());
    header[28..32].copy_from_slice(&(sample_rate * 2).to_le_bytes());
    header[32..34].copy_from_slice(&2u16.to_le_bytes());
    header[34..36].copy_from_slice(&16u16.to_le_bytes());
    header[36..40].copy_from_slice(b"data");
    header[40..44].copy_from_slice(&(data_bytes as u32).to_le_bytes());
    header
}

/// A mono 16-bit WAV written as the audio arrives.
///
/// The header's sizes are patched on `finish`, and also every few seconds
/// while recording, so a crash mid-meeting leaves a file that still plays up
/// to where it stopped rather than one that reads as empty.
pub struct WavWriter {
    file: File,
    sample_rate: u32,
    data_bytes: usize,
    since_header: usize,
}

impl WavWriter {
    pub fn create(path: &Path, sample_rate: u32) -> std::io::Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(path)?;
        file.write_all(&wav_header(sample_rate, 0))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
        }
        Ok(Self {
            file,
            sample_rate,
            data_bytes: 0,
            since_header: 0,
        })
    }

    pub fn write(&mut self, samples: &[f32]) -> std::io::Result<()> {
        let mut bytes = Vec::with_capacity(samples.len() * 2);
        for sample in samples {
            let clamped = sample.clamp(-1.0, 1.0);
            let value = if clamped < 0.0 {
                (clamped * 0x8000 as f32) as i16
            } else {
                (clamped * 0x7fff as f32) as i16
            };
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        self.file.write_all(&bytes)?;
        self.data_bytes += bytes.len();
        self.since_header += bytes.len();
        // Every ~5 s at 48 kHz mono.
        if self.since_header >= self.sample_rate as usize * 2 * 5 {
            self.patch_header()?;
        }
        Ok(())
    }

    /// Seconds of audio written so far.
    pub fn seconds(&self) -> f64 {
        self.data_bytes as f64 / 2.0 / self.sample_rate as f64
    }

    pub fn finish(mut self) -> std::io::Result<()> {
        self.patch_header()?;
        self.file.flush()
    }

    fn patch_header(&mut self) -> std::io::Result<()> {
        let end = self.file.stream_position()?;
        self.file.seek(SeekFrom::Start(0))?;
        self.file
            .write_all(&wav_header(self.sample_rate, self.data_bytes))?;
        self.file.seek(SeekFrom::Start(end))?;
        self.since_header = 0;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u32 = 8_000;
    const BLOCK: usize = 400; // 50 ms

    fn block(amplitude: f32) -> Vec<f32> {
        vec![amplitude; BLOCK]
    }

    fn feed(segmenter: &mut Segmenter, ms: u32, amplitude: f32) -> Vec<Phrase> {
        let mut phrases = Vec::new();
        let mut fed = 0;
        while fed < ms {
            if let Some(phrase) = segmenter.push(&block(amplitude)) {
                phrases.push(phrase);
            }
            fed += 50;
        }
        phrases
    }

    #[test]
    fn cuts_a_phrase_at_trailing_silence_with_its_timestamps() {
        let mut segmenter = Segmenter::new(SegmenterOptions::dictation(RATE));
        assert!(feed(&mut segmenter, 300, 0.0).is_empty()); // calibration
        assert!(feed(&mut segmenter, 1_000, 0.2).is_empty());
        let phrases = feed(&mut segmenter, 800, 0.0);
        assert_eq!(phrases.len(), 1);
        let phrase = &phrases[0];
        // Lead-in keeps the 300 ms of room before the first phrase.
        assert_eq!(phrase.start_ms, 0);
        // 300 lead-in + 1000 speech + 650 trailing silence (13 blocks).
        assert_eq!(phrase.end_ms, 300 + 1_000 + 650);
        assert_eq!(phrase.samples.len(), (phrase.end_ms as usize) * RATE as usize / 1_000);
    }

    #[test]
    fn a_second_phrase_starts_where_its_pre_roll_does() {
        let mut segmenter = Segmenter::new(SegmenterOptions::dictation(RATE));
        feed(&mut segmenter, 300, 0.0);
        feed(&mut segmenter, 1_000, 0.2);
        feed(&mut segmenter, 800, 0.0);
        // 2 s of room, then speech again: the pre-roll is 320 ms (7 blocks of 50 ms, rounded up).
        feed(&mut segmenter, 2_000, 0.0);
        feed(&mut segmenter, 500, 0.2);
        let phrases = feed(&mut segmenter, 800, 0.0);
        assert_eq!(phrases.len(), 1);
        let speech_started = 300 + 1_000 + 800 + 2_000;
        let start = phrases[0].start_ms;
        assert!(start < speech_started && start >= speech_started - 400, "{start}");
    }

    #[test]
    fn a_click_is_not_a_phrase_but_a_flush_keeps_short_speech() {
        let mut segmenter = Segmenter::new(SegmenterOptions::dictation(RATE));
        feed(&mut segmenter, 300, 0.0);
        feed(&mut segmenter, 50, 0.2); // 50 ms: under the 120 ms minimum
        assert!(feed(&mut segmenter, 800, 0.0).is_empty());

        feed(&mut segmenter, 100, 0.2); // under 120 but over the 60 ms flush floor
        assert!(segmenter.flush().is_some());
    }

    #[test]
    fn a_long_monologue_is_cut_at_the_cap() {
        let mut segmenter = Segmenter::new(SegmenterOptions::meeting(RATE));
        feed(&mut segmenter, 300, 0.0);
        let phrases = feed(&mut segmenter, 30_000, 0.2);
        assert_eq!(phrases.len(), 1);
        assert_eq!(phrases[0].end_ms - phrases[0].start_ms, 25_000);
    }

    #[test]
    fn silence_alone_yields_nothing() {
        let mut segmenter = Segmenter::new(SegmenterOptions::dictation(RATE));
        assert!(feed(&mut segmenter, 5_000, 0.0).is_empty());
        assert!(segmenter.flush().is_none());
    }

    #[test]
    fn a_noisy_room_raises_the_threshold() {
        let mut segmenter = Segmenter::new(SegmenterOptions::dictation(RATE));
        feed(&mut segmenter, 300, 0.01); // room at 0.01 RMS
        assert!(segmenter.threshold() > 0.02);
        // Something barely above the room is not speech here.
        assert!(feed(&mut segmenter, 1_000, 0.015).is_empty());
        assert!(feed(&mut segmenter, 800, 0.01).is_empty());
    }

    #[test]
    fn wav_round_trip_and_incremental_header() {
        let dir = crate::store::temp_dir("wav");
        let path = dir.join("t.wav");
        let mut writer = WavWriter::create(&path, RATE).unwrap();
        writer.write(&vec![0.5; 1_000]).unwrap();
        writer.write(&vec![-0.5; 1_000]).unwrap();
        assert!((writer.seconds() - 0.25).abs() < 1e-9);
        writer.finish().unwrap();

        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(bytes.len(), 44 + 4_000);
        let decoded = crate::whisper_cpp::decode_wav(&bytes).unwrap();
        // decode_wav resamples 8k → 16k, so twice the samples.
        assert_eq!(decoded.len(), 4_000);

        let encoded = encode_wav(&[0.0, 1.0, -1.0], RATE);
        assert_eq!(encoded.len(), 44 + 6);
        assert_eq!(&encoded[44..46], &0i16.to_le_bytes());
        assert_eq!(&encoded[46..48], &i16::MAX.to_le_bytes());
        assert_eq!(&encoded[48..50], &i16::MIN.to_le_bytes());
    }

    #[test]
    fn normalising_a_phrase_brings_its_peak_up() {
        let out = normalize_phrase(&[0.1, -0.05]);
        assert!((out[0] - 0.9).abs() < 1e-6);
        assert!((out[1] + 0.45).abs() < 1e-6);
        assert_eq!(normalize_phrase(&[0.0, 0.0]), vec![0.0, 0.0]);
    }
}
