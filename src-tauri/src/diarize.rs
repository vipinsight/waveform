//! Telling the speakers on the remote track apart.
//!
//! sherpa-onnx's offline speaker diarization, run as a downloaded command
//! line tool the way nemo-speech is: a prebuilt binary and three ONNX files
//! under Application Support, no Python, nothing leaves the Mac. The tool
//! prints one line per speaker turn; this module installs it, runs it on a
//! meeting's `system.wav`, and maps its turns onto the transcript's lines.
//!
//! Only the remote track is diarized. Everything on the microphone is the
//! person at this Mac, which is one speaker the model never has to find.

use crate::download::{fetch, Download};
use crate::paths;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use tokio::process::Command;

/// The runtime: a tarball of every sherpa-onnx tool, of which one binary and
/// three libraries are kept. The others would be forty megabytes of nothing.
const RUNTIME: Download = Download {
    file: "sherpa-onnx-v1.13.8-osx-arm64-shared-no-tts.tar.bz2",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-v1.13.8-osx-arm64-shared-no-tts.tar.bz2",
    bytes: 18_252_168,
    sha256: "91b96512c4fa1960f8a9ed5360a6c8dda53a4b5015d0590244f14086a234557a",
};

/// Finds where speech starts and stops, and when two people overlap.
const SEGMENTATION: Download = Download {
    file: "sherpa-onnx-pyannote-segmentation-3-0.tar.bz2",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2",
    bytes: 6_958_444,
    sha256: "24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488",
};

/// Turns a stretch of speech into a voice print, so turns can be clustered
/// by who is talking. NVIDIA's TitaNet-small, trained on English speakers.
/// On the AMI meetings it tags as many lines right as the larger ERes2Net
/// models (87% against 88%) in less than half the time, and unlike them it
/// does not merge two people into one. See `examples/diarize_eval.rs`.
const EMBEDDING: Download = Download {
    file: "nemo_en_titanet_small.onnx",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/nemo_en_titanet_small.onnx",
    bytes: 40_257_283,
    sha256: "ad4a1802485d8b34c722d2a9d04249662f2ece5d28a7a039063ca22f515a789e",
};

/// Where the voice-print model is kept. Named for the model, so an install
/// from before the switch (a Mandarin model, `embedding.onnx`) reads as not
/// installed and is offered again.
const EMBEDDING_FILE: &str = "voice-titanet-small.onnx";

const BINARY: &str = "sherpa-onnx-offline-speaker-diarization";
const LIBRARIES: [&str; 3] = [
    "libonnxruntime.dylib",
    "libsherpa-onnx-c-api.dylib",
    "libsherpa-onnx-cxx-api.dylib",
];

/// How far apart two voice prints have to be to count as two people.
///
/// Swept on AMI meetings with TitaNet-small: 1.0 found up to four times too
/// many people, 1.15 merged them; 1.1 found the right number or near it.
const CLUSTER_THRESHOLD: f32 = 1.1;

/// Where the tool and its models live.
pub fn runtime_dir() -> Option<PathBuf> {
    paths::runtimes_root().map(|root| root.join("sherpa"))
}

pub fn models_dir() -> Option<PathBuf> {
    paths::models_root().map(|root| root.join("diarization"))
}

fn binary_path() -> Option<PathBuf> {
    runtime_dir().map(|dir| dir.join("bin").join(BINARY))
}

/// Whether everything the diarizer needs is on this Mac.
pub fn is_installed() -> bool {
    let Some(binary) = binary_path() else {
        return false;
    };
    let Some(models) = models_dir() else {
        return false;
    };
    paths::is_executable(&binary)
        && models.join("segmentation.onnx").is_file()
        && models.join(EMBEDDING_FILE).is_file()
}

/// Bytes the install downloads, for the page that offers it.
pub const INSTALL_BYTES: u64 = RUNTIME.bytes + SEGMENTATION.bytes + EMBEDDING.bytes;

