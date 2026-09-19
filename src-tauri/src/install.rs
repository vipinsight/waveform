//! In-app install for engines that need more than one weight file.
//!
//! Whisper is a single checked download. Parakeet needs NVIDIA's `nemo-speech`
//! binary plus a model pull; Qwen needs a Python venv, torch, and a Hugging
//! Face snapshot. Both used to live behind `pnpm setup:*` — which a disk-image
//! install cannot run — so the Models page Download button drives the same
//! steps from here.

use crate::download::CANCELLED;
use crate::paths;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::process::Command;

const NEMO_SPEECH_VERSION: &str = "0.1.0";
const NEMO_INSTALL_URL: &str = "https://raw.githubusercontent.com/NVIDIA/NeMo-Speech.cpp/v0.1.0/scripts/install.sh";

/// Approximate install size shown on the Models page (runtime + weights).
pub const PARAKEET_INSTALL_BYTES: u64 = 2_500_000_000;
/// Venv + torch + Qwen3-ASR 0.6B — a ballpark for the Download label.
pub const QWEN_INSTALL_BYTES: u64 = 3_800_000_000;

type Progress<'a> = &'a (dyn Fn(&str, f32) + Send + Sync);

/// Creates the Qwen venv, installs packages, and downloads weights into
/// Application Support.
pub async fn install_qwen(
    remote_id: &str,
    cancel: &AtomicBool,
    on_progress: Progress<'_>,
) -> Result<(), String> {
    check_cancel(cancel)?;
    let python_system = find_system_python()?;
    let venv = paths::qwen_venv().ok_or("Could not work out where Qwen's runtime lives.")?;
    let hf_home = paths::qwen_hf_home().ok_or("Could not work out where Qwen's weights live.")?;
    let venv_python = venv.join("bin/python3");

    if !paths::is_executable(&venv_python) {
        on_progress("Creating Qwen environment…", 0.05);
        tokio::fs::create_dir_all(venv.parent().unwrap_or(Path::new(".")))
            .await
            .map_err(|error| format!("Could not make {}: {error}", venv.display()))?;
        run_checked(
            Command::new(&python_system)
                .args(["-m", "venv"])
                .arg(&venv),
            cancel,
            "Could not create the Qwen environment",
        )
        .await?;
    }

    check_cancel(cancel)?;
    on_progress("Updating pip…", 0.12);
    run_checked(
        Command::new(&venv_python).args(["-m", "pip", "install", "--upgrade", "pip"]),
        cancel,
        "Could not update pip",
    )
    .await?;

    check_cancel(cancel)?;
    on_progress("Installing PyTorch and Qwen…", 0.2);
    run_checked(
        Command::new(&venv_python).args([
            "-m",
            "pip",
            "install",
            "torch>=2.6",
            "qwen-asr==0.0.6",
        ]),
        cancel,
        "Could not install Qwen's packages",
    )
    .await?;

    check_cancel(cancel)?;
    on_progress("Downloading Qwen weights…", 0.55);
    tokio::fs::create_dir_all(&hf_home)
        .await
        .map_err(|error| format!("Could not make {}: {error}", hf_home.display()))?;
    let script = format!(
        "from huggingface_hub import snapshot_download; snapshot_download({:?})",
        remote_id
    );
    run_checked(
        Command::new(&venv_python)
            .args(["-c", &script])
            .env("HF_HOME", &hf_home),
        cancel,
        "Could not download Qwen's weights",
    )
    .await?;

    on_progress("Qwen ready", 1.0);
    Ok(())
}

/// Installs nemo-speech (if needed) and pulls Parakeet into Application Support.
pub async fn install_parakeet(
    remote_id: &str,
    cancel: &AtomicBool,
    on_progress: Progress<'_>,
) -> Result<(), String> {
    check_cancel(cancel)?;
    let models = paths::parakeet_models_root()
        .ok_or("Could not work out where Parakeet's weights live.")?;
    let bin_dir = paths::runtimes_root()
        .map(|root| root.join("bin"))
        .ok_or("Could not work out where Parakeet's runtime lives.")?;

    let binary = match paths::find_nemo_speech() {
        Some(path) => path,
        None => {
            on_progress("Installing nemo-speech…", 0.1);
            install_nemo_speech(&bin_dir, cancel).await?
        }
    };

    check_cancel(cancel)?;
    on_progress("Downloading Parakeet weights…", 0.4);
    tokio::fs::create_dir_all(&models)
        .await
        .map_err(|error| format!("Could not make {}: {error}", models.display()))?;
    run_checked(
        Command::new(&binary)
            .args(["pull", remote_id])
            .env("NEMO_SPEECH_MODEL_DIR", &models),
        cancel,
        "Could not download Parakeet's weights",
    )
    .await?;

    on_progress("Parakeet ready", 1.0);
    Ok(())
}

