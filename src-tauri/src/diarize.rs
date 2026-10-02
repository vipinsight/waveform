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
/// by who is talking. Trained on Chinese, but a voice print is a voice
/// print; sherpa-onnx's own diarization recipe uses this file for every
/// language.
const EMBEDDING: Download = Download {
    file: "3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx",
    bytes: 39_593_761,
    sha256: "1a331345f04805badbb495c775a6ddffcdd1a732567d5ec8b3d5749e3c7a5e4b",
};

const BINARY: &str = "sherpa-onnx-offline-speaker-diarization";
const LIBRARIES: [&str; 3] = [
    "libonnxruntime.dylib",
    "libsherpa-onnx-c-api.dylib",
    "libsherpa-onnx-cxx-api.dylib",
];

/// How far apart two voice prints have to be to count as two people.
///
/// 0.5 is the tool's default and split one person in two on the sample call;
/// 0.9 merged two people into one. 0.7 separated the pair cleanly.
const CLUSTER_THRESHOLD: f32 = 0.7;

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
        && models.join("embedding.onnx").is_file()
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
    tokio::fs::copy(staging.join(EMBEDDING.file), models.join("embedding.onnx"))
        .await
        .map_err(|error| format!("Could not put the voice model in place: {error}"))?;

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

/// Runs the tool on a WAV and returns its turns.
pub async fn run(wav: &Path, cancel: &AtomicBool) -> Result<Vec<Turn>, String> {
    let binary = binary_path().filter(|path| paths::is_executable(path)).ok_or(
        "Speaker tagging is not installed. Download it from Models, then try again.",
    )?;
    let models = models_dir().ok_or("Could not work out where the diarizer's models live.")?;
    let threads = std::thread::available_parallelism()
        .map(|n| n.get().saturating_sub(1).max(1))
        .unwrap_or(2);

    let child = Command::new(&binary)
        .arg(format!("--clustering.cluster-threshold={CLUSTER_THRESHOLD}"))
        .arg(format!(
            "--segmentation.pyannote-model={}",
            models.join("segmentation.onnx").display()
        ))
        .arg(format!("--embedding.model={}", models.join("embedding.onnx").display()))
        // sherpa-onnx takes a thread count per network; a bare --num-threads
        // is rejected and the run stops before it starts.
        .arg(format!("--segmentation.num-threads={threads}"))
        .arg(format!("--embedding.num-threads={threads}"))
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
    if turns.is_empty() {
        return Vec::new();
    }
    let mut raw: Vec<(i64, u64, &str)> = Vec::new();
    for line in lines {
        let mut best: Option<(&str, u64)> = None;
        let mut overlap_by_label: std::collections::HashMap<&str, u64> = Default::default();
        for turn in turns {
            let overlap = turn.end_ms.min(line.end_ms).saturating_sub(turn.start_ms.max(line.start_ms));
            if overlap > 0 {
                *overlap_by_label.entry(turn.label.as_str()).or_insert(0) += overlap;
            }
        }
        for (label, overlap) in overlap_by_label {
            if best.map_or(true, |(_, most)| overlap > most) {
                best = Some((label, overlap));
            }
        }
        let label = match best {
            Some((label, _)) => Some(label),
            None => {
                let middle = (line.start_ms + line.end_ms) / 2;
                turns
                    .iter()
                    .map(|turn| {
                        // Zero inside the turn, else the gap to its nearer edge.
                        let distance = turn
                            .start_ms
                            .saturating_sub(middle)
                            .max(middle.saturating_sub(turn.end_ms));
                        (distance, turn)
                    })
                    .filter(|(distance, _)| *distance <= 2_000)
                    .min_by_key(|(distance, _)| *distance)
                    .map(|(_, turn)| turn.label.as_str())
            }
        };
        if let Some(label) = label {
            raw.push((line.idx, line.start_ms, label));
        }
    }

    // Renumber by first appearance in time.
    raw.sort_by_key(|(_, start, _)| *start);
    let mut renamed: std::collections::HashMap<&str, String> = Default::default();
    let mut next = 0;
    let mut out: Vec<(i64, String)> = raw
        .iter()
        .map(|(idx, _, label)| {
            let name = renamed
                .entry(label)
                .or_insert_with(|| {
                    let name = format!("speaker_{next:02}");
                    next += 1;
                    name
                })
                .clone();
            (*idx, name)
        })
        .collect();
    out.sort_by_key(|(idx, _)| *idx);
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
        assert_eq!(INSTALL_BYTES, 18_252_168 + 6_958_444 + 39_593_761);
    }
}