/// Downloads and lays out the diarizer. Safe to run again: files already in
/// place are kept, and a half-finished install is finished.
pub async fn install(
    cancel: &AtomicBool,
    on_progress: &(dyn Fn(&str, f32) + Send + Sync),
) -> Result<(), String> {
    let runtime = runtime_dir().ok_or("Could not work out where the diarizer lives.")?;
    let models = models_dir().ok_or("Could not work out where the diarizer's models live.")?;
    let staging = runtime.join("downloads");

    on_progress("Downloading the speaker tool…", 0.0);
    fetch(&RUNTIME, &staging, &|part| on_progress("Downloading the speaker tool…", part * 0.3), cancel).await?;
    on_progress("Downloading the segmentation model…", 0.3);
    fetch(&SEGMENTATION, &staging, &|part| on_progress("Downloading the segmentation model…", 0.3 + part * 0.1), cancel).await?;
    on_progress("Downloading the voice model…", 0.4);
    fetch(&EMBEDDING, &staging, &|part| on_progress("Downloading the voice model…", 0.4 + part * 0.5), cancel).await?;

    on_progress("Unpacking…", 0.9);
    unpack_runtime(&staging.join(RUNTIME.file), &runtime).await?;
    unpack_segmentation(&staging.join(SEGMENTATION.file), &models).await?;
    tokio::fs::create_dir_all(&models)
        .await
        .map_err(|error| format!("Could not make {}: {error}", models.display()))?;
    tokio::fs::copy(staging.join(EMBEDDING.file), models.join(EMBEDDING_FILE))
        .await
        .map_err(|error| format!("Could not put the voice model in place: {error}"))?;
    // The voice model this one replaced.
    let _ = tokio::fs::remove_file(models.join("embedding.onnx")).await;

    // The tarballs did their job; the embedding is copied, so the staging
    // copy of it is the only leftover worth the space.
    let _ = tokio::fs::remove_dir_all(&staging).await;

    if !is_installed() {
        return Err("The diarizer did not install completely.".into());
    }
    on_progress("Speaker tagging ready", 1.0);
    Ok(())
}

/// Removes the tool and models.
pub async fn remove() -> Result<(), String> {
    if let Some(dir) = runtime_dir() {
        let _ = tokio::fs::remove_dir_all(dir).await;
    }
    if let Some(dir) = models_dir() {
        let _ = tokio::fs::remove_dir_all(dir).await;
    }
    Ok(())
}

