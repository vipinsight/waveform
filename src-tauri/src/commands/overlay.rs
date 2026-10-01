//! What the HUD tells the host about itself: where its pill is, and where it
//! is being dragged to.

use crate::overlay_window::{OVERLAY_PILL_CX, OVERLAY_PILL_CY};
use crate::settings::AppSettings;
use crate::state::AppState;
use crate::windows::OVERLAY_LABEL;
use tauri::{Emitter, Manager, State};

/// The HUD reports which part of its window is the pill; see `watch_overlay_hover`.
#[tauri::command]
pub async fn set_overlay_hit_region(
    state: State<'_, AppState>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if let Ok(mut region) = state.overlay_hit_region.lock() {
        *region = Some((x, y, width, height));
    }
    Ok(())
}

#[tauri::command]
pub async fn begin_overlay_drag(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if let Some(overlay) = app.get_webview_window(OVERLAY_LABEL) {
        if let Ok(position) = overlay.outer_position() {
            // Logical, because that is what the deltas are: the HUD measures
            // them from `screenX`, which WebKit reports in CSS pixels. Keeping
            // the origin physical meant adding points to device pixels, and on
            // a Retina display the pill tracked the pointer at half speed.
            let scale = overlay.scale_factor().unwrap_or(1.0);
            let logical = position.to_logical::<f64>(scale);
            *state.drag_origin.lock().await = Some((logical.x, logical.y));
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn drag_overlay(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    delta_x: f64,
    delta_y: f64,
) -> Result<(), String> {
    let origin = *state.drag_origin.lock().await;
    let Some((x, y)) = origin else { return Ok(()) };
    if let Some(overlay) = app.get_webview_window(OVERLAY_LABEL) {
        // Absolute from the origin rather than relative to the last move, so a
        // dropped event cannot leave the pill behind the pointer for good --
        // and logical throughout, so it moves exactly as far as the hand does.
        let _ = overlay.set_position(tauri::LogicalPosition::new(x + delta_x, y + delta_y));
    }
    Ok(())
}

#[tauri::command]
pub async fn end_overlay_drag(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    delta_x: f64,
    delta_y: f64,
) -> Result<AppSettings, String> {
    let origin = state.drag_origin.lock().await.take();
    let Some(overlay) = app.get_webview_window(OVERLAY_LABEL) else {
        return Ok(state.settings.lock().await.value());
    };
    // The last position, applied here rather than by a `drag_overlay` racing
    // this command: both are spawned futures, and the one that saved could run
    // first. The pill would then come to rest a frame short of the pointer and
    // that is what got written down.
    if let Some((x, y)) = origin {
        let _ = overlay.set_position(tauri::LogicalPosition::new(x + delta_x, y + delta_y));
    }
    let Ok(position) = overlay.outer_position() else {
        return Ok(state.settings.lock().await.value());
    };

    let next = {
        let mut store = state.settings.lock().await;
        let mut settings = store.value();
        settings.overlay_x = Some(position.x);
        settings.overlay_y = Some(position.y);
        settings.overlay_cx = Some(OVERLAY_PILL_CX);
        settings.overlay_cy = Some(OVERLAY_PILL_CY);
        store.update(settings)
    };
    let _ = app.emit("settings-changed", &next);
    Ok(next)
}
