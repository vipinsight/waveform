//! Tauri host for Waveform.
//!
//! The window layer -- UI, audio capture, segmentation, the overlay meter -- is
//! shared with the Electron build and reached through the same `window.waveform`
//! surface. This crate supplies that surface natively.

mod gestures;
mod history;
mod hotkey;
mod dictation;
mod model_server;
mod resources;
mod rewrite;
mod settings;
mod stats;

use dictation::{Dictation, DictationPhrase, DictationStatus, HotkeyStatus};
use history::{Dictation as SavedDictation, HistoryStore};
use model_server::{ModelEvent, ModelServer};
use rewrite::{AiStatus, Rewriter};
use serde::{Deserialize, Serialize};
use settings::{AppSettings, SettingsStore};
use stats::{AppStats, StatsStore};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex as StdMutex;
use std::sync::Arc;
use tauri::menu::{AboutMetadata, CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{
    ActivationPolicy, Emitter, Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder,
    WindowEvent,
};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as AutostartManagerExt};
use tokio::sync::Mutex;

const MAIN_LABEL: &str = "main";
const OVERLAY_LABEL: &str = "overlay";
/// Large enough for the pill and the tooltips it raises above itself. The
/// window is transparent but not click-through, so it is kept only as big as
/// the widest tooltip actually needs.
const OVERLAY_WIDTH: f64 = 192.0;
const OVERLAY_HEIGHT: f64 = 78.0;
/// The size saved positions were recorded against before the HUD grew to make
/// room for tooltips. A stored frame stays a frame of its own era until the
/// user drags the HUD again, so it is corrected when read rather than
/// rewritten -- which keeps the correction idempotent across launches.
const LEGACY_OVERLAY_WIDTH: f64 = 122.0;
const LEGACY_OVERLAY_HEIGHT: f64 = 48.0;
const EDGE_MARGIN: f64 = 88.0;

