//! Finding and installing a newer version, from the About page.

use crate::state::AppState;
use crate::updates;
use tauri::State;

/// Asks whether there is a newer version. `None` means this is the newest.
///
/// Always checks, even with the automatic check switched off: the switch is
/// about requests the user did not ask for, and pressing the button is asking.
#[tauri::command]
pub async fn check_for_update(app: tauri::AppHandle) -> Result<Option<updates::UpdateInfo>, String> {
    updates::check(&app).await
}

/// Installs the newer version and relaunches into it.
///
/// The engine is stopped first. It is a separate process of several hundred
/// megabytes that would not notice its parent being replaced, and the same
/// reason the signal handler stops it before exiting.
#[tauri::command]
pub async fn install_update(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    updates::install(&app).await?;
    state.models.stop().await;
    app.restart();
}

/// The version a check found and nobody has installed yet, for a window
/// that opened after the event saying so.
#[tauri::command]
pub fn update_available() -> Option<String> {
    updates::available()
}
