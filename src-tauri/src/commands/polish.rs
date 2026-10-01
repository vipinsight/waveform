//! AI Polish: the hosted key, the local models, and rewriting a selection.

use crate::local_llm::{self, LocalModelStatus};
use crate::rewrite::AiStatus;
use crate::state::AppState;
use tauri::State;

#[tauri::command]
pub async fn get_ai_status(state: State<'_, AppState>) -> Result<AiStatus, String> {
    Ok(state.rewriter.status().await)
}

#[tauri::command]
pub async fn set_openrouter_key(state: State<'_, AppState>, key: String) -> Result<AiStatus, String> {
    Ok(state.rewriter.set_key(&key).await)
}

#[tauri::command]
pub async fn clear_openrouter_key(state: State<'_, AppState>) -> Result<AiStatus, String> {
    Ok(state.rewriter.clear_key().await)
}

/// Every local polish model, and whether it is on this machine.
#[tauri::command]
pub async fn polish_model_catalog(state: State<'_, AppState>) -> Result<Vec<LocalModelStatus>, String> {
    let selected = state.settings.lock().await.value().local_model_id;
    Ok(local_llm::catalog(&selected))
}

/// Fetches one, with the row saying how far it has got.
#[tauri::command]
pub async fn download_polish_model(state: State<'_, AppState>, model_id: String) -> Result<(), String> {
    let outcome = state.polish_downloads.download(&model_id).await;
    if outcome.is_ok() {
        let settings = state.settings.lock().await.value();
        // The launch warm skipped this file because it was not here yet. Doing
        // it now puts the wait on the download they just watched, rather than
        // on the first dictation.
        if settings.polish_engine == "local" && settings.local_model_id == model_id {
            state.rewriter.engine_changed().await;
        }
    }
    outcome
}

/// Deletes a polish weight file the app fetched.
#[tauri::command]
pub async fn delete_polish_model(state: State<'_, AppState>, model_id: String) -> Result<(), String> {
    state.rewriter.unload_local_if(&model_id).await;
    local_llm::delete_weights(&model_id)
}

/// Stops an in-flight polish download.
#[tauri::command]
pub async fn cancel_polish_model_download(state: State<'_, AppState>) -> Result<(), String> {
    state.polish_downloads.cancel();
    Ok(())
}

#[tauri::command]
pub async fn polish_selection(state: State<'_, AppState>) -> Result<(), String> {
    state.dictation.polish_selection().await;
    Ok(())
}
