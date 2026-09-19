//! Where Waveform keeps speech weights and engine runtimes.
//!
//! One tree under Application Support, so Download / Remove / backup all point
//! at the same place. Older installs scattered Whisper beside `whisper.cpp/`,
//! Parakeet in NeMo's platform cache, and Qwen in the user Hugging Face hub —
//! lookups still honour those paths so an upgrade does not ask anyone to
//! download again.

use std::path::{Path, PathBuf};

/// `~/Library/Application Support/Waveform`.
pub fn waveform_home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| {
        Path::new(&home).join("Library/Application Support/Waveform")
    })
}

pub fn models_root() -> Option<PathBuf> {
    waveform_home().map(|home| home.join("models"))
}

pub fn runtimes_root() -> Option<PathBuf> {
    waveform_home().map(|home| home.join("runtimes"))
}

/// Whisper GGML directory used for new downloads.
pub fn whisper_dir() -> Option<PathBuf> {
    std::env::var_os("WAVEFORM_WHISPER_CPP_DIR")
        .map(PathBuf::from)
        .or_else(|| models_root().map(|root| root.join("whisper")))
}

fn whisper_dir_legacy() -> Option<PathBuf> {
    waveform_home().map(|home| home.join("whisper.cpp"))
}

/// Path of one Whisper weight file: new location, else legacy, else the new
/// path for a forthcoming download.
pub fn whisper_file(file: &str) -> Option<PathBuf> {
    let primary = whisper_dir()?.join(file);
    if primary.is_file() {
        return Some(primary);
    }
    if let Some(legacy) = whisper_dir_legacy().map(|dir| dir.join(file)) {
        if legacy.is_file() {
            return Some(legacy);
        }
    }
    Some(primary)
}

/// NeMo model cache root (parent of `nvidia/parakeet-…`).
pub fn parakeet_models_root() -> Option<PathBuf> {
    std::env::var_os("NEMO_SPEECH_MODEL_DIR")
        .map(PathBuf::from)
        .or_else(|| models_root().map(|root| root.join("parakeet")))
}

fn parakeet_models_root_legacy() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(|home| Path::new(&home).join("Library/Caches/NeMoSpeech/models"))
}

/// Per-model folder under the NeMo cache.
pub fn parakeet_model_dir(remote_id: &str) -> Option<PathBuf> {
    let primary = parakeet_models_root()?.join(remote_id);
    if dir_has_contents(&primary) {
        return Some(primary);
    }
    if let Some(legacy) = parakeet_models_root_legacy().map(|root| root.join(remote_id)) {
        if dir_has_contents(&legacy) {
            return Some(legacy);
        }
    }
    Some(primary)
}

/// Hugging Face home for Qwen (`HF_HOME`); hub files live under `hub/`.
pub fn qwen_hf_home() -> Option<PathBuf> {
    std::env::var_os("HF_HOME")
        .map(PathBuf::from)
        .or_else(|| models_root().map(|root| root.join("qwen")))
}

fn qwen_hf_home_legacy() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| Path::new(&home).join(".cache/huggingface"))
}

fn hf_hub_folder(remote_id: &str) -> String {
    format!("models--{}", remote_id.replace('/', "--"))
}

/// HF hub folder for one remote id.
pub fn qwen_model_dir(remote_id: &str) -> Option<PathBuf> {
    let folder = hf_hub_folder(remote_id);
    let primary = qwen_hf_home()?.join("hub").join(&folder);
    if dir_has_contents(&primary.join("snapshots")) {
        return Some(primary);
    }
    if let Some(legacy) = qwen_hf_home_legacy().map(|home| home.join("hub").join(&folder)) {
        if dir_has_contents(&legacy.join("snapshots")) {
            return Some(legacy);
        }
    }
    Some(primary)
}

/// Qwen Python venv (new location).
pub fn qwen_venv() -> Option<PathBuf> {
    runtimes_root().map(|root| root.join("qwen"))
}

fn qwen_venv_legacy() -> Option<PathBuf> {
    waveform_home().map(|home| home.join("qwen"))
}

/// Interpreter inside the Qwen venv, new then legacy.
pub fn qwen_python() -> Option<PathBuf> {
    for dir in [qwen_venv(), qwen_venv_legacy()].into_iter().flatten() {
        let python = dir.join("bin/python3");
        if is_executable(&python) {
            return Some(python);
        }
    }
    None
}

/// Preferred install location for the nemo-speech binary.
pub fn nemo_bin_preferred() -> Option<PathBuf> {
    runtimes_root().map(|root| root.join("bin/nemo-speech"))
}

/// Resolve an installed nemo-speech binary.
pub fn find_nemo_speech() -> Option<PathBuf> {
    if let Ok(configured) = std::env::var("NEMO_SPEECH_BIN") {
        let path = PathBuf::from(configured);
        if is_executable(&path) {
            return Some(path);
        }
    }
    if let Some(preferred) = nemo_bin_preferred() {
        if is_executable(&preferred) {
            return Some(preferred);
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        let legacy = Path::new(&home).join(".local/bin/nemo-speech");
        if is_executable(&legacy) {
            return Some(legacy);
        }
    }
    if let Ok(path) = std::env::var("PATH") {
        for dir in path.split(':') {
            let candidate = Path::new(dir).join("nemo-speech");
            if is_executable(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

pub fn dir_has_contents(path: &Path) -> bool {
    std::fs::read_dir(path)
        .map(|mut entries| entries.next().is_some())
        .unwrap_or(false)
}

pub fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The default Whisper folder under Application Support — not `whisper_dir()`,
    /// which honours `WAVEFORM_WHISPER_CPP_DIR` and can see another test's
    /// temporary override when cargo runs tests in parallel.
    #[test]
    fn whisper_defaults_under_models() {
        let dir = models_root().expect("home").join("whisper");
        assert!(
            dir.ends_with(Path::new("models").join("whisper")),
            "{}",
            dir.display()
        );
    }

    #[test]
    fn hf_folder_names_match_hub_layout() {
        assert_eq!(
            hf_hub_folder("Qwen/Qwen3-ASR-0.6B"),
            "models--Qwen--Qwen3-ASR-0.6B"
        );
    }
}
