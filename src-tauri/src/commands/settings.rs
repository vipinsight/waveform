//! Reading and patching settings, and the side effects a changed setting has
//! on the running app.

use crate::settings::AppSettings;
use crate::state::{AppState, MicrophoneDevice};
use crate::tray::{refresh_tray_menu, set_tray_visibility};
use std::sync::atomic::Ordering;
use tauri::{ActivationPolicy, Emitter, State};
use tauri_plugin_autostart::ManagerExt as AutostartManagerExt;

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> Result<AppSettings, String> {
    Ok(state.settings.lock().await.value())
}

/// Device discovery belongs to WebKit because it owns getUserMedia. Keep a
/// short validated copy for the native menu bar, which has no media-device API.
#[tauri::command]
pub async fn set_available_microphones(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    devices: Vec<MicrophoneDevice>,
) -> Result<(), String> {
    let devices = devices
        .into_iter()
        .filter_map(|device| {
            let id: String = device.id.trim().chars().take(1_024).collect();
            let label: String = device.label.trim().chars().take(200).collect();
            let display_label: String = device.display_label.trim().chars().take(220).collect();
            (!id.is_empty() && !label.is_empty()).then_some(MicrophoneDevice {
                id,
                label,
                display_label,
            })
        })
        .take(32)
        .collect::<Vec<_>>();
    {
        let mut microphones = state.microphones.lock().map_err(|_| "Microphone list unavailable")?;
        if *microphones == devices {
            return Ok(());
        }
        *microphones = devices;
    }

    let settings = state.settings.lock().await.value();
    if settings.menu_bar_icon {
        refresh_tray_menu(&app);
    }
    Ok(())
}

/// Applies a partial patch.
///
/// The interface sends only the fields it changed. Deserializing straight into
/// `AppSettings` would fill every absent field with a default -- and because a
/// default is a *valid* value, normalization would keep it, so changing one
/// setting would quietly reset all the others. The patch is merged onto the
/// current value first.
#[tauri::command]
pub async fn update_settings(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    patch: serde_json::Value,
) -> Result<AppSettings, String> {
    let (previous, next) = {
        let mut settings = state.settings.lock().await;
        let previous = settings.value();
        let merged = merge_settings(&previous, &patch)?;
        (previous, settings.update(merged))
    };

    if next.model_id != previous.model_id {
        let models = state.models.clone();
        let id = next.model_id.clone();
        tauri::async_runtime::spawn(async move {
            let _ = models.select(&id).await;
        });
        if next.menu_bar_icon {
            refresh_tray_menu(&app);
        }
    }

    if next.hotkey_id != previous.hotkey_id
        || next.hold_ms != previous.hold_ms
        || next.double_tap_ms != previous.double_tap_ms
    {
        state.dictation.apply_settings().await;
    }
    if next.menu_bar_icon != previous.menu_bar_icon {
        set_tray_visibility(&app, next.menu_bar_icon);
    }
    if next.launch_at_login != previous.launch_at_login {
        set_launch_at_login(&app, next.launch_at_login);
    }
    if next.show_flow_bar_always != previous.show_flow_bar_always {
        state.dictation.apply_flow_bar_setting().await;
    }
    if next.menu_bar_icon
        && (next.microphone_device_id != previous.microphone_device_id
            || next.microphone_device_name != previous.microphone_device_name)
    {
        refresh_tray_menu(&app);
    }
    state
        .hide_dock_when_closed
        .store(next.hide_dock_when_closed, Ordering::Relaxed);
    // Turning the setting off while the Dock icon is already hidden has to put
    // it back, or the change appears not to have applied until a restart.
    if !next.hide_dock_when_closed && previous.hide_dock_when_closed {
        let _ = app.set_activation_policy(ActivationPolicy::Regular);
    }

    if next.polish_engine != previous.polish_engine
        || next.polish_level != previous.polish_level
        || (next.polish_engine == "local" && next.local_model_id != previous.local_model_id)
    {
        state.rewriter.engine_changed().await;
    }

    if next.polish_shortcut != previous.polish_shortcut {
        state
            .dictation
            .apply_polish_shortcut(&next.polish_shortcut)
            .await;
    }

    let _ = app.emit("settings-changed", &next);
    Ok(next)
}

/// Overlays the changed fields of `patch` onto `current`.
fn merge_settings(
    current: &AppSettings,
    patch: &serde_json::Value,
) -> Result<AppSettings, String> {
    let mut merged =
        serde_json::to_value(current).map_err(|error| format!("Invalid settings: {error}"))?;

    if let (Some(base), Some(fields)) = (merged.as_object_mut(), patch.as_object()) {
        for (key, value) in fields {
            base.insert(key.clone(), value.clone());
        }
    }

    serde_json::from_value(merged).map_err(|error| format!("Invalid settings patch: {error}"))
}

pub(crate) fn set_launch_at_login(app: &tauri::AppHandle, enabled: bool) {
    let manager = app.autolaunch();
    let _ = if enabled {
        manager.enable()
    } else {
        manager.disable()
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    fn customised() -> AppSettings {
        AppSettings {
            model_id: "qwen3-asr-0.6b".into(),
            hotkey_id: "right-option".into(),
            hold_ms: 200,
            theme: "light".into(),
            ..AppSettings::default()
        }
    }

    /// The interface sends only what changed. Every other choice must survive.
    #[test]
    fn a_partial_patch_leaves_other_settings_alone() {
        let current = customised();
        let patch = serde_json::json!({ "theme": "dark" });
        let merged = merge_settings(&current, &patch).expect("merges");

        assert_eq!(merged.theme, "dark");
        assert_eq!(merged.model_id, "qwen3-asr-0.6b");
        assert_eq!(merged.hotkey_id, "right-option");
        assert_eq!(merged.hold_ms, 200);
    }

    #[test]
    fn an_empty_patch_changes_nothing() {
        let current = customised();
        let merged = merge_settings(&current, &serde_json::json!({})).expect("merges");
        assert_eq!(merged.model_id, current.model_id);
        assert_eq!(merged.hotkey_id, current.hotkey_id);
        assert_eq!(merged.theme, current.theme);
    }

    #[test]
    fn a_patch_can_clear_the_overlay_position() {
        let mut current = customised();
        current.overlay_x = Some(10);
        current.overlay_y = Some(20);

        let patch = serde_json::json!({ "overlayX": null, "overlayY": null });
        let merged = merge_settings(&current, &patch).expect("merges");
        assert!(merged.overlay_x.is_none());
        assert!(merged.overlay_y.is_none());
    }

    #[test]
    fn patching_several_fields_at_once_keeps_all_of_them() {
        let current = customised();
        let patch = serde_json::json!({
            "polishLevel": "light",
            "polishShortcut": "Alt+2",
        });
        let merged = merge_settings(&current, &patch).expect("merges");
        assert_eq!(merged.polish_level, "light");
        assert_eq!(merged.polish_shortcut, "Alt+2");
        assert_eq!(merged.hotkey_id, "right-option");
    }
}
