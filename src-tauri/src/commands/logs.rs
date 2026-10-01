//! The in-memory log, read by the Logs page and written to by both windows.

use crate::logs::LogLine;
use crate::state::AppState;
use tauri::State;

/// The lines held, for a page that has just opened.
#[tauri::command]
pub async fn get_logs(state: State<'_, AppState>) -> Result<Vec<LogLine>, String> {
    Ok(state.logs.all())
}

#[tauri::command]
pub async fn clear_logs(state: State<'_, AppState>) -> Result<(), String> {
    state.logs.clear();
    Ok(())
}

/// Lets a window write into the same log.
///
/// The microphone lives in the overlay, so the numbers that explain a silent
/// dictation -- how many blocks arrived, how loud, against what threshold --
/// are only known there.
#[tauri::command]
pub async fn append_log(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    level: String,
    source: String,
    message: String,
) -> Result<(), String> {
    state.logs.push(&app, &level, &source, message);
    Ok(())
}
