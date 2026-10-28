//! Measuring how well speakers are told apart.
//!
//! Dev-only: nothing in the app calls this. `examples/diarize_eval.rs` runs
//! the same diarizer the app runs on recordings whose speakers are known, and
//! scores the result three ways:
//!
//! - **DER**, diarization error rate: of the time someone is speaking, the
//!   share that is missed, invented, or given to the wrong person. Scored on
//!   10 ms frames with a 250 ms forgiveness collar around every reference
//!   boundary and overlap included, which is how published results are
//!   reported, so a number here can be held against a paper's.
//! - **Speaker count**: how many people were found against how many spoke.
//! - **Line accuracy**: the share of transcript lines that carry the right
//!   person. This is what the user sees. DER weighs every second; a line is
//!   wrong whether it is off by a word or by all of it.
//!
//! Labels on the two sides never match by name (`speaker_00` against
//! `FEE013`), so both DER and line accuracy first pair them up the way that
//! scores best, as every diarization scorer does.

use crate::diarize::{Span, Turn};
use std::collections::BTreeMap;

const FRAME_MS: u64 = 10;
pub const COLLAR_MS: u64 = 250;

/// One stretch of one speaker: a reference turn or a hypothesis turn.
#[derive(Clone, Debug, PartialEq)]
pub struct Segment {
    pub start_ms: u64,
    pub end_ms: u64,
    pub speaker: String,
}

impl From<&Turn> for Segment {
    fn from(turn: &Turn) -> Self {
        Segment { start_ms: turn.start_ms, end_ms: turn.end_ms, speaker: turn.label.clone() }
    }
}

/// Reads `SPEAKER <file> <chan> <start> <duration> <NA> <NA> <who> ...` lines.
pub fn parse_rttm(text: &str) -> Vec<Segment> {
    text.lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            if fields.len() < 8 || fields[0] != "SPEAKER" {
                return None;
            }
            let start: f64 = fields[3].parse().ok()?;
            let duration: f64 = fields[4].parse().ok()?;
            Some(Segment {
                start_ms: (start * 1_000.0).round() as u64,
                end_ms: ((start + duration) * 1_000.0).round() as u64,
                speaker: fields[7].to_string(),
            })
        })
        .collect()
}

pub fn to_rttm(file: &str, segments: &[Segment]) -> String {
    segments
        .iter()
        .map(|segment| {
            format!(
                "SPEAKER {file} 1 {:.3} {:.3} <NA> <NA> {} <NA> <NA>\n",
                segment.start_ms as f64 / 1_000.0,
                (segment.end_ms - segment.start_ms) as f64 / 1_000.0,
                segment.speaker
            )
        })
        .collect()
}

/// Milliseconds of each kind of error, summed so that several recordings can
/// be pooled before dividing.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Score {
    /// Reference speaker-time that counts: two people at once is twice.
    pub scored_ms: u64,
    pub missed_ms: u64,
    pub false_alarm_ms: u64,
    pub confusion_ms: u64,
}

impl Score {
    pub fn der(&self) -> f64 {
        ratio(self.missed_ms + self.false_alarm_ms + self.confusion_ms, self.scored_ms)
    }
    pub fn add(&mut self, other: &Score) {
        self.scored_ms += other.scored_ms;
        self.missed_ms += other.missed_ms;
        self.false_alarm_ms += other.false_alarm_ms;
        self.confusion_ms += other.confusion_ms;
    }
}

fn ratio(part: u64, whole: u64) -> f64 {
    if whole == 0 {
        0.0
    } else {
        part as f64 / whole as f64
    }
}

/// Who is speaking in each 10 ms frame, as indices into `names`.
struct Frames {
    names: Vec<String>,
    active: Vec<Vec<usize>>,
}

fn frames(segments: &[Segment], count: usize) -> Frames {
    let mut names: Vec<String> = Vec::new();
    let mut active = vec![Vec::new(); count];
    for segment in segments {
        let index = match names.iter().position(|name| *name == segment.speaker) {
            Some(index) => index,
            None => {
                names.push(segment.speaker.clone());
                names.len() - 1
            }
        };
        let first = (segment.start_ms / FRAME_MS) as usize;
        let last = ((segment.end_ms / FRAME_MS) as usize).min(count);
        for frame in &mut active[first.min(count)..last] {
            if !frame.contains(&index) {
                frame.push(index);
            }
        }
    }
    Frames { names, active }
}