pub struct AppState {
    settings: Arc<Mutex<SettingsStore>>,
    stats: Arc<Mutex<StatsStore>>,
    history: Arc<Mutex<HistoryStore>>,
    models: Arc<ModelServer>,
    dictation: Arc<Dictation>,
    rewriter: Arc<Rewriter>,
    /// Bounds captured when an overlay drag begins, so moves are relative.
    drag_origin: Mutex<Option<(f64, f64)>>,
    /// Mirrors the setting of the same name.
    ///
    /// Window events arrive on the main thread, where blocking on the async
    /// settings lock could deadlock against a task already holding it. Closing
    /// a window is the worst possible place to risk that, so this one flag is
    /// kept where it can be read without waiting.
    hide_dock_when_closed: AtomicBool,
    /// WebKit enumerates input devices; the tray uses this cached list when
    /// Waveform's main window is closed.
    microphones: StdMutex<Vec<MicrophoneDevice>>,
    /// Whether the pointer is over the HUD, from `watch_overlay_hover`. Read
    /// on the main thread while handling reopen, so it cannot be a lock.
    overlay_hovered: AtomicBool,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MicrophoneDevice {
    id: String,
    label: String,
    display_label: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MicrophoneResult {
    granted: bool,
    status: String,
}

/// Brings the window back and restores the Dock icon with it.
///
/// The Dock icon and the window are shown together: an app in the Dock whose
/// icon does nothing when clicked is worse than one that is not there at all.
fn present_main_window(app: &tauri::AppHandle) {
    let _ = app.set_activation_policy(ActivationPolicy::Regular);
    if let Some(window) = app.get_webview_window(MAIN_LABEL) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[tauri::command]
async fn show_main_window(app: tauri::AppHandle) -> Result<(), String> {
    present_main_window(&app);
    Ok(())
}

#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
async fn get_settings(state: State<'_, AppState>) -> Result<AppSettings, String> {
    Ok(state.settings.lock().await.value())
}

/// Device discovery belongs to WebKit because it owns getUserMedia. Keep a
/// short validated copy for the native menu bar, which has no media-device API.
#[tauri::command]
async fn set_available_microphones(
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
        .collect();
    *state.microphones.lock().map_err(|_| "Microphone list unavailable")? = devices;

    let settings = state.settings.lock().await.value();
    if settings.menu_bar_icon {
        rebuild_tray(&app);
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
async fn update_settings(
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
    if next.microphone_device_id != previous.microphone_device_id
        || next.microphone_device_name != previous.microphone_device_name
    {
        if next.menu_bar_icon {
            rebuild_tray(&app);
        }
    }
    state
        .hide_dock_when_closed
        .store(next.hide_dock_when_closed, Ordering::Relaxed);
    // Turning the setting off while the Dock icon is already hidden has to put
    // it back, or the change appears not to have applied until a restart.
    if !next.hide_dock_when_closed && previous.hide_dock_when_closed {
        let _ = app.set_activation_policy(ActivationPolicy::Regular);
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

#[tauri::command]
async fn get_history(state: State<'_, AppState>) -> Result<Vec<SavedDictation>, String> {
    Ok(state.history.lock().await.entries())
}

#[tauri::command]
async fn delete_dictation(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<SavedDictation>, String> {
    let entries = state.history.lock().await.remove(&id);
    let _ = app.emit("history-changed", &entries);
    Ok(entries)
}

#[tauri::command]
async fn clear_history(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<SavedDictation>, String> {
    let entries = state.history.lock().await.clear();
    let _ = app.emit("history-changed", &entries);
    Ok(entries)
}

#[tauri::command]
async fn get_stats(state: State<'_, AppState>) -> Result<AppStats, String> {
    Ok(state.stats.lock().await.value())
}

#[tauri::command]
async fn get_model_state(state: State<'_, AppState>) -> Result<ModelEvent, String> {
    Ok(state.models.state().await)
}

#[tauri::command]
async fn start_model(state: State<'_, AppState>) -> Result<(), String> {
    state.models.start().await
}

#[tauri::command]
async fn select_model(
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

    state.models.select(&next.model_id).await
}

#[tauri::command]
async fn transcribe(state: State<'_, AppState>, wav_bytes: Vec<u8>) -> Result<String, String> {
    state.models.transcribe(wav_bytes).await
}

/// WKWebView drives its own microphone prompt from the bundle's usage
/// description, so there is nothing to request here; getUserMedia surfaces any
/// refusal itself.
#[tauri::command]
fn request_microphone() -> MicrophoneResult {
    MicrophoneResult {
        granted: true,
        status: "granted".into(),
    }
}

#[tauri::command]
async fn toggle_dictation(state: State<'_, AppState>) -> Result<(), String> {
    state.dictation.toggle_from_app().await;
    Ok(())
}

#[tauri::command]
async fn start_overlay_dictation(state: State<'_, AppState>) -> Result<(), String> {
    state.dictation.start_from_overlay().await;
    Ok(())
}

#[tauri::command]
async fn accept_dictation(state: State<'_, AppState>) -> Result<(), String> {
    state.dictation.accept_from_overlay().await;
    Ok(())
}

#[tauri::command]
async fn polish_dictation(state: State<'_, AppState>) -> Result<(), String> {
    state.dictation.stop_and_polish().await;
    Ok(())
}

#[tauri::command]
async fn cancel_dictation(state: State<'_, AppState>) -> Result<(), String> {
    state.dictation.cancel_from_app().await;
    Ok(())
}

#[tauri::command]
async fn preview_indicator(state: State<'_, AppState>) -> Result<(), String> {
    state.dictation.preview_indicator().await;
    Ok(())
}

#[tauri::command]
async fn report_dictation_state(
    state: State<'_, AppState>,
    status: DictationStatus,
) -> Result<(), String> {
    state.dictation.on_overlay_state(status).await;
    Ok(())
}

#[tauri::command]
async fn report_dictation_phrase(
    state: State<'_, AppState>,
    phrase: DictationPhrase,
) -> Result<(), String> {
    state.dictation.on_overlay_phrase(phrase).await;
    Ok(())
}

#[tauri::command]
async fn get_hotkey_status(state: State<'_, AppState>) -> Result<HotkeyStatus, String> {
    state.dictation.refresh_permissions().await;
    Ok(state.dictation.status().await)
}

#[tauri::command]
async fn request_hotkey_permission(
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
async fn open_privacy_settings(app: tauri::AppHandle, pane: String) -> Result<(), String> {
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

#[tauri::command]
async fn get_ai_status(state: State<'_, AppState>) -> Result<AiStatus, String> {
    Ok(state.rewriter.status().await)
}

#[tauri::command]
async fn set_openrouter_key(state: State<'_, AppState>, key: String) -> Result<AiStatus, String> {
    Ok(state.rewriter.set_key(&key).await)
}

#[tauri::command]
async fn clear_openrouter_key(state: State<'_, AppState>) -> Result<AiStatus, String> {
    Ok(state.rewriter.clear_key().await)
}

#[tauri::command]
async fn polish_selection(state: State<'_, AppState>) -> Result<(), String> {
    state.dictation.polish_selection().await;
    Ok(())
}

#[tauri::command]
async fn begin_overlay_drag(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if let Some(overlay) = app.get_webview_window(OVERLAY_LABEL) {
        if let Ok(position) = overlay.outer_position() {
            *state.drag_origin.lock().await = Some((position.x as f64, position.y as f64));
        }
    }
    Ok(())
}

#[tauri::command]
async fn drag_overlay(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    delta_x: f64,
    delta_y: f64,
) -> Result<(), String> {
    let origin = *state.drag_origin.lock().await;
    let Some((x, y)) = origin else { return Ok(()) };
    if let Some(overlay) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = overlay.set_position(tauri::PhysicalPosition::new(
            (x + delta_x) as i32,
            (y + delta_y) as i32,
        ));
    }
    Ok(())
}

#[tauri::command]
async fn end_overlay_drag(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<AppSettings, String> {
    *state.drag_origin.lock().await = None;
    let Some(overlay) = app.get_webview_window(OVERLAY_LABEL) else {
        return Ok(state.settings.lock().await.value());
    };
    let Ok(position) = overlay.outer_position() else {
        return Ok(state.settings.lock().await.value());
    };

    let next = {
        let mut store = state.settings.lock().await;
        let mut settings = store.value();
        settings.overlay_x = Some(position.x);
        settings.overlay_y = Some(position.y);
        settings.overlay_w = Some(OVERLAY_WIDTH);
        settings.overlay_h = Some(OVERLAY_HEIGHT);
        store.update(settings)
    };
    let _ = app.emit("settings-changed", &next);
    Ok(next)
}

/// Positions the overlay from saved coordinates, or centres it on a screen edge.
pub fn place_overlay(overlay: &tauri::WebviewWindow, settings: &AppSettings) {
    if let (Some(x), Some(y)) = (settings.overlay_x, settings.overlay_y) {
        // The pill sits at the centre of its window, so a window that has
        // changed size since the position was saved would put the pill
        // somewhere else. Shift the frame by half the difference to leave the
        // pill exactly where the user last dragged it.
        let scale = overlay.scale_factor().unwrap_or(1.0);
        let saved_width = settings.overlay_w.unwrap_or(LEGACY_OVERLAY_WIDTH);
        let saved_height = settings.overlay_h.unwrap_or(LEGACY_OVERLAY_HEIGHT);
        let dx = ((OVERLAY_WIDTH - saved_width) / 2.0 * scale).round() as i32;
        let dy = ((OVERLAY_HEIGHT - saved_height) / 2.0 * scale).round() as i32;
        let _ = overlay.set_position(tauri::PhysicalPosition::new(x - dx, y - dy));
        return;
    }
    position_on_active_display(overlay, &settings.overlay_placement);
}

/// Puts the overlay on whichever display the pointer is on.
fn position_on_active_display(overlay: &tauri::WebviewWindow, placement: &str) {
    let Ok(Some(monitor)) = overlay.primary_monitor() else {
        return;
    };
    let size = monitor.size();
    let position = monitor.position();
    let scale = monitor.scale_factor();

    let width = (OVERLAY_WIDTH * scale) as i32;
    let height = (OVERLAY_HEIGHT * scale) as i32;
    let margin = (EDGE_MARGIN * scale) as i32;

    let x = position.x + (size.width as i32 - width) / 2;
    let y = if placement == "top" {
        position.y + margin
    } else {
        position.y + size.height as i32 - height - margin
    };
    let _ = overlay.set_position(tauri::PhysicalPosition::new(x, y));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        // Remembers the main window's size and position. The overlay is
        // excluded: it is placed deliberately and its position is already
        // persisted in settings.
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_denylist(&[OVERLAY_LABEL])
                .build(),
        )
        .menu(build_app_menu)
        .on_menu_event(|app, event| handle_menu_action(app.app_handle(), event.id().as_ref()))
        .setup(|app| {
            let user_data = user_data_dir(app.handle());
            std::fs::create_dir_all(&user_data).ok();

            let settings = Arc::new(Mutex::new(SettingsStore::load(user_data.clone())));
            let stats = Arc::new(Mutex::new(StatsStore::load(user_data.clone())));
            let history = Arc::new(Mutex::new(HistoryStore::load(user_data.clone())));
            let initial = tauri::async_runtime::block_on(settings.lock()).value();
            let selected = initial.model_id.clone();

            let handle = app.handle().clone();
            let models = Arc::new(ModelServer::new(
                user_data,
                project_root(),
                app.path().resource_dir().ok(),
                selected.clone(),
                Box::new(move |event: ModelEvent| {
                    let _ = handle.emit("model-event", event);
                }),
            ));

            let rewriter = Rewriter::new(settings.clone());
            let dictation = Dictation::new(
                app.handle().clone(),
                settings.clone(),
                stats.clone(),
                history.clone(),
                rewriter.clone(),
                models.clone(),
            );

            app.manage(AppState {
                settings,
                stats,
                history,
                models: models.clone(),
                dictation: dictation.clone(),
                rewriter,
                drag_origin: Mutex::new(None),
                hide_dock_when_closed: AtomicBool::new(initial.hide_dock_when_closed),
                microphones: StdMutex::new(Vec::new()),
                overlay_hovered: AtomicBool::new(false),
            });

            build_overlay_window(app.handle())?;
            watch_overlay_hover(app.handle().clone());

            set_launch_at_login(app.handle(), initial.launch_at_login);
            if initial.show_flow_bar_always {
                let dictation = dictation.clone();
                tauri::async_runtime::spawn(async move {
                    dictation.apply_flow_bar_setting().await;
                });
            }

            let root = project_root();
            tauri::async_runtime::spawn(async move {
                dictation.initialize(root).await;
            });

            if initial.menu_bar_icon {
                build_tray(app.handle())?;
            }

            // Closing the window must not end the process: the whole point is
            // that the shortcut keeps working with no window on screen.
            if let Some(window) = app.get_webview_window(MAIN_LABEL) {
                let handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        if let Some(window) = handle.get_webview_window(MAIN_LABEL) {
                            let _ = window.hide();
                        }
                        let hide_dock = handle
                            .state::<AppState>()
                            .hide_dock_when_closed
                            .load(Ordering::Relaxed);
                        if hide_dock {
                            let _ = handle.set_activation_policy(ActivationPolicy::Accessory);
                        }
                    }
                });
            }

            // The Exit event covers a normal quit, but a terminated or crashed
            // app would leave the engine running -- it is a separate process
            // and does not notice its parent going away.
            let engine = models.clone();
            tauri::async_runtime::spawn(async move {
                use tokio::signal::unix::{signal, SignalKind};
                let Ok(mut terminate) = signal(SignalKind::terminate()) else {
                    return;
                };
                let Ok(mut interrupt) = signal(SignalKind::interrupt()) else {
                    return;
                };
                tokio::select! {
                    _ = terminate.recv() => {}
                    _ = interrupt.recv() => {}
                }
                engine.stop().await;
                std::process::exit(0);
            });

            resources::spawn_monitor(app.handle().clone(), models.clone());

            // Load the engine at launch so the first dictation is not the thing
            // that waits for it.
            tauri::async_runtime::spawn(async move {
                let _ = models.select(&selected).await;
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            show_main_window,
            app_version,
            get_settings,
            update_settings,
            set_available_microphones,
            get_stats,
            get_history,
            delete_dictation,
            clear_history,
            get_model_state,
            start_model,
            select_model,
            transcribe,
            request_microphone,
            toggle_dictation,
            start_overlay_dictation,
            accept_dictation,
            polish_dictation,
            cancel_dictation,
            preview_indicator,
            report_dictation_state,
            report_dictation_phrase,
            get_hotkey_status,
            request_hotkey_permission,
            open_privacy_settings,
            get_ai_status,
            set_openrouter_key,
            clear_openrouter_key,
            polish_selection,
            begin_overlay_drag,
            drag_overlay,
            end_overlay_drag,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Waveform")
        .run(|app, event| match event {
            // Clicking the Dock icon of a running app with no open window.
            // Without this the icon appears inert.
            //
            // The HUD is an ordinary NSWindow -- tao's `focusable(false)` only
            // stops it becoming key, it does not stop a click activating the
            // application -- and AppKit reports that activation as a reopen
            // too. Pressing cancel or accept therefore raised the main window,
            // which is both wrong on its own terms and takes focus from the app
            // being dictated into. A reopen while the pointer is on the HUD came
            // from the HUD, not from the Dock, and is not a request for a window.
            RunEvent::Reopen { .. } => {
                if !app
                    .state::<AppState>()
                    .overlay_hovered
                    .load(Ordering::Relaxed)
                {
                    present_main_window(app);
                }
            }
            // The engine is a separate process of several hundred megabytes and
            // does not exit on its own, so it has to be shut down explicitly or
            // it outlives the app.
            RunEvent::Exit => {
                let models = app.state::<AppState>().models.clone();
                tauri::async_runtime::block_on(async move { models.stop().await });
            }
            _ => {}
        });
}

/// Builds the application menu.
///
/// Without one the standard editing shortcuts do not exist, so ⌘C and ⌘V do
/// nothing in a text field -- which matters most in the one field where typing
/// by hand is least likely, the API key.
fn build_app_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let about = AboutMetadata {
        name: Some("Waveform".into()),
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

    let app_menu = Submenu::with_items(
        app,
        "Waveform",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("About Waveform"), Some(about))?,
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
fn handle_menu_action(app: &tauri::AppHandle, id: &str) {
    if id == "microphone-default" {
        select_microphone_from_menu(app, String::new(), String::new());
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
        "toggle-dictation" => {
            let dictation = app.state::<AppState>().dictation.clone();
            tauri::async_runtime::spawn(async move { dictation.toggle_from_app().await });
        }
        "polish" => {
            let dictation = app.state::<AppState>().dictation.clone();
            tauri::async_runtime::spawn(async move { dictation.polish_selection().await });
        }
        "quit" => app.exit(0),
        _ => {}
    }
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
            rebuild_tray(&app);
        }
    });
}

/// Builds the menu bar icon.
fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Waveform", true, None::<&str>)?;
    let polish = MenuItem::with_id(app, "polish", "Polish selection", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Waveform", true, None::<&str>)?;
    let microphone_menu = Submenu::new(app, "Microphone", true)?;
    let state = app.state::<AppState>();
    let settings = state
        .settings
        .try_lock()
        .map(|settings| settings.value())
        .unwrap_or_default();
    let devices = state
        .microphones
        .lock()
        .map(|devices| devices.clone())
        .unwrap_or_default();
    let system_default = CheckMenuItem::with_id(
        app,
        "microphone-default",
        "System default",
        true,
        settings.microphone_device_id.is_empty(),
        None::<&str>,
    )?;
    microphone_menu.append(&system_default)?;
    for (index, device) in devices.iter().enumerate() {
        let item = CheckMenuItem::with_id(
            app,
            format!("microphone-device-{index}"),
            &device.display_label,
            true,
            device.id == settings.microphone_device_id,
            None::<&str>,
        )?;
        microphone_menu.append(&item)?;
    }
    if !settings.microphone_device_id.is_empty()
        && !devices
            .iter()
            .any(|device| device.id == settings.microphone_device_id)
    {
        let name = if settings.microphone_device_name.is_empty() {
            "microphone"
        } else {
            &settings.microphone_device_name
        };
        let unavailable = CheckMenuItem::with_id(
            app,
            "microphone-unavailable",
            format!("Unavailable: {name}"),
            false,
            true,
            None::<&str>,
        )?;
        microphone_menu.append(&unavailable)?;
    }
    let microphone_settings = MenuItem::with_id(
        app,
        "microphone-settings",
        "Microphone settings…",
        true,
        None::<&str>,
    )?;
    microphone_menu.append(&PredefinedMenuItem::separator(app)?)?;
    microphone_menu.append(&microphone_settings)?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &PredefinedMenuItem::separator(app)?,
            &microphone_menu,
            &PredefinedMenuItem::separator(app)?,
            &polish,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    let icon = tauri::image::Image::from_bytes(include_bytes!("../../icons/tray-icon.png"))?;

    TrayIconBuilder::with_id("waveform")
        .icon(icon)
        // A template image is recoloured by macOS to match the menu bar, in
        // light and dark and when the bar is highlighted.
        .icon_as_template(true)
        .menu(&menu)
        // Either button opens the menu. A left click that launched the window
        // instead made the icon behave unlike every other menu bar item, and
        // left no way to reach Quit without knowing to right click.
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| handle_menu_action(app, event.id().as_ref()))
        .build(app)?;
    Ok(())
}

/// WebView commands run off the AppKit thread. Tray mutation must return to it
/// or macOS aborts with a BoardServices threading violation.
fn rebuild_tray(app: &tauri::AppHandle) {
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        app.remove_tray_by_id("waveform");
        let _ = build_tray(&app);
    });
}

/// WebView commands run off the AppKit thread. Creating and removing a menu
/// bar icon must both return to it or macOS terminates the process.
fn set_tray_visibility(app: &tauri::AppHandle, visible: bool) {
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        if visible {
            let _ = build_tray(&app);
        } else {
            app.remove_tray_by_id("waveform");
        }
    });
}

fn set_launch_at_login(app: &tauri::AppHandle, enabled: bool) {
    let manager = app.autolaunch();
    let _ = if enabled {
        manager.enable()
    } else {
        manager.disable()
    };
}

/// How often the cursor is sampled while the HUD is on screen. Fast enough
/// that the pill reacts as a hover should, slow enough to be free.
const OVERLAY_HOVER_POLL_MS: u64 = 60;

/// Where the pointer is over the HUD, in the webview's own coordinates.
#[derive(Clone, Copy, Serialize)]
struct OverlayCursor {
    x: f64,
    y: f64,
}

/**
 * Reports where the pointer is over the HUD, because the HUD cannot see it.
 *
 * WebKit raises `mouseenter` and matches `:hover` from an `NSTrackingArea`
 * that only fires for the key window, or at most the active application. The
 * HUD is neither by construction: it is built non-focusable so it can never
 * steal focus from the app being dictated into, and it is on screen precisely
 * when some other app is frontmost. So no pointer event ever arrives and no
 * `:hover` rule ever matches -- the pill only expanded once a click had been
 * delivered, because clicks do reach the window under the cursor whatever app
 * owns it, and WebKit then synthesises the enter it never sent.
 *
 * A position rather than a yes/no, so the HUD can work out which control the
 * pointer is over and light it up. Emitted only when it changes.
 */
fn watch_overlay_hover(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut last: Option<(i32, i32)> = None;
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(OVERLAY_HOVER_POLL_MS)).await;

            let Some(overlay) = app.get_webview_window(OVERLAY_LABEL) else {
                continue;
            };

            // A hidden HUD cannot be hovered, and asking a hidden window for
            // its bounds is wasted work on every tick it stays hidden.
            let visible = matches!(overlay.is_visible(), Ok(true));
            let next = if visible {
                match (
                    app.cursor_position(),
                    overlay.outer_position(),
                    overlay.outer_size(),
                    overlay.scale_factor(),
                ) {
                    (Ok(cursor), Ok(origin), Ok(size), Ok(scale)) => {
                        let x = cursor.x - origin.x as f64;
                        let y = cursor.y - origin.y as f64;
                        let inside = x >= 0.0
                            && y >= 0.0
                            && x < size.width as f64
                            && y < size.height as f64;
                        inside.then(|| {
                            ((x / scale).round() as i32, (y / scale).round() as i32)
                        })
                    }
                    _ => continue,
                }
            } else {
                None
            };

            if next == last {
                continue;
            }
            last = next;
            app.state::<AppState>()
                .overlay_hovered
                .store(next.is_some(), Ordering::Relaxed);
            let _ = overlay.emit_to(
                OVERLAY_LABEL,
                "overlay-cursor",
                next.map(|(x, y)| OverlayCursor {
                    x: x as f64,
                    y: y as f64,
                }),
            );
        }
    });
}

