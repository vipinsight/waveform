//! Fetching a weight file, checked before it is put in place.
//!
//! Two catalogues need this now -- the speech models and the local polish
//! models -- and they disagree about everything except the act itself: a URL,
//! a length, a hash, and a file that must not appear until all three agree. So
//! that act lives here, and each catalogue keeps its own opinions about where
//! the file belongs and who is told how far it has got.

use sha2::{Digest, Sha256};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::io::AsyncWriteExt;
use tokio::time::{Duration, Instant};

/// What `fetch` returns when the flag it was given is raised mid-stream.
///
/// Distinct from a network error so the interface can put the row back as a
/// download rather than paint a failure nobody asked to see.
pub const CANCELLED: &str = "Download cancelled.";

/// How often a download reports itself. An event per chunk would be tens of
/// thousands of messages across the IPC bridge for one file.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);

/// Where the weights come from by default.
const HUGGING_FACE: &str = "https://huggingface.co";

/// A pass-through for the Hugging Face repos the app installs from, for
/// networks that block huggingface.co. It stores nothing and serves the same
/// bytes, and the checksum is checked either way, so it can only help a
/// download that would otherwise fail. The Worker lives in `model-proxy/`.
pub const HUGGING_FACE_MIRROR: &str = "https://models.webtiara.com";

/// The same file through [`HUGGING_FACE_MIRROR`], when `url` is on Hugging Face.
pub fn mirror_url(url: &str) -> Option<String> {
    let path = url.strip_prefix(HUGGING_FACE)?;
    path.starts_with('/').then(|| format!("{HUGGING_FACE_MIRROR}{path}"))
}

/// A weight file the app can fetch without a terminal.
///
/// The length and the hash are checked before the file is moved into place: it
/// is loaded and executed as model weights, and a truncated download that read
/// as installed would fail much later and much less clearly.
pub struct Download {
    pub file: &'static str,
    pub url: &'static str,
    pub bytes: u64,
    pub sha256: &'static str,
}

/// Puts `spec` in `dir`, reporting progress from 0.0 to 1.0 as it goes.
///
/// A file already there is left alone: the hash was checked when it arrived,
/// and fetching it again would cost a gigabyte to learn the same thing.
///
/// A file on Hugging Face that cannot be had from there is tried once more
/// through [`HUGGING_FACE_MIRROR`].
///
/// `cancel` is polled between chunks. Raising it leaves no partial file behind,
/// and returns [`CANCELLED`] rather than a network error.
pub async fn fetch(
    spec: &Download,
    dir: &Path,
    on_progress: &(dyn Fn(f32) + Send + Sync),
    cancel: &AtomicBool,
) -> Result<(), String> {
    let mirror = mirror_url(spec.url);
    fetch_from(spec, spec.url, mirror.as_deref(), dir, on_progress, cancel).await
}

async fn fetch_from(
    spec: &Download,
    url: &str,
    fallback: Option<&str>,
    dir: &Path,
    on_progress: &(dyn Fn(f32) + Send + Sync),
    cancel: &AtomicBool,
) -> Result<(), String> {
    let path = dir.join(spec.file);
    if path.is_file() {
        return Ok(());
    }
    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|error| format!("Could not make {}: {error}", dir.display()))?;

    // Written beside the target and moved into place at the end, so an
    // interrupted download cannot leave a truncated file that looks
    // installed. A rename within one directory is atomic.
    let partial = dir.join(format!("{}.partial", spec.file));
    let mut outcome = stream(spec, url, &partial, on_progress, cancel).await;
    if let (Err(error), Some(fallback)) = (&outcome, fallback) {
        if error != CANCELLED {
            eprintln!("{} failed from {url} ({error}); trying {fallback}", spec.file);
            outcome = stream(spec, fallback, &partial, on_progress, cancel)
                .await
                .map_err(|second| {
                    if second == CANCELLED {
                        second
                    } else {
                        format!("{error} The mirror failed too: {second}")
                    }
                });
        }
    }
    if outcome.is_err() {
        let _ = tokio::fs::remove_file(&partial).await;
        return outcome;
    }

    tokio::fs::rename(&partial, &path)
        .await
        .map_err(|error| format!("Could not put {} in place: {error}", spec.file))
}