/// Scores `hypothesis` against `reference`.
pub fn score(reference: &[Segment], hypothesis: &[Segment], collar_ms: u64) -> Score {
    let end = reference.iter().chain(hypothesis).map(|s| s.end_ms).max().unwrap_or(0);
    let count = (end / FRAME_MS) as usize + 1;
    let truth = frames(reference, count);
    let guess = frames(hypothesis, count);

    // Frames too close to a reference boundary for a human to have placed
    // it exactly are not held against either side.
    let mut skip = vec![false; count];
    let collar = (collar_ms / FRAME_MS) as usize;
    for segment in reference {
        for edge in [segment.start_ms, segment.end_ms] {
            let middle = (edge / FRAME_MS) as usize;
            for frame in &mut skip[middle.saturating_sub(collar)..(middle + collar).min(count)] {
                *frame = true;
            }
        }
    }

    // Time each reference speaker shares with each hypothesis speaker; the
    // pairing that maximises it is the one scored.
    let mut together = vec![vec![0u64; guess.names.len()]; truth.names.len()];
    for frame in 0..count {
        if skip[frame] {
            continue;
        }
        for &r in &truth.active[frame] {
            for &h in &guess.active[frame] {
                together[r][h] += 1;
            }
        }
    }
    let pairing = best_pairing(&together);

    let mut out = Score::default();
    for frame in 0..count {
        if skip[frame] {
            continue;
        }
        let r = &truth.active[frame];
        let h = &guess.active[frame];
        let matched = r
            .iter()
            .filter(|&&speaker| pairing[speaker].is_some_and(|paired| h.contains(&paired)))
            .count() as u64;
        let (r, h) = (r.len() as u64, h.len() as u64);
        out.scored_ms += r * FRAME_MS;
        out.missed_ms += r.saturating_sub(h) * FRAME_MS;
        out.false_alarm_ms += h.saturating_sub(r) * FRAME_MS;
        out.confusion_ms += (r.min(h) - matched) * FRAME_MS;
    }
    out
}

pub fn speaker_count(segments: &[Segment]) -> usize {
    let mut names: Vec<&str> = segments.iter().map(|s| s.speaker.as_str()).collect();
    names.sort();
    names.dedup();
    names.len()
}

/// Where the app would cut `samples` (16 kHz) into transcript lines: the
/// meeting recorder's own segmenter, fed 10 ms blocks. Like the app, it does
/// not know who is talking, so a line can hold two people.
pub fn app_lines(samples: &[f32]) -> Vec<Span> {
    use crate::audio::{Segmenter, SegmenterOptions};
    let mut segmenter = Segmenter::new(SegmenterOptions::meeting(16_000));
    let mut lines = Vec::new();
    let mut add = |phrase: crate::audio::Phrase| {
        lines.push(Span { idx: lines.len() as i64, start_ms: phrase.start_ms, end_ms: phrase.end_ms })
    };
    for block in samples.chunks(160) {
        if let Some(phrase) = segmenter.push(block) {
            add(phrase);
        }
    }
    if let Some(phrase) = segmenter.flush() {
        add(phrase);
    }
    lines
}

/// Whether more than a fifth of the speech in `[start, end)` is someone other
/// than the main speaker: a line no single label can get right.
pub fn is_mixed(reference: &[Segment], start_ms: u64, end_ms: u64) -> bool {
    let mut by_speaker: BTreeMap<&str, u64> = BTreeMap::new();
    for segment in reference {
        let overlap = segment.end_ms.min(end_ms).saturating_sub(segment.start_ms.max(start_ms));
        if overlap > 0 {
            *by_speaker.entry(segment.speaker.as_str()).or_default() += overlap;
        }
    }
    let total: u64 = by_speaker.values().sum();
    let top = by_speaker.values().copied().max().unwrap_or(0);
    total > 0 && top * 5 < total * 4
}

