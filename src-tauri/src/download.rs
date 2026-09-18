//! Fetching a weight file, checked before it is put in place.
//!
//! Two catalogues need this now -- the speech models and the local polish
//! models -- and they disagree about everything except the act itself: a URL,
//! a length, a hash, and a file that must not appear until all three agree. So
//! that act lives here, and each catalogue keeps its own opinions about where
//! the file belongs and who is told how far it has got.

use sha2::{Digest, Sha256};
use std::path::Path;
use tokio::io::AsyncWriteExt;
use tokio::time::{Duration, Instant};

/// How often a download reports itself. An event per chunk would be tens of
/// thousands of messages across the IPC bridge for one file.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);

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
pub async fn fetch(
    spec: &Download,
    dir: &Path,
    on_progress: &(dyn Fn(f32) + Send + Sync),
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
    let outcome = stream(spec, &partial, on_progress).await;
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
    partial: &Path,
    on_progress: &(dyn Fn(f32) + Send + Sync),
) -> Result<(), String> {
    on_progress(0.0);

    let mut response = reqwest::Client::new()
        .get(spec.url)
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
        fetch(&SMALL, &dir, &|_| {})
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
        let error = fetch(&WRONG, &dir, &|_| {})
            .await
            .expect_err("a wrong checksum should fail");
        assert!(error.contains("checksum"), "{error}");
        assert!(!dir.join("README.md").exists());
        assert!(!dir.join("README.md.partial").exists());

        std::fs::remove_dir_all(&dir).ok();
    }
}