/// Pulls the one binary and its libraries out of the release tarball, keeping
/// `bin/` and `lib/` side by side: the binary finds its libraries through
/// `@loader_path/../lib`, so the layout is part of the contract.
async fn unpack_runtime(tarball: &Path, runtime: &Path) -> Result<(), String> {
    let scratch = runtime.join("unpack");
    let _ = tokio::fs::remove_dir_all(&scratch).await;
    tokio::fs::create_dir_all(&scratch)
        .await
        .map_err(|error| format!("Could not make {}: {error}", scratch.display()))?;
    // The archive has one top-level folder; strip it so paths are bin/… lib/….
    let wanted: Vec<String> = std::iter::once(format!("*/bin/{BINARY}"))
        .chain(LIBRARIES.iter().map(|lib| format!("*/lib/{lib}")))
        .collect();
    let mut command = Command::new("tar");
    command
        .arg("-xjf")
        .arg(tarball)
        .arg("-C")
        .arg(&scratch)
        .arg("--strip-components=1");
    for pattern in &wanted {
        command.arg(pattern);
    }
    let output = command
        .output()
        .await
        .map_err(|error| format!("Could not run tar: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "Could not unpack the speaker tool: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    for sub in ["bin", "lib"] {
        let target = runtime.join(sub);
        let _ = tokio::fs::remove_dir_all(&target).await;
        tokio::fs::rename(scratch.join(sub), &target)
            .await
            .map_err(|error| format!("Could not put the speaker tool's {sub} in place: {error}"))?;
    }
    let _ = tokio::fs::remove_dir_all(&scratch).await;
    Ok(())
}

async fn unpack_segmentation(tarball: &Path, models: &Path) -> Result<(), String> {
    tokio::fs::create_dir_all(models)
        .await
        .map_err(|error| format!("Could not make {}: {error}", models.display()))?;
    let output = Command::new("tar")
        .arg("-xjf")
        .arg(tarball)
        .arg("-C")
        .arg(models)
        .arg("--strip-components=1")
        .arg("*/model.onnx")
        .output()
        .await
        .map_err(|error| format!("Could not run tar: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "Could not unpack the segmentation model: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    tokio::fs::rename(models.join("model.onnx"), models.join("segmentation.onnx"))
        .await
        .map_err(|error| format!("Could not put the segmentation model in place: {error}"))
}

/// One stretch of one speaker, as the tool reports it.
#[derive(Clone, Debug, PartialEq)]
pub struct Turn {
    pub start_ms: u64,
    pub end_ms: u64,
    /// The tool's own label, `speaker_NN`. Not stable between runs.
    pub label: String,
}

/// What a run can be tuned with. The app always uses the default; the
/// evaluation harness sweeps these to pick that default.
#[derive(Clone, Debug)]
pub struct Config {
    pub cluster_threshold: f32,
    /// A voice-print model other than the installed one.
    pub embedding: Option<PathBuf>,
    /// Where the networks run: `cpu` or `coreml`.
    pub provider: &'static str,
}

impl Default for Config {
    fn default() -> Self {
        Config { cluster_threshold: CLUSTER_THRESHOLD, embedding: None, provider: "cpu" }
    }
}

/// Runs the tool on a 16 kHz WAV and returns its turns.
pub async fn run(wav: &Path, cancel: &AtomicBool) -> Result<Vec<Turn>, String> {
    run_with(wav, &Config::default(), cancel).await
}

pub async fn run_with(wav: &Path, config: &Config, cancel: &AtomicBool) -> Result<Vec<Turn>, String> {
    let binary = binary_path().filter(|path| paths::is_executable(path)).ok_or(
        "Speaker tagging is not installed. Download it from Models, then try again.",
    )?;
    let models = models_dir().ok_or("Could not work out where the diarizer's models live.")?;
    let embedding = config.embedding.clone().unwrap_or_else(|| models.join(EMBEDDING_FILE));
    let threads = std::thread::available_parallelism()
        .map(|n| n.get().saturating_sub(1).max(1))
        .unwrap_or(2);

    // At low priority: it runs flat out on every core but one for a minute
    // or two after a meeting, and whatever the user is doing comes first.
    // nice execs the tool, so killing this child kills the tool.
    let child = Command::new("/usr/bin/nice")
        .arg("-n")
        .arg("10")
        .arg(&binary)
        .arg(format!("--clustering.cluster-threshold={}", config.cluster_threshold))
        .arg(format!(
            "--segmentation.pyannote-model={}",
            models.join("segmentation.onnx").display()
        ))
        .arg(format!("--embedding.model={}", embedding.display()))
        // sherpa-onnx takes a thread count per network; a bare --num-threads
        // is rejected and the run stops before it starts.
        .arg(format!("--segmentation.num-threads={threads}"))
        .arg(format!("--embedding.num-threads={threads}"))
        .arg(format!("--segmentation.provider={}", config.provider))
        .arg(format!("--embedding.provider={}", config.provider))
        .arg(wav)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("Could not start the speaker tool: {error}"))?;

    let output = tokio::select! {
        output = child.wait_with_output() => output,
        _ = poll_cancel(cancel) => return Err(crate::download::CANCELLED.to_string()),
    }
    .map_err(|error| format!("The speaker tool failed: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "The speaker tool stopped: {}",
            stderr.lines().last().unwrap_or("no output").trim()
        ));
    }
    Ok(parse_turns(&String::from_utf8_lossy(&output.stdout)))
}

async fn poll_cancel(cancel: &AtomicBool) {
    while !cancel.load(std::sync::atomic::Ordering::Relaxed) {
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
}

/// Picks the turns out of the tool's chatter: `1.583 -- 3.406 speaker_00`.
pub fn parse_turns(output: &str) -> Vec<Turn> {
    output
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let start: f64 = parts.next()?.parse().ok()?;
            if parts.next()? != "--" {
                return None;
            }
            let end: f64 = parts.next()?.parse().ok()?;
            let label = parts.next()?;
            if !label.starts_with("speaker_") || parts.next().is_some() {
                return None;
            }
            Some(Turn {
                start_ms: (start * 1_000.0).round() as u64,
                end_ms: (end * 1_000.0).round() as u64,
                label: label.to_string(),
            })
        })
        .collect()
}

/// A transcript line's place in time, for `assign`.
pub struct Span {
    pub idx: i64,
    pub start_ms: u64,
    pub end_ms: u64,
}

/// Gives each line the speaker whose turns cover most of it.
///
/// A line with no overlapping turn takes the nearest turn within two
/// seconds; past that it is left untagged rather than guessed. Labels are
/// then renumbered in order of first appearance, so the first voice heard
/// is `speaker_00` whatever the tool called it, and a re-run that finds the
/// same people in the same order gives them the same labels.
pub fn assign(lines: &[Span], turns: &[Turn]) -> Vec<(i64, String)> {
    let raw: Vec<(i64, u64, &str)> = lines
        .iter()
        .filter_map(|line| speaker_of(line, turns).map(|label| (line.idx, line.start_ms, label)))
        .collect();
    let names = by_first_appearance(&raw);
    let mut out: Vec<(i64, String)> = raw.iter().map(|(idx, _, label)| (*idx, names[label].clone())).collect();
    out.sort_by_key(|(idx, _)| *idx);
    out
}

/// The tool's label for the speaker whose turns cover most of `line`, else
/// the nearest turn within two seconds, else none.
fn speaker_of<'a>(line: &Span, turns: &'a [Turn]) -> Option<&'a str> {
    let mut overlap_by_label: HashMap<&str, u64> = HashMap::new();
    for turn in turns {
        let overlap = turn.end_ms.min(line.end_ms).saturating_sub(turn.start_ms.max(line.start_ms));
        if overlap > 0 {
            *overlap_by_label.entry(turn.label.as_str()).or_insert(0) += overlap;
        }
    }
    // Ties go to the lower label, so the answer does not depend on hashing.
    if let Some((label, _)) = overlap_by_label.into_iter().max_by(|a, b| a.1.cmp(&b.1).then(b.0.cmp(a.0))) {
        return Some(label);
    }
    let middle = (line.start_ms + line.end_ms) / 2;
    turns
        .iter()
        .map(|turn| {
            // Zero inside the turn, else the gap to its nearer edge.
            let distance = turn.start_ms.saturating_sub(middle).max(middle.saturating_sub(turn.end_ms));
            (distance, turn)
        })
        .filter(|(distance, _)| *distance <= 2_000)
        .min_by_key(|(distance, _)| *distance)
        .map(|(_, turn)| turn.label.as_str())
}