/// The reference speaker who talks most during `[start, end)`, if anyone does.
pub fn majority(reference: &[Segment], start_ms: u64, end_ms: u64) -> Option<&str> {
    let mut by_speaker: BTreeMap<&str, u64> = BTreeMap::new();
    for segment in reference {
        let overlap = segment.end_ms.min(end_ms).saturating_sub(segment.start_ms.max(start_ms));
        if overlap > 0 {
            *by_speaker.entry(segment.speaker.as_str()).or_default() += overlap;
        }
    }
    by_speaker.into_iter().max_by_key(|(_, ms)| *ms).map(|(name, _)| name)
}

/// Lines right and lines scored. A line nobody in the reference speaks during
/// is not scored; a line the diarizer left untagged is scored, and wrong.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct LineScore {
    pub correct: usize,
    pub total: usize,
    /// Lines that hold two people (see `is_mixed`); set by the caller.
    pub mixed: usize,
}

impl LineScore {
    pub fn accuracy(&self) -> f64 {
        ratio(self.correct as u64, self.total as u64)
    }
    pub fn add(&mut self, other: &LineScore) {
        self.correct += other.correct;
        self.total += other.total;
        self.mixed += other.mixed;
    }
}

/// `pairs` is each line's true speaker beside the label it was given.
pub fn line_accuracy(pairs: &[(String, Option<String>)]) -> LineScore {
    let mut truths: Vec<&str> = Vec::new();
    let mut guesses: Vec<&str> = Vec::new();
    let mut counts: BTreeMap<(usize, usize), u64> = BTreeMap::new();
    for (truth, guess) in pairs {
        let t = position_or_push(&mut truths, truth);
        if let Some(guess) = guess {
            let g = position_or_push(&mut guesses, guess);
            *counts.entry((t, g)).or_default() += 1;
        }
    }
    let mut together = vec![vec![0u64; guesses.len()]; truths.len()];
    for ((t, g), n) in &counts {
        together[*t][*g] = *n;
    }
    let pairing = best_pairing(&together);
    let correct = pairing
        .iter()
        .enumerate()
        .filter_map(|(t, g)| g.map(|g| together[t][g]))
        .sum::<u64>() as usize;
    LineScore { correct, total: pairs.len(), mixed: 0 }
}

fn position_or_push<'a>(names: &mut Vec<&'a str>, name: &'a str) -> usize {
    match names.iter().position(|n| *n == name) {
        Some(index) => index,
        None => {
            names.push(name);
            names.len() - 1
        }
    }
}

/// Writes 16 kHz samples as the PCM16 WAV the diarizer reads.
pub fn write_16k(samples: &[f32], out: &std::path::Path) -> Result<(), String> {
    std::fs::write(out, crate::audio::encode_wav(samples, 16_000)).map_err(|error| error.to_string())
}

/// Reads any mono 16-bit WAV, whatever its rate or chunk layout, at 16 kHz.
pub fn read_16k(wav: &std::path::Path) -> Result<Vec<f32>, String> {
    let bytes = std::fs::read(wav).map_err(|error| format!("{}: {error}", wav.display()))?;
    crate::whisper_cpp::decode_wav(&bytes).map_err(|error| format!("{}: {error}", wav.display()))
}

/// The reference cut off at `end_ms`, for scoring the start of a recording.
pub fn crop(reference: &[Segment], end_ms: u64) -> Vec<Segment> {
    reference
        .iter()
        .filter(|segment| segment.start_ms < end_ms)
        .map(|segment| Segment { end_ms: segment.end_ms.min(end_ms), ..segment.clone() })
        .collect()
}

/// Stretches where `speaker` talks and nobody else does.
pub fn solo(reference: &[Segment], speaker: &str) -> Vec<(u64, u64)> {
    let mut out = Vec::new();
    for segment in reference.iter().filter(|s| s.speaker == speaker) {
        let mut pieces = vec![(segment.start_ms, segment.end_ms)];
        for other in reference.iter().filter(|s| s.speaker != speaker) {
            pieces = pieces
                .into_iter()
                .flat_map(|(from, to)| {
                    let mut kept = Vec::new();
                    if other.start_ms > from {
                        kept.push((from, to.min(other.start_ms)));
                    }
                    if other.end_ms < to {
                        kept.push((from.max(other.end_ms), to));
                    }
                    kept.into_iter().filter(|(a, b)| b > a)
                })
                .collect();
        }
        out.extend(pieces);
    }
    out.sort();
    out
}