/// Builds the dictation HUD: frameless, transparent, and never focusable.
fn build_overlay_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    WebviewWindowBuilder::new(
        app,
        OVERLAY_LABEL,
        WebviewUrl::App("overlay.html".into()),
    )
    .title("Waveform listening")
    .inner_size(OVERLAY_WIDTH, OVERLAY_HEIGHT)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .resizable(false)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .skip_taskbar(true)
    // Load-bearing: a focusable HUD would steal focus from the app being
    // dictated into, and the synthetic paste would land in Waveform.
    .focusable(false)
    .focused(false)
    .visible(false)
    .build()?;
    Ok(())
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

/// The directory both hosts keep their settings, stats and model runtime in.
///
/// Tauri's `app_config_dir` would resolve to the bundle identifier, but the
/// Electron build uses the app *name*, and the Qwen runtime installer writes
/// there too. Matching that path is what actually lets one configuration and
/// one downloaded runtime serve either host.
fn user_data_dir(app: &tauri::AppHandle) -> PathBuf {
    if cfg!(target_os = "macos") {
        if let Some(home) = std::env::var_os("HOME") {
            return Path::new(&home)
                .join("Library/Application Support/Waveform");
        }
    }
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
}

/// Locates the repo when running unbundled; scripts/ lives beside it.
fn project_root() -> PathBuf {
    std::env::var("WAVEFORM_PROJECT_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| PathBuf::from("."))
        })
}

use std::path::Path;

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
            "transformOnDictate": true,
            "polishShortcut": "Alt+2",
        });
        let merged = merge_settings(&current, &patch).expect("merges");
        assert!(merged.transform_on_dictate);
        assert_eq!(merged.polish_shortcut, "Alt+2");
        assert_eq!(merged.hotkey_id, "right-option");
    }
}