/// `speaker_00`, `speaker_01`, … in the order each label is first heard.
/// `raw` is (line, start, tool label).
fn by_first_appearance<'a>(raw: &[(i64, u64, &'a str)]) -> HashMap<&'a str, String> {
    let mut ordered: Vec<&(i64, u64, &str)> = raw.iter().collect();
    ordered.sort_by_key(|(_, start, _)| *start);
    let mut names: HashMap<&str, String> = HashMap::new();
    for (_, _, label) in ordered {
        let next = names.len();
        names.entry(label).or_insert_with(|| format!("speaker_{next:02}"));
    }
    names
}

/// Which recording a stretch of joined audio came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    /// Clips of the user alone, from dictation: the voice to call `me`.
    Enrolment,
    Mic,
    System,
}

/// The diarizer's sample rate.
pub const RATE: u32 = 16_000;

/// Silence between joined recordings, so no turn runs across a seam.
const SEAM_MS: u64 = 2_000;

/// Several recordings laid end to end, so one diarizer run clusters every
/// voice in all of them together: someone heard on both tracks gets one
/// label, and the enrolment clips land in the same cluster as the user.
pub struct Joined {
    pub samples: Vec<f32>,
    /// Each recording's source, where it starts in `samples`, and its length.
    pieces: Vec<(Source, u64, u64)>,
}

pub fn join(parts: &[(Source, &[f32])]) -> Joined {
    let per_ms = RATE as u64 / 1_000;
    let mut samples = Vec::new();
    let mut pieces = Vec::new();
    for (source, audio) in parts {
        if audio.is_empty() {
            continue;
        }
        if !samples.is_empty() {
            samples.resize(samples.len() + (SEAM_MS * per_ms) as usize, 0.0);
        }
        let start = samples.len() as u64 / per_ms;
        samples.extend_from_slice(audio);
        pieces.push((*source, start, audio.len() as u64 / per_ms));
    }
    Joined { samples, pieces }
}

impl Joined {
    /// The tool's turns on the joined audio, back on each recording's own
    /// clock. A turn that strays into a seam is cut at the recording's edge.
    pub fn split(&self, turns: &[Turn]) -> Vec<(Source, Turn)> {
        let mut out = Vec::new();
        for turn in turns {
            for &(source, start, length) in &self.pieces {
                let from = turn.start_ms.max(start);
                let to = turn.end_ms.min(start + length);
                if to > from {
                    out.push((
                        source,
                        Turn { start_ms: from - start, end_ms: to - start, label: turn.label.clone() },
                    ));
                }
            }
        }
        out
    }
}

