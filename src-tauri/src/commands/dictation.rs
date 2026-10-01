//! Starting, stopping and reporting on a dictation session, and the macOS
//! permissions it depends on.

use crate::dictation::{DictationClip, DictationPhrase, DictationStatus, HotkeyStatus};
use crate::state::AppState;
use tauri::State;
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
pub async fn toggle_dictation(state: State<'_, AppState>) -> Result<(), String> {
    state.dictation.toggle_from_app().await;
    Ok(())
}

#[tauri::command]
pub async fn start_overlay_dictation(state: State<'_, AppState>) -> Result<(), String> {
    state.dictation.start_from_overlay().await;
    Ok(())
}

#[tauri::command]
pub async fn accept_dictation(state: State<'_, AppState>) -> Result<(), String> {
    state.dictation.accept_from_overlay().await;
    Ok(())
}

#[tauri::command]
pub async fn polish_dictation(state: State<'_, AppState>) -> Result<(), String> {
    state.dictation.stop_and_polish().await;
    Ok(())
}

#[tauri::command]
pub async fn cancel_dictation(state: State<'_, AppState>) -> Result<(), String> {
    state.dictation.cancel_from_app().await;
    Ok(())
}

#[tauri::command]
pub async fn retry_dictation(state: State<'_, AppState>) -> Result<(), String> {
    state.dictation.retry_from_app().await;
    Ok(())
}

#[tauri::command]
pub async fn dismiss_dictation_retry(state: State<'_, AppState>) -> Result<(), String> {
    state.dictation.dismiss_retry_from_app().await;
    Ok(())
}

#[tauri::command]
pub async fn preview_indicator(state: State<'_, AppState>) -> Result<(), String> {
    state.dictation.preview_indicator().await;
    Ok(())
}

#[tauri::command]
pub async fn report_dictation_state(
    state: State<'_, AppState>,
    status: DictationStatus,
) -> Result<(), String> {
    state.dictation.on_overlay_state(status).await;
    Ok(())
}

#[tauri::command]
pub async fn report_dictation_clip(
    state: State<'_, AppState>,
    clip: DictationClip,
) -> Result<(), String> {
    state.dictation.on_overlay_clip(clip.wav_bytes).await;
    Ok(())
}

#[tauri::command]
pub async fn report_dictation_phrase(
    state: State<'_, AppState>,
    phrase: DictationPhrase,
) -> Result<(), String> {
    state.dictation.on_overlay_phrase(phrase).await;
    Ok(())
}

#[tauri::command]
pub async fn get_hotkey_status(state: State<'_, AppState>) -> Result<HotkeyStatus, String> {
    state.dictation.refresh_permissions().await;
    Ok(state.dictation.status().await)
}

#[tauri::command]
pub async fn request_hotkey_permission(
    state: State<'_, AppState>,
    scope: String,
) -> Result<(), String> {
    if scope != "accessibility" && scope != "input-monitoring" {
        return Ok(());
    }
    state.dictation.request_permission(&scope).await;
    Ok(())
}

#[tauri::command]
pub async fn open_privacy_settings(app: tauri::AppHandle, pane: String) -> Result<(), String> {
    let anchor = match pane.as_str() {
        "accessibility" => "Privacy_Accessibility",
        "input-monitoring" => "Privacy_ListenEvent",
        "microphone" => "Privacy_Microphone",
        _ => return Ok(()),
    };
    let url = format!("x-apple.systempreferences:com.apple.preference.security?{anchor}");
    let _ = app.opener().open_url(url, None::<&str>);
    Ok(())
}
