//! Audio in, words out: the microphone the overlay opens and the engine that
//! turns each phrase into text.

use crate::clock::now_ms;
use crate::state::AppState;
use serde::Serialize;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MicrophoneResult {
    granted: bool,
    status: String,
}

/// `prior_text` is what the current session has transcribed so far, so the
/// decoder knows which sentence it is in the middle of. Absent for a phrase
/// with no session behind it: a dropped file, or a retry from Transcripts.
#[tauri::command]
pub async fn transcribe(
    state: State<'_, AppState>,
    wav_bytes: Vec<u8>,
    prior_text: Option<String>,
) -> Result<String, String> {
    dump_audio(&wav_bytes);
    state
        .engine
        .transcribe(wav_bytes, prior_text.as_deref().unwrap_or(""), "engine")
        .await
}

/// Writes each phrase to disk when `WAVEFORM_DUMP_AUDIO` names a directory.
///
/// For when an engine reports silence and the meter says otherwise: those two
/// read the microphone through different nodes, so only the bytes actually sent
/// settle which one is lying. Off unless asked for, and audio is never
/// otherwise written anywhere.
fn dump_audio(wav: &[u8]) {
    let Some(dir) = std::env::var_os("WAVEFORM_DUMP_AUDIO") else {
        return;
    };
    let dir = std::path::PathBuf::from(dir);
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let path = dir.join(format!("phrase-{}.wav", now_ms()));
    if std::fs::write(&path, wav).is_ok() {
        eprintln!("waveform: wrote {} bytes to {}", wav.len(), path.display());
    }
}

/// WKWebView drives its own microphone prompt from the bundle's usage
/// description, so there is nothing to request here; getUserMedia surfaces any
/// refusal itself.
#[tauri::command]
pub fn request_microphone() -> MicrophoneResult {
    MicrophoneResult {
        granted: true,
        status: "granted".into(),
    }
}

#[tauri::command]
pub async fn start_native_capture(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<String, String> {
    let name = state.settings.lock().await.value().microphone_device_name;
    let capture = state.capture.clone();
    tokio::task::spawn_blocking(move || capture.start(&app, &name))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn stop_native_capture(state: State<'_, AppState>) -> Result<(), String> {
    let capture = state.capture.clone();
    tokio::task::spawn_blocking(move || capture.stop())
        .await
        .map_err(|error| error.to_string())
}
