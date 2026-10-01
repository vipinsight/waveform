//! Tauri host for Waveform.
//!
//! The window layer -- UI, audio capture, segmentation, the overlay meter -- is
//! shared with the Electron build and reached through the same `window.waveform`
//! surface. This crate supplies that surface natively.
//!
//! This file only assembles the app. The pieces live beside it:
//!
//! - `bootstrap` opens the stores and engines once at launch and handles the
//!   run events at the other end of the process's life;
//! - `commands/` holds every `#[tauri::command]`, grouped by what it acts on;
//! - `menu` and `tray` are the application menu and the menu bar icon;
//! - `windows` and `overlay_window` name and place the two webviews;
//! - `state` is what all of those share; `bundle` is what the binary knows
//!   about the `.app` it was launched from.
//!
//! Everything else -- the dictation state machine, the meeting recorder, the
//! engines, the stores -- is domain code that knows nothing about Tauri's
//! builder.

mod audio;
mod bootstrap;
mod bundle;
mod clock;
mod commands;
mod diarize;
mod dictation;
mod dictionary;
mod download;
mod focus;
mod gestures;
mod history;
mod hotkey;
mod install;
mod local_llm;
mod logs;
mod meeting;
mod meetings;
mod menu;
mod mic;
mod model_server;
mod overlay_window;
mod panel;
mod paths;
mod resources;
mod rewrite;
mod settings;
mod state;
mod stats;
mod store;
mod summary;
mod transcribe;
mod tray;
mod updates;
mod whisper_cpp;
mod windows;

use bootstrap::AUTOSTART_ARG;
use tauri::Manager;
use tauri_plugin_autostart::MacosLauncher;
use windows::OVERLAY_LABEL;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let started_at_login = std::env::args_os().any(|arg| arg == AUTOSTART_ARG);
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![AUTOSTART_ARG]),
        ))
        // Remembers the main window's size and position, but never restores
        // visibility: setup decides whether to show it based on the launch source.
        // The overlay is excluded: it is placed deliberately and its position
        // is already persisted in settings.
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        - tauri_plugin_window_state::StateFlags::VISIBLE,
                )
                .with_denylist(&[OVERLAY_LABEL])
                .build(),
        )
        .menu(menu::build_app_menu)
        .on_menu_event(|app, event| menu::handle_menu_action(app.app_handle(), event.id().as_ref()))
        .setup(move |app| bootstrap::setup(app, started_at_login))
        .invoke_handler(commands::handler())
        .build(tauri::generate_context!())
        .expect("error while building Waveform")
        .run(bootstrap::on_run_event);
}
