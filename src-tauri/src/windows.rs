//! The two webview windows by name, and bringing the main one forward.

use tauri::{ActivationPolicy, Manager};

pub(crate) const MAIN_LABEL: &str = "main";
pub(crate) const OVERLAY_LABEL: &str = "overlay";

/// Brings the window back and restores the Dock icon with it.
///
/// The Dock icon and the window are shown together: an app in the Dock whose
/// icon does nothing when clicked is worse than one that is not there at all.
pub(crate) fn present_main_window(app: &tauri::AppHandle) {
    let _ = app.set_activation_policy(ActivationPolicy::Regular);
    if let Some(window) = app.get_webview_window(MAIN_LABEL) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
