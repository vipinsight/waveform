//! The speech model catalogue: which one is in use, and fetching or deleting
//! the weights for any of them.

use crate::model_server::{ModelEvent, ModelStatus};
use crate::state::AppState;
use crate::tray::refresh_tray_menu;
use tauri::{Emitter, State};

#[tauri::command]
pub async fn get_model_state(state: State<'_, AppState>) -> Result<ModelEvent, String> {
    Ok(state.models.state().await)
}

#[tauri::command]
pub async fn start_model(state: State<'_, AppState>) -> Result<(), String> {
    state.models.start().await
}

#[tauri::command]
pub async fn select_model(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    model_id: String,
) -> Result<(), String> {
    // Persist before starting: otherwise the choice is lost on relaunch, and
    // the next settings broadcast snaps the picker back to the stored value.
    let next = {
        let mut settings = state.settings.lock().await;
        let mut value = settings.value();
        value.model_id = model_id.clone();
        settings.update(value)
    };
    let _ = app.emit("settings-changed", &next);
    // The menu bar carries the same tick, so it has to hear about a choice
    // made in the window.
    if next.menu_bar_icon {
        refresh_tray_menu(&app);
    }

    state.models.select(&next.model_id).await
}

#[tauri::command]
pub async fn model_catalog(state: State<'_, AppState>) -> Result<Vec<ModelStatus>, String> {
    Ok(state.models.catalog().await)
}

/// Fetches a model's weights.
///
/// Slow enough that the interface watches `model-event` for progress rather
/// than this reply, but still awaited: the row cannot say what it is until the
/// download has actually finished one way or the other.
#[tauri::command]
pub async fn download_model(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    model_id: String,
) -> Result<(), String> {
    let outcome = state.models.download_weights(&model_id).await;
    // A model that has arrived is one the menu bar can now switch to, where a
    // moment ago it was greyed out.
    if outcome.is_ok() && state.settings.lock().await.value().menu_bar_icon {
        refresh_tray_menu(&app);
    }
    outcome
}

/// Deletes a model's weight files from disk.
#[tauri::command]
pub async fn delete_model(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    model_id: String,
) -> Result<(), String> {
    let outcome = state.models.delete_weights(&model_id).await;
    if outcome.is_ok() && state.settings.lock().await.value().menu_bar_icon {
        refresh_tray_menu(&app);
    }
    outcome
}

/// Stops an in-flight Whisper download.
#[tauri::command]
pub async fn cancel_model_download(state: State<'_, AppState>) -> Result<(), String> {
    state.models.cancel_download();
    Ok(())
}