fn slice(samples: &[f32], from_ms: u64, to_ms: u64) -> &[f32] {
    let per_ms = 16;
    let from = ((from_ms * per_ms) as usize).min(samples.len());
    let to = ((to_ms * per_ms) as usize).min(samples.len());
    &samples[from..to]
}

/// Whose headset this is: the speaker who is loudest on it while talking
/// alone. Every headset also picks up the room, more quietly.
pub fn owner(headset: &[f32], reference: &[Segment]) -> Option<String> {
    let mut speakers: Vec<&str> = reference.iter().map(|s| s.speaker.as_str()).collect();
    speakers.sort();
    speakers.dedup();
    speakers
        .into_iter()
        .map(|speaker| {
            let (mut energy, mut count) = (0.0f64, 0usize);
            for (from, to) in solo(reference, speaker) {
                for sample in slice(headset, from, to) {
                    energy += (*sample as f64) * (*sample as f64);
                    count += 1;
                }
            }
            (speaker, if count == 0 { 0.0 } else { energy / count as f64 })
        })
        .max_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(speaker, _)| speaker.to_string())
}

/// Up to `want_ms` of `speaker` talking alone, in stretches of at least two
/// seconds, as the app would gather from dictations: short clips with a
/// little silence between them.
pub fn clips(samples: &[f32], reference: &[Segment], speaker: &str, want_ms: u64) -> Vec<f32> {
    let mut out = Vec::new();
    let mut have = 0;
    for (from, to) in solo(reference, speaker).into_iter().filter(|(a, b)| b - a >= 2_000) {
        if have >= want_ms {
            break;
        }
        out.extend_from_slice(slice(samples, from, to));
        out.resize(out.len() + 8_000, 0.0);
        have += to - from;
    }
    out
}