async fn install_nemo_speech(bin_dir: &Path, cancel: &AtomicBool) -> Result<PathBuf, String> {
    tokio::fs::create_dir_all(bin_dir)
        .await
        .map_err(|error| format!("Could not make {}: {error}", bin_dir.display()))?;

    let installer = std::env::temp_dir().join(format!(
        "nemo-speech-install-{}.sh",
        std::process::id()
    ));
    let response = reqwest::Client::new()
        .get(NEMO_INSTALL_URL)
        .send()
        .await
        .map_err(|error| format!("Could not reach the nemo-speech installer: {error}"))?
        .error_for_status()
        .map_err(|error| format!("The nemo-speech installer was refused: {error}"))?
        .bytes()
        .await
        .map_err(|error| format!("Could not download the nemo-speech installer: {error}"))?;
    check_cancel(cancel)?;
    tokio::fs::write(&installer, &response)
        .await
        .map_err(|error| format!("Could not write the installer: {error}"))?;

    // Prefer installing into our runtimes/bin. The upstream script defaults to
    // ~/.local/bin; --prefix is accepted by recent installers, and we fall
    // back to copying from the legacy location if the binary lands there.
    let prefix = bin_dir
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| bin_dir.to_path_buf());
    let outcome = run_checked(
        Command::new("sh").args([
            installer.to_str().unwrap_or(""),
            "--version",
            NEMO_SPEECH_VERSION,
            "--backend",
            "metal",
            "--no-modify-path",
            "--prefix",
            prefix.to_str().unwrap_or(""),
        ]),
        cancel,
        "Could not install nemo-speech",
    )
    .await;
    let _ = tokio::fs::remove_file(&installer).await;
    outcome?;

    let preferred = bin_dir.join("nemo-speech");
    if paths::is_executable(&preferred) {
        return Ok(preferred);
    }
    // Installer may have ignored --prefix; take the legacy path and copy it.
    if let Some(home) = std::env::var_os("HOME") {
        let legacy = Path::new(&home).join(".local/bin/nemo-speech");
        if paths::is_executable(&legacy) {
            tokio::fs::copy(&legacy, &preferred)
                .await
                .map_err(|error| format!("Could not copy nemo-speech into place: {error}"))?;
            // Preserve execute bit.
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mut perms = tokio::fs::metadata(&preferred)
                    .await
                    .map_err(|error| format!("Could not read nemo-speech permissions: {error}"))?
                    .permissions();
                perms.set_mode(0o755);
                tokio::fs::set_permissions(&preferred, perms)
                    .await
                    .map_err(|error| format!("Could not make nemo-speech executable: {error}"))?;
            }
            return Ok(preferred);
        }
    }
    paths::find_nemo_speech().ok_or_else(|| "nemo-speech installed but could not be found.".into())
}

fn find_system_python() -> Result<PathBuf, String> {
    for name in ["python3", "python"] {
        if let Ok(output) = std::process::Command::new("/usr/bin/which")
            .arg(name)
            .output()
        {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !path.is_empty() {
                    let candidate = PathBuf::from(&path);
                    if paths::is_executable(&candidate) {
                        return Ok(candidate);
                    }
                }
            }
        }
    }
    Err(
        "Python 3 is required to install Qwen. Install it from python.org, then try again."
            .into(),
    )
}

fn check_cancel(cancel: &AtomicBool) -> Result<(), String> {
    if cancel.load(Ordering::Relaxed) {
        Err(CANCELLED.into())
    } else {
        Ok(())
    }
}

/// Runs a command to completion, aborting if `cancel` is raised.
async fn run_checked(
    command: &mut Command,
    cancel: &AtomicBool,
    context: &str,
) -> Result<(), String> {
    check_cancel(cancel)?;
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("{context}: {error}"))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_task = tokio::spawn(async move {
        match stdout {
            Some(mut pipe) => {
                let mut buffer = Vec::new();
                let _ = tokio::io::AsyncReadExt::read_to_end(&mut pipe, &mut buffer).await;
                buffer
            }
            None => Vec::new(),
        }
    });
    let stderr_task = tokio::spawn(async move {
        match stderr {
            Some(mut pipe) => {
                let mut buffer = Vec::new();
                let _ = tokio::io::AsyncReadExt::read_to_end(&mut pipe, &mut buffer).await;
                buffer
            }
            None => Vec::new(),
        }
    });

    let status = loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err(CANCELLED.into());
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => tokio::time::sleep(std::time::Duration::from_millis(250)).await,
            Err(error) => return Err(format!("{context}: {error}")),
        }
    };

    let stdout = stdout_task.await.unwrap_or_default();
    let stderr = stderr_task.await.unwrap_or_default();
    if status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&stderr);
    let stdout = String::from_utf8_lossy(&stdout);
    let detail = if !stderr.trim().is_empty() {
        stderr.trim()
    } else {
        stdout.trim()
    };
    if detail.is_empty() {
        Err(format!("{context} (exit {status})."))
    } else {
        let clipped: String = detail.chars().take(280).collect();
        Err(format!("{context}: {clipped}"))
    }
}
