//! Tauri host for Waveform.
//!
//! The window layer -- UI, audio capture, segmentation, the overlay meter -- is
//! shared with the Electron build and reached through the same `window.waveform`
//! surface. This crate supplies that surface natively.

mod gestures;
mod hotkey;
mod dictation;
mod model_server;
mod resources;
mod rewrite;
mod settings;
mod stats;

use dictation::{Dictation, DictationPhrase, DictationStatus, HotkeyStatus};
use model_server::{ModelEvent, ModelServer};
use rewrite::{AiStatus, Rewriter};
use serde::Serialize;
use settings::{AppSettings, SettingsStore};
use stats::{AppStats, StatsStore};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::Mutex;

const OVERLAY_LABEL: &str = "overlay";
const OVERLAY_WIDTH: f64 = 148.0;
const OVERLAY_HEIGHT: f64 = 46.0;
const EDGE_MARGIN: f64 = 88.0;

pub struct AppState {
    settings: Arc<Mutex<SettingsStore>>,
    stats: Arc<Mutex<StatsStore>>,
    models: Arc<ModelServer>,
    dictation: Arc<Dictation>,
    rewriter: Arc<Rewriter>,
    /// Bounds captured when an overlay drag begins, so moves are relative.
    drag_origin: Mutex<Option<(f64, f64)>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MicrophoneResult {
    granted: bool,
    status: String,
}

#[tauri::command]
async fn get_settings(state: State<'_, AppState>) -> Result<AppSettings, String> {
    Ok(state.settings.lock().await.value())
}

#[tauri::command]
async fn update_settings(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    patch: AppSettings,
) -> Result<AppSettings, String> {
    let (previous, next) = {
        let mut settings = state.settings.lock().await;
        let previous = settings.value();
        (previous, settings.update(patch))
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
async fn select_model(state: State<'_, AppState>, model_id: String) -> Result<(), String> {
    state.models.select(&model_id).await
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
        store.update(settings)
    };
    let _ = app.emit("settings-changed", &next);
    Ok(next)
}

/// Positions the overlay from saved coordinates, or centres it on a screen edge.
pub fn place_overlay(overlay: &tauri::WebviewWindow, settings: &AppSettings) {
    if let (Some(x), Some(y)) = (settings.overlay_x, settings.overlay_y) {
        let _ = overlay.set_position(tauri::PhysicalPosition::new(x, y));
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
        .setup(|app| {
            let user_data = user_data_dir(app.handle());
            std::fs::create_dir_all(&user_data).ok();

            let settings = Arc::new(Mutex::new(SettingsStore::load(user_data.clone())));
            let stats = Arc::new(Mutex::new(StatsStore::load(user_data.clone())));
            let initial = tauri::async_runtime::block_on(settings.lock()).value();
            let selected = initial.model_id.clone();

            let handle = app.handle().clone();
            let models = Arc::new(ModelServer::new(
                user_data,
                project_root(),
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
                rewriter.clone(),
            );

            app.manage(AppState {
                settings,
                stats,
                models: models.clone(),
                dictation: dictation.clone(),
                rewriter,
                drag_origin: Mutex::new(None),
            });

            build_overlay_window(app.handle())?;

            let root = project_root();
            tauri::async_runtime::spawn(async move {
                dictation.initialize(root).await;
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
            get_settings,
            update_settings,
            get_stats,
            get_model_state,
            start_model,
            select_model,
            transcribe,
            request_microphone,
            toggle_dictation,
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
        .run(tauri::generate_context!())
        .expect("error while running Waveform");
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
    .focused(false)
    .visible(false)
    .build()?;
    Ok(())
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