/// Pairs each row with at most one column, and each column with at most one
/// row, so that the paired weights sum to the most they can. Hungarian
/// method on the square matrix padded with zeros; speaker counts are small.
fn best_pairing(weights: &[Vec<u64>]) -> Vec<Option<usize>> {
    let rows = weights.len();
    let cols = weights.first().map_or(0, Vec::len);
    let n = rows.max(cols);
    if n == 0 {
        return vec![None; rows];
    }
    let most = weights.iter().flatten().copied().max().unwrap_or(0) as i64;
    // Minimise cost = most - weight; padding costs `most`, i.e. weight 0.
    let cost = |r: usize, c: usize| -> i64 {
        most - if r < rows && c < cols { weights[r][c] as i64 } else { 0 }
    };
    // e-maxx formulation, 1-based.
    let mut u = vec![0i64; n + 1];
    let mut v = vec![0i64; n + 1];
    let mut p = vec![0usize; n + 1];
    let mut way = vec![0usize; n + 1];
    for i in 1..=n {
        p[0] = i;
        let mut j0 = 0;
        let mut minv = vec![i64::MAX; n + 1];
        let mut used = vec![false; n + 1];
        loop {
            used[j0] = true;
            let i0 = p[j0];
            let mut delta = i64::MAX;
            let mut j1 = 0;
            for j in 1..=n {
                if !used[j] {
                    let cur = cost(i0 - 1, j - 1) - u[i0] - v[j];
                    if cur < minv[j] {
                        minv[j] = cur;
                        way[j] = j0;
                    }
                    if minv[j] < delta {
                        delta = minv[j];
                        j1 = j;
                    }
                }
            }
            for j in 0..=n {
                if used[j] {
                    u[p[j]] += delta;
                    v[j] -= delta;
                } else {
                    minv[j] -= delta;
                }
            }
            j0 = j1;
            if p[j0] == 0 {
                break;
            }
        }
        loop {
            let j1 = way[j0];
            p[j0] = p[j1];
            j0 = j1;
            if j0 == 0 {
                break;
            }
        }
    }
    let mut pairing = vec![None; rows];
    for j in 1..=n {
        let (r, c) = (p[j] - 1, j - 1);
        if r < rows && c < cols && weights[r][c] > 0 {
            pairing[r] = Some(c);
        }
    }
    pairing
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(start: u64, end: u64, who: &str) -> Segment {
        Segment { start_ms: start, end_ms: end, speaker: who.into() }
    }

    #[test]
    fn reads_rttm_and_writes_it_back() {
        let text = "SPEAKER ES2004a 1 0.37 1.39 <NA> <NA> MEO015 <NA> <NA>\nnoise\n";
        let segments = parse_rttm(text);
        assert_eq!(segments, vec![seg(370, 1_760, "MEO015")]);
        assert_eq!(parse_rttm(&to_rttm("x", &segments)), segments);
    }

    #[test]
    fn a_perfect_answer_under_other_names_scores_zero() {
        let reference = vec![seg(0, 5_000, "A"), seg(5_000, 10_000, "B")];
        let hypothesis = vec![seg(0, 5_000, "speaker_01"), seg(5_000, 10_000, "speaker_00")];
        let score = score(&reference, &hypothesis, 0);
        assert_eq!(score.der(), 0.0);
        assert_eq!(score.scored_ms, 10_000);
    }

    #[test]
    fn errors_are_split_into_their_kinds() {
        // A speaks 0–4 s, B 4–8 s. The guess calls all of 0–6 s one person,
        // misses 7–8 s, and invents speech at 9–10 s.
        let reference = vec![seg(0, 4_000, "A"), seg(4_000, 8_000, "B")];
        let hypothesis = vec![seg(0, 6_000, "x"), seg(6_000, 7_000, "y"), seg(9_000, 10_000, "y")];
        let score = score(&reference, &hypothesis, 0);
        assert_eq!(score.scored_ms, 8_000);
        assert_eq!(score.missed_ms, 1_000);
        assert_eq!(score.false_alarm_ms, 1_000);
        // x pairs with A (4 s together), y with B (1 s); 4–6 s is B heard as x.
        assert_eq!(score.confusion_ms, 2_000);
    }

    #[test]
    fn overlap_counts_each_speaker() {
        let reference = vec![seg(0, 2_000, "A"), seg(1_000, 2_000, "B")];
        let hypothesis = vec![seg(0, 2_000, "x")];
        let score = score(&reference, &hypothesis, 0);
        assert_eq!(score.scored_ms, 3_000);
        assert_eq!(score.missed_ms, 1_000);
        assert_eq!(score.confusion_ms, 0);
    }

    #[test]
    fn the_collar_forgives_boundaries() {
        let reference = vec![seg(1_000, 3_000, "A")];
        let hypothesis = vec![seg(1_200, 2_800, "x")];
        assert!(score(&reference, &hypothesis, 0).der() > 0.0);
        assert_eq!(score(&reference, &hypothesis, 250).der(), 0.0);
    }

    #[test]
    fn a_line_is_mixed_when_someone_else_has_over_a_fifth() {
        let reference = vec![seg(0, 8_000, "A"), seg(8_000, 10_000, "B")];
        assert!(!is_mixed(&reference, 0, 10_000)); // B has exactly a fifth
        assert!(is_mixed(&reference, 1_000, 10_000));
        assert!(!is_mixed(&reference, 20_000, 30_000));
    }

    #[test]
    fn line_accuracy_pairs_labels_before_counting() {
        let pairs = vec![
            ("A".to_string(), Some("s1".to_string())),
            ("A".to_string(), Some("s1".to_string())),
            ("B".to_string(), Some("s0".to_string())),
            ("B".to_string(), Some("s1".to_string())),
            ("C".to_string(), None),
        ];
        assert_eq!(line_accuracy(&pairs), LineScore { correct: 3, total: 5, mixed: 0 });
    }

    #[test]
    fn pairing_finds_the_best_overall_not_the_greedy_one() {
        // Greedy takes row 0 → col 0 (9) and leaves row 1 with 1; best is 8 + 8.
        let pairing = best_pairing(&[vec![9, 8], vec![8, 1]]);
        assert_eq!(pairing, vec![Some(1), Some(0)]);
        // More guesses than truths, and the reverse.
        assert_eq!(best_pairing(&[vec![0, 5, 1]]), vec![Some(1)]);
        assert_eq!(best_pairing(&[vec![2], vec![7]]), vec![None, Some(0)]);
    }

    #[test]
    fn solo_cuts_out_everyone_else() {
        let reference = vec![seg(0, 10_000, "A"), seg(2_000, 3_000, "B"), seg(9_000, 12_000, "B")];
        assert_eq!(solo(&reference, "A"), vec![(0, 2_000), (3_000, 9_000)]);
        assert_eq!(solo(&reference, "B"), vec![(10_000, 12_000)]);
    }
}
