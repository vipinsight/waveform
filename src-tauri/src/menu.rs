//! The application menu, and the one dispatcher both it and the menu bar icon
//! hand their selections to.

use crate::bundle::app_display_name;
use crate::model_server::MODELS;
use crate::state::AppState;
use crate::tray::refresh_tray_menu;
use crate::windows::{present_main_window, MAIN_LABEL};
use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager};

/// Builds the application menu.
///
/// Without one the standard editing shortcuts do not exist, so ⌘C and ⌘V do
/// nothing in a text field -- which matters most in the one field where typing
/// by hand is least likely, the API key.
pub(crate) fn build_app_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let name = app_display_name();
    let about = AboutMetadata {
        name: Some(name.clone()),
        version: Some(env!("CARGO_PKG_VERSION").into()),
        comments: Some("Private, on-device voice transcription.".into()),
        ..Default::default()
    };

    let settings = MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?;
    let dictate = MenuItem::with_id(
        app,
        "toggle-dictation",
        "Start or Stop Listening",
        true,
        Some("CmdOrCtrl+D"),
    )?;
    let polish = MenuItem::with_id(app, "polish", "Polish Selection", true, None::<&str>)?;
    let about_title = format!("About {name}");

    let app_menu = Submenu::with_items(
        app,
        &name,
        true,
        &[
            &PredefinedMenuItem::about(app, Some(&about_title), Some(about))?,
            &PredefinedMenuItem::separator(app)?,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let dictation_menu =
        Submenu::with_items(app, "Dictation", true, &[&dictate, &polish])?;

    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    Menu::with_items(
        app,
        &[&app_menu, &edit_menu, &dictation_menu, &window_menu],
    )
}

/// Runs a menu action, from either the app menu or the menu bar icon.
pub(crate) fn handle_menu_action(app: &tauri::AppHandle, id: &str) {
    if id == "install-update" {
        install_update_from_menu(app);
        return;
    }
    if id == "microphone-default" {
        select_microphone_from_menu(app, String::new(), String::new());
        return;
    }
    if let Some(definition) = id
        .strip_prefix("model-")
        .and_then(|value| value.parse::<usize>().ok())
        .and_then(|index| MODELS.get(index))
    {
        select_model_from_menu(app, definition.id);
        return;
    }
    if let Some(index) = id
        .strip_prefix("microphone-device-")
        .and_then(|value| value.parse::<usize>().ok())
    {
        let device = app
            .state::<AppState>()
            .microphones
            .lock()
            .ok()
            .and_then(|devices| devices.get(index).cloned());
        if let Some(device) = device {
            select_microphone_from_menu(app, device.id, device.label);
        }
        return;
    }
    match id {
        "open" => present_main_window(app),
        "settings" => {
            present_main_window(app);
            let _ = app.emit_to(MAIN_LABEL, "open-settings", ());
        }
        "microphone-settings" => {
            present_main_window(app);
            let _ = app.emit_to(MAIN_LABEL, "open-microphone-settings", ());
        }
        "model-settings" => {
            present_main_window(app);
            let _ = app.emit_to(MAIN_LABEL, "open-model-settings", ());
        }
        "toggle-dictation" => {
            let dictation = app.state::<AppState>().dictation.clone();
            tauri::async_runtime::spawn(async move { dictation.toggle_from_app().await });
        }
        "shortcut-settings" => {
            present_main_window(app);
            let _ = app.emit_to(MAIN_LABEL, "open-shortcut-settings", ());
        }
        "paste-last" => {
            let dictation = app.state::<AppState>().dictation.clone();
            tauri::async_runtime::spawn(async move { dictation.paste_last().await });
        }
        "meeting-record" => {
            present_main_window(app);
            let _ = app.emit_to(MAIN_LABEL, "open-meetings", "record");
        }
        "meeting-stop" => {
            let recorder = app.state::<AppState>().recorder.clone();
            tauri::async_runtime::spawn(async move {
                let _ = recorder.stop().await;
            });
        }
        "meeting-show" => {
            present_main_window(app);
            let _ = app.emit_to(MAIN_LABEL, "open-meetings", "show");
        }
        "polish" => {
            let dictation = app.state::<AppState>().dictation.clone();
            tauri::async_runtime::spawn(async move { dictation.polish_selection().await });
        }
        "quit" => app.exit(0),
        _ => {}
    }
}

/// "Update and Restart" from the menu bar. Progress is shown in the window's
/// sidebar; a failure brings the window forward so it can be read there.
fn install_update_from_menu(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match crate::updates::install(&app).await {
            Ok(()) => {
                app.state::<AppState>().models.stop().await;
                app.restart();
            }
            Err(_) => present_main_window(&app),
        }
    });
}

/// Switching model from the menu bar, which is `select_model` without a
/// window: persist the choice, tell every WebView, then load the engine.
///
/// The load is what takes time, and it is left until last so the menu's tick
/// has already moved by the time it starts. A failure is reported the way
/// every other model failure is, through `model-event`.
fn select_model_from_menu(app: &tauri::AppHandle, model_id: &'static str) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let (next, models) = {
            let state = app.state::<AppState>();
            let mut settings = state.settings.lock().await;
            let mut value = settings.value();
            if value.model_id == model_id {
                return;
            }
            value.model_id = model_id.to_string();
            (settings.update(value), state.models.clone())
        };
        let _ = app.emit("settings-changed", &next);
        if next.menu_bar_icon {
            refresh_tray_menu(&app);
        }
        let _ = models.select(model_id).await;
    });
}

/// Menu selections are settings changes too, so every WebView gets the same
/// event and the next dictation session uses the chosen input.
fn select_microphone_from_menu(app: &tauri::AppHandle, device_id: String, device_name: String) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let next = {
            let state = app.state::<AppState>();
            let mut settings = state.settings.lock().await;
            let mut next = settings.value();
            next.microphone_device_id = device_id;
            next.microphone_device_name = device_name;
            settings.update(next)
        };
        let _ = app.emit("settings-changed", &next);
        if next.menu_bar_icon {
            refresh_tray_menu(&app);
        }
    });
}