/// The label every line the user said carries, on either track.
pub const ME: &str = crate::meetings::LOCAL_SPEAKER;

/// What `tag_call` decided for one meeting.
#[derive(Debug, Default, PartialEq)]
pub struct CallTags {
    /// Each line's speaker: `me`, or `speaker_NN` for everyone else on
    /// either track, numbered in the order they are first heard.
    pub tags: Vec<(i64, String)>,
    /// Microphone lines that are the other side of the call coming out of
    /// the Mac's speakers and back in through the mic: said once already on
    /// the system track.
    pub echoes: Vec<i64>,
}

/// Tags both tracks' lines from one diarizer run over the joined audio.
///
/// The user is the cluster the enrolment clips fell into. Without clips, it
/// is whoever talks most on the microphone among the voices that are mostly
/// heard there. A microphone line whose voice belongs to the other side, said
/// while the other side was talking, is an echo, not a person in the room.
pub fn tag_call(mic: &[Span], system: &[Span], turns: &[(Source, Turn)]) -> CallTags {
    let mut heard: HashMap<&str, [u64; 3]> = HashMap::new();
    for (source, turn) in turns {
        heard.entry(turn.label.as_str()).or_default()[*source as usize] += turn.end_ms - turn.start_ms;
    }
    let me_label = heard
        .iter()
        .filter(|(_, ms)| ms[Source::Enrolment as usize] > 0)
        .max_by(|a, b| a.1[0].cmp(&b.1[0]).then(b.0.cmp(a.0)))
        .or_else(|| {
            heard
                .iter()
                .filter(|(_, ms)| ms[Source::Mic as usize] > ms[Source::System as usize])
                .max_by(|a, b| a.1[1].cmp(&b.1[1]).then(b.0.cmp(a.0)))
        })
        .map(|(label, _)| *label);
    let is_remote = |label: &str| heard.get(label).is_some_and(|ms| ms[2] > ms[1]);

    let on = |wanted: Source| -> Vec<Turn> {
        turns.iter().filter(|(source, _)| *source == wanted).map(|(_, turn)| turn.clone()).collect()
    };
    let (mic_turns, system_turns) = (on(Source::Mic), on(Source::System));
    let remote_talking = |line: &Span| -> u64 {
        system_turns
            .iter()
            .map(|turn| turn.end_ms.min(line.end_ms).saturating_sub(turn.start_ms.max(line.start_ms)))
            .sum()
    };

    let mut out = CallTags::default();
    let mut raw: Vec<(i64, u64, &str)> = Vec::new();
    for line in mic {
        let Some(label) = speaker_of(line, &mic_turns) else { continue };
        if Some(label) == me_label {
            out.tags.push((line.idx, ME.into()));
        } else if is_remote(label) && remote_talking(line) * 2 >= line.end_ms - line.start_ms {
            out.echoes.push(line.idx);
        } else {
            raw.push((line.idx, line.start_ms, label));
        }
    }
    for line in system {
        match speaker_of(line, &system_turns) {
            Some(label) if Some(label) == me_label => out.tags.push((line.idx, ME.into())),
            Some(label) => raw.push((line.idx, line.start_ms, label)),
            None => {}
        }
    }
    let names = by_first_appearance(&raw);
    out.tags.extend(raw.iter().map(|(idx, _, label)| (*idx, names[label].clone())));
    out.tags.sort_by_key(|(idx, _)| *idx);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_turns_and_ignores_the_chatter() {
        let output = "progress 50.00%\nStarted\n1.583 -- 3.406 speaker_02\n4.4 -- 6.46 speaker_00\nElapsed seconds: 2.2\n";
        let turns = parse_turns(output);
        assert_eq!(
            turns,
            vec![
                Turn { start_ms: 1_583, end_ms: 3_406, label: "speaker_02".into() },
                Turn { start_ms: 4_400, end_ms: 6_460, label: "speaker_00".into() },
            ]
        );
    }

    #[test]
    fn lines_take_the_speaker_that_covers_most_of_them() {
        let turns = vec![
            Turn { start_ms: 0, end_ms: 5_000, label: "speaker_01".into() },
            Turn { start_ms: 5_000, end_ms: 10_000, label: "speaker_00".into() },
        ];
        let lines = vec![
            Span { idx: 0, start_ms: 500, end_ms: 4_500 },
            Span { idx: 1, start_ms: 4_000, end_ms: 9_000 }, // 1 s with 01, 4 s with 00
        ];
        let tags = assign(&lines, &turns);
        // The first voice heard becomes speaker_00, whatever the tool said.
        assert_eq!(tags, vec![(0, "speaker_00".into()), (1, "speaker_01".into())]);
    }

    #[test]
    fn a_line_near_a_turn_takes_it_and_a_far_one_is_left() {
        let turns = vec![Turn { start_ms: 10_000, end_ms: 12_000, label: "speaker_00".into() }];
        let lines = vec![
            Span { idx: 0, start_ms: 12_500, end_ms: 13_000 }, // 500 ms after
            Span { idx: 1, start_ms: 20_000, end_ms: 21_000 }, // far away
        ];
        assert_eq!(assign(&lines, &turns), vec![(0, "speaker_00".into())]);
    }

    #[test]
    fn no_turns_means_no_tags() {
        assert!(assign(&[Span { idx: 0, start_ms: 0, end_ms: 1 }], &[]).is_empty());
    }

    #[test]
    fn the_install_size_is_the_sum_of_its_parts() {
        assert_eq!(INSTALL_BYTES, 18_252_168 + 6_958_444 + 40_257_283);
    }

    fn turn(start: u64, end: u64, label: &str) -> Turn {
        Turn { start_ms: start, end_ms: end, label: label.into() }
    }

    fn span(idx: i64, start: u64, end: u64) -> Span {
        Span { idx, start_ms: start, end_ms: end }
    }

    #[test]
    fn joined_turns_come_back_on_each_tracks_clock() {
        let one_second = vec![0.0; RATE as usize];
        let joined = join(&[(Source::Enrolment, &one_second), (Source::Mic, &one_second)]);
        // 1 s, a 2 s seam, 1 s.
        assert_eq!(joined.samples.len(), 4 * RATE as usize);
        let split = joined.split(&[turn(500, 3_500, "a")]);
        assert_eq!(split, vec![(Source::Enrolment, turn(500, 1_000, "a")), (Source::Mic, turn(0, 500, "a"))]);
    }

    #[test]
    fn the_enrolled_voice_is_me_and_everyone_else_is_numbered_across_tracks() {
        let turns = vec![
            (Source::Enrolment, turn(0, 30_000, "s3")),
            (Source::Mic, turn(0, 5_000, "s3")),
            (Source::Mic, turn(5_000, 10_000, "s1")), // someone in the room
            (Source::System, turn(2_000, 8_000, "s0")), // someone on the call
        ];
        let tags = tag_call(&[span(0, 0, 4_000), span(1, 6_000, 9_000)], &[span(2, 2_000, 8_000)], &turns);
        assert_eq!(
            tags.tags,
            vec![(0, ME.into()), (1, "speaker_01".into()), (2, "speaker_00".into())]
        );
        assert!(tags.echoes.is_empty());
    }

    #[test]
    fn without_enrolment_me_is_who_talks_most_on_the_mic() {
        let turns = vec![
            (Source::Mic, turn(0, 9_000, "s1")),
            (Source::Mic, turn(9_000, 10_000, "s2")),
            (Source::System, turn(0, 20_000, "s0")),
        ];
        let tags = tag_call(&[span(0, 0, 9_000)], &[], &turns);
        assert_eq!(tags.tags, vec![(0, ME.into())]);
    }

    #[test]
    fn a_remote_voice_on_the_mic_while_they_talk_is_an_echo() {
        let turns = vec![
            (Source::Enrolment, turn(0, 30_000, "me")),
            (Source::System, turn(0, 10_000, "far")),
            (Source::Mic, turn(0, 4_000, "far")),
            (Source::Mic, turn(20_000, 22_000, "far")), // same voice, nobody on the call talking
        ];
        let tags = tag_call(&[span(0, 0, 4_000), span(1, 20_000, 22_000)], &[span(2, 0, 10_000)], &turns);
        assert_eq!(tags.echoes, vec![0]);
        assert_eq!(tags.tags, vec![(1, "speaker_00".into()), (2, "speaker_00".into())]);
    }
}