async fn stream(
    spec: &Download,
    url: &str,
    partial: &Path,
    on_progress: &(dyn Fn(f32) + Send + Sync),
    cancel: &AtomicBool,
) -> Result<(), String> {
    on_progress(0.0);

    let mut response = reqwest::Client::new()
        .get(url)
        .send()
        .await
        .map_err(|error| format!("Could not reach the download: {error}"))?
        .error_for_status()
        .map_err(|error| format!("The download was refused: {error}"))?;

    // Its own answer where it gives one, since a redirect or a mirror can
    // serve a different length than the one recorded here.
    let total = response.content_length().unwrap_or(spec.bytes).max(1);
    let mut file = tokio::fs::File::create(partial)
        .await
        .map_err(|error| format!("Could not write {}: {error}", partial.display()))?;
    let mut hasher = Sha256::new();
    let mut written: u64 = 0;
    let mut reported = Instant::now();

    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("The download stopped: {error}"))?
    {
        if cancel.load(Ordering::Relaxed) {
            return Err(CANCELLED.into());
        }
        hasher.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|error| format!("Could not write {}: {error}", partial.display()))?;
        written += chunk.len() as u64;

        if reported.elapsed() >= PROGRESS_INTERVAL {
            reported = Instant::now();
            on_progress((written as f32 / total as f32).min(1.0));
        }
    }

    file.flush()
        .await
        .map_err(|error| format!("Could not finish {}: {error}", partial.display()))?;
    drop(file);

    if written != spec.bytes {
        return Err(format!(
            "{} should be {} bytes and arrived as {written}.",
            spec.file, spec.bytes
        ));
    }
    let checksum: String = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    if checksum != spec.sha256 {
        return Err(format!(
            "{} did not match its checksum and has been discarded.",
            spec.file
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mirrors_only_hugging_face_urls() {
        assert_eq!(
            mirror_url("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin").as_deref(),
            Some("https://models.webtiara.com/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin")
        );
        assert_eq!(mirror_url("https://huggingface.com/evil/file"), None);
        assert_eq!(mirror_url("https://huggingface.co.evil.com/file"), None);
        assert_eq!(mirror_url("https://github.com/k2-fsa/sherpa-onnx/releases/x"), None);
    }

    /// A source that cannot be reached falls through to the mirror, and what
    /// arrives from there is held to the same length and checksum. Needs the
    /// network, like the test below. `WAVEFORM_MIRROR` points it at another
    /// copy of the Worker, such as `wrangler dev` in `model-proxy/`. Run with:
    /// `cargo test falls_back -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn falls_back_to_the_mirror_when_the_source_is_unreachable() {
        const SMALL: Download = Download {
            file: "README.md",
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/README.md",
            bytes: 3196,
            sha256: "21fd967098804f33fc84e803fb0e5ab7666d71801f4027cf28a65e7af09c1758",
        };
        const PATH: &str = "/ggerganov/whisper.cpp/resolve/main/README.md";
        // Nothing listens on the discard port, the way a blocked host refuses.
        let unreachable = format!("http://127.0.0.1:9{PATH}");
        let mirror = match std::env::var("WAVEFORM_MIRROR") {
            Ok(base) => format!("{}{PATH}", base.trim_end_matches('/')),
            Err(_) => mirror_url(SMALL.url).expect("Hugging Face has a mirror"),
        };

        let dir = std::env::temp_dir().join(format!("waveform-mirror-{}", std::process::id()));
        let cancel = AtomicBool::new(false);
        fetch_from(&SMALL, &unreachable, Some(&mirror), &dir, &|_| {}, &cancel)
            .await
            .expect("the mirror should serve the file");
        assert!(dir.join("README.md").is_file());
        assert!(!dir.join("README.md.partial").exists());

        // Both failing says so, and leaves nothing behind.
        std::fs::remove_file(dir.join("README.md")).expect("clear the file");
        let error = fetch_from(&SMALL, &unreachable, Some(&unreachable), &dir, &|_| {}, &cancel)
            .await
            .expect_err("nothing to fall back to");
        assert!(error.contains("The mirror failed too"), "{error}");
        assert!(!dir.join("README.md").exists());
        assert!(!dir.join("README.md.partial").exists());

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Exercises the download for real: stream, hash, and the move into place.
    ///
    /// Ignored by default because it needs the network. The file is a small one
    /// from the same host as the weights, so what is being tested is the code
    /// rather than anybody's bandwidth. Run with:
    /// `cargo test fetches -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn fetches_verifies_and_moves_a_file_into_place() {
        const SMALL: Download = Download {
            file: "README.md",
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/README.md",
            bytes: 3196,
            sha256: "21fd967098804f33fc84e803fb0e5ab7666d71801f4027cf28a65e7af09c1758",
        };

        let dir = std::env::temp_dir().join(format!("waveform-fetch-{}", std::process::id()));
        let cancel = AtomicBool::new(false);
        fetch(&SMALL, &dir, &|_| {}, &cancel)
            .await
            .expect("the download should succeed");
        assert!(dir.join("README.md").is_file());
        // Nothing left behind: the partial file is renamed, not copied.
        assert!(!dir.join("README.md.partial").exists());

        // A wrong checksum must leave nothing at all, or the next launch would
        // load whatever arrived.
        std::fs::remove_file(dir.join("README.md")).expect("clear the file");
        const WRONG: Download = Download {
            sha256: "0000000000000000000000000000000000000000000000000000000000000000",
            ..SMALL
        };
        let error = fetch(&WRONG, &dir, &|_| {}, &cancel)
            .await
            .expect_err("a wrong checksum should fail");
        assert!(error.contains("checksum"), "{error}");
        assert!(!dir.join("README.md").exists());
        assert!(!dir.join("README.md.partial").exists());

        std::fs::remove_dir_all(&dir).ok();
    }
}
