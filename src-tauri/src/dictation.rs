//! Coordinates a dictation session across the helper, the overlay and the app.
//!
//! The overlay window owns the microphone; this decides when it should be
//! listening, what happens to each finished phrase, and how the interface is
//! told about it.

use crate::gestures::{Command, GestureMachine};
use crate::hotkey::{find_helper, key_code_for, HelperEvent, HotkeyHelper};
use crate::model_server::ModelServer;
use crate::rewrite::Rewriter;
use crate::settings::SettingsStore;
use crate::stats::StatsStore;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;
use std::time::Instant;
use tokio::time::{interval, Duration};

const OVERLAY_LABEL: &str = "overlay";
const MAIN_LABEL: &str = "main";
/// The gesture machine's tap window has to be polled; this is fine-grained
/// enough that a released tap is never perceptibly late.
const TICK: Duration = Duration::from_millis(50);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyStatus {
    pub supported: bool,
    pub running: bool,
    pub tap_active: bool,
    pub accessibility: bool,
    pub input_monitoring: bool,
    /// "granted", "denied", "restricted", "not-determined" or "unknown".
    pub microphone: String,
    pub binding: String,
    /// Whether the selected speech engine is installed on this machine.
    pub engine_installed: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DictationCommand {
    action: String,
    sink: String,
    mode: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationStatus {
    pub state: String,
    #[serde(default = "default_sink")]
    pub sink: String,
    #[serde(default = "default_mode")]
    pub mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

fn default_sink() -> String {
    "insert".into()
}
fn default_mode() -> String {
    "hold".into()
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationPhrase {
    pub text: String,
    #[serde(default = "default_sink")]
    pub sink: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DictationUpdate {
    status: DictationStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    phrase: Option<DictationPhrase>,
}

#[derive(Clone)]
struct Session {
    sink: String,
    mode: String,
}

pub struct Dictation {
    app: AppHandle,
    settings: Arc<Mutex<SettingsStore>>,
    stats: Arc<Mutex<StatsStore>>,
    rewriter: Arc<Rewriter>,
    models: Arc<ModelServer>,
    helper: Arc<HotkeyHelper>,
    gestures: Mutex<GestureMachine>,
    session: Mutex<Option<Session>>,
    status: Mutex<HotkeyStatus>,
    polishing: Mutex<bool>,
    /// Set when Escape arrives mid-polish. The request itself cannot be
    /// recalled, but its result must not be pasted after the user backed out.
    polish_cancelled: Mutex<bool>,
    /// The system Accessibility dialog is shown once per run at most; macOS
    /// only presents it the first time anyway, and repeating it is noise.
    accessibility_prompted: Mutex<bool>,
    /// Accelerators currently bound, so each can be released individually.
    /// Releasing all of them would drop Escape along with the polish key.
    polish_accelerator: Mutex<Option<String>>,
    escape_bound: Mutex<bool>,
    /// The key the helper is watching, used to reject stray events.
    watched_key: Mutex<Option<i64>>,
}

impl Dictation {
    pub fn new(
        app: AppHandle,
        settings: Arc<Mutex<SettingsStore>>,
        stats: Arc<Mutex<StatsStore>>,
        rewriter: Arc<Rewriter>,
        models: Arc<ModelServer>,
    ) -> Arc<Self> {
        Arc::new(Self {
            app,
            settings,
            stats,
            rewriter,
            models,
            helper: HotkeyHelper::new(),
            gestures: Mutex::new(GestureMachine::new(300, 420)),
            session: Mutex::new(None),
            status: Mutex::new(HotkeyStatus {
                supported: cfg!(target_os = "macos"),
                running: false,
                tap_active: false,
                accessibility: false,
                input_monitoring: false,
                microphone: "unknown".into(),
                binding: "none".into(),
                engine_installed: false,
            }),
            polishing: Mutex::new(false),
            polish_cancelled: Mutex::new(false),
            accessibility_prompted: Mutex::new(false),
            polish_accelerator: Mutex::new(None),
            escape_bound: Mutex::new(false),
            watched_key: Mutex::new(None),
        })
    }

    pub async fn status(&self) -> HotkeyStatus {
        self.snapshot().await
    }

    /// The stored status with the live fields filled in.
    ///
    /// Engine installation is checked rather than remembered, because it can
    /// change while the app is open. Every path that reports status goes
    /// through here; emitting the stored value directly would push a stale
    /// `engine_installed` over a correct one.
    async fn snapshot(&self) -> HotkeyStatus {
        let mut status = self.status.lock().await.clone();
        status.engine_installed = self.models.is_installed().await;
        status
    }

    pub async fn initialize(self: &Arc<Self>, project_root: PathBuf) {
        let resource_dir = self.app.path().resource_dir().ok();
        let Some(binary) = find_helper(resource_dir.as_deref(), &project_root) else {
            self.patch_status(|status| status.supported = false).await;
            return;
        };

        let listener = self.clone();
        if self
            .helper
            .start(binary, move |event| {
                let handler = listener.clone();
                tauri::async_runtime::spawn(async move {
                    handler.handle_helper_event(event).await;
                });
            })
            .await
            .is_err()
        {
            self.patch_status(|status| status.supported = false).await;
            return;
        }

        self.patch_status(|status| status.running = true).await;
        self.apply_settings().await;
        self.spawn_tick_loop();
    }

    /// Re-reads timings and the binding after settings change.
    pub async fn apply_settings(self: &Arc<Self>) {
        let settings = self.settings.lock().await.value();
        *self.gestures.lock().await =
            GestureMachine::new(settings.hold_ms, settings.double_tap_ms);

        let watched = key_code_for(&settings.hotkey_id);
        *self.watched_key.lock().await = watched;
        match watched {
            Some(code) => self.helper.watch(code).await,
            None => self.helper.unwatch().await,
        }
        self.apply_polish_shortcut(&settings.polish_shortcut).await;
        self.patch_status(|status| status.binding = settings.hotkey_id.clone())
            .await;
    }

    /// A lone tap only becomes a discard once its window closes, so the machine
    /// has to be polled rather than purely event-driven.
    fn spawn_tick_loop(self: &Arc<Self>) {
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut ticker = interval(TICK);
            loop {
                ticker.tick().await;
                let command = this.gestures.lock().await.tick(Instant::now());
                if let Some(command) = command {
                    this.run_command(command).await;
                }
            }
        });
    }

    async fn handle_helper_event(self: &Arc<Self>, event: HelperEvent) {
        match event {
            HelperEvent::Ready => {
                let running = self.helper.is_running().await;
                self.patch_status(|status| status.running = running).await;
                self.apply_settings().await;
            }
            HelperEvent::Key { phase, key_code } => {
                // The helper already filters, but a stale watch could still
                // deliver the wrong key after a binding change.
                if *self.watched_key.lock().await != Some(key_code) {
                    return;
                }
                let now = Instant::now();
                let command = {
                    let mut gestures = self.gestures.lock().await;
                    if phase == "down" {
                        gestures.key_down(now)
                    } else {
                        gestures.key_up(now)
                    }
                };
                if let Some(command) = command {
                    self.run_command(command).await;
                }
            }
            HelperEvent::Tap {
                active,
                listening,
                reason,
            } => {
                if !active {
                    if let Some(reason) = reason {
                        eprintln!("hotkey tap inactive: {reason}");
                    }
                }
                // Report whether the shortcut can actually fire, not merely
                // whether a tap object was created.
                self.patch_status(|status| status.tap_active = active && listening)
                    .await;
            }
            HelperEvent::Permissions {
                accessibility,
                input_monitoring,
                microphone,
            } => {
                self.patch_status(|status| {
                    status.accessibility = accessibility;
                    status.input_monitoring = input_monitoring;
                    status.microphone = microphone;
                })
                .await;
            }
            HelperEvent::Paste { ok, reason } => {
                if ok {
                    return;
                }
                // Dictation appears to work and then nothing arrives, which
                // reads as the app being broken rather than as a permission
                // that was never granted. Say so, and offer the system dialog.
                if reason.as_deref() == Some("accessibility") {
                    self.helper.refresh_permissions().await;
                    self.report_error(
                        "Waveform needs Accessibility permission to paste into other apps. \
                         Grant it in Settings → Shortcut.",
                    )
                    .await;
                    self.show_overlay().await;
                    self.send_to_overlay("fail", "insert", "hold").await;

                    let mut prompted = self.accessibility_prompted.lock().await;
                    if !*prompted {
                        *prompted = true;
                        self.helper.request_permission("accessibility").await;
                    }
                }
            }
            HelperEvent::Selection { .. } => {}
        }
    }

    async fn run_command(self: &Arc<Self>, command: Command) {
        match command {
            Command::Start => self.begin_session("insert", "hold").await,
            Command::Latch => self.promote_to_latched().await,
            Command::Commit => self.end_session("stop").await,
            Command::Discard => self.end_session("cancel").await,
        }
    }

    /// The in-app Start/Stop button: same pipeline, text stays in the app.
    pub async fn toggle_from_app(self: &Arc<Self>) {
        if self.session.lock().await.is_some() {
            // Route through the machine so a latched gesture is cleared too.
            self.gestures.lock().await.stop();
            self.end_session("stop").await;
            return;
        }
        self.begin_session("transcript", "latched").await;
    }

    pub async fn preview_indicator(self: &Arc<Self>) {
        self.show_overlay().await;
        self.send_to_overlay("preview", "transcript", "hold").await;
    }

    async fn begin_session(self: &Arc<Self>, sink: &str, mode: &str) {
        {
            let mut session = self.session.lock().await;
            if session.is_some() {
                return;
            }
            *session = Some(Session {
                sink: sink.into(),
                mode: mode.into(),
            });
        }

        let updated = self.stats.lock().await.record_session();
        let _ = self.app.emit("stats-changed", updated);

        // Start the engine alongside the microphone rather than before it. The
        // model is only needed once a phrase completes, so loading it here
        // costs nothing at the start of a session and nothing at all until the
        // first one. Stage changes drive the interface's loading state.
        let models = self.models.clone();
        tauri::async_runtime::spawn(async move {
            let _ = models.start().await;
        });

        self.show_overlay().await;
        self.send_to_overlay("start", sink, mode).await;
        self.capture_escape().await;
    }

    async fn promote_to_latched(self: &Arc<Self>) {
        let sink = {
            let mut session = self.session.lock().await;
            let Some(current) = session.as_mut() else { return };
            current.mode = "latched".into();
            current.sink.clone()
        };
        self.send_to_overlay("start", &sink, "latched").await;
    }

    async fn end_session(self: &Arc<Self>, action: &str) {
        let Some(session) = self.session.lock().await.take() else {
            return;
        };
        self.release_escape().await;
        self.send_to_overlay(action, &session.sink, &session.mode)
            .await;
    }

    /// Escape abandons a dictation without inserting anything.
    ///
    /// Bound only while a session runs: holding it permanently would take
    /// Escape from every other app.
    async fn capture_escape(self: &Arc<Self>) {
        use tauri_plugin_global_shortcut::GlobalShortcutExt;
        let mut bound = self.escape_bound.lock().await;
        if *bound {
            return;
        }

        let this = self.clone();
        let registered = self
            .app
            .global_shortcut()
            .on_shortcut("Escape", move |_app, _shortcut, event| {
                if event.state() != tauri_plugin_global_shortcut::ShortcutState::Pressed {
                    return;
                }
                let handler = this.clone();
                tauri::async_runtime::spawn(async move {
                    if *handler.polishing.lock().await {
                        *handler.polish_cancelled.lock().await = true;
                        return;
                    }
                    let command = handler.gestures.lock().await.cancel();
                    if command.is_some() {
                        handler.end_session("cancel").await;
                    }
                });
            })
            .is_ok();
        *bound = registered;
    }

    async fn release_escape(&self) {
        use tauri_plugin_global_shortcut::GlobalShortcutExt;
        let mut bound = self.escape_bound.lock().await;
        if !*bound {
            return;
        }
        let _ = self.app.global_shortcut().unregister("Escape");
        *bound = false;
    }

    /// Binds the polish accelerator, releasing only the previous one.
    pub async fn apply_polish_shortcut(&self, accelerator: &str) {
        use tauri_plugin_global_shortcut::GlobalShortcutExt;
        let mut current = self.polish_accelerator.lock().await;
        if current.as_deref() == Some(accelerator) {
            return;
        }
        if let Some(previous) = current.take() {
            let _ = self.app.global_shortcut().unregister(previous.as_str());
        }
        if accelerator == "none" {
            return;
        }

        let app = self.app.clone();
        let registered = self
            .app
            .global_shortcut()
            .on_shortcut(accelerator, move |_app, _shortcut, event| {
                if event.state() != tauri_plugin_global_shortcut::ShortcutState::Pressed {
                    return;
                }
                let dictation = app.state::<crate::AppState>().dictation.clone();
                tauri::async_runtime::spawn(async move {
                    dictation.polish_selection().await;
                });
            })
            .is_ok();
        if registered {
            *current = Some(accelerator.to_string());
        } else {
            eprintln!("could not bind the polish shortcut {accelerator}; another app may own it");
        }
    }

    pub async fn on_overlay_state(self: &Arc<Self>, status: DictationStatus) {
        if status.state == "idle" {
            self.hide_overlay();
            if self.session.lock().await.take().is_some() {
                // The overlay stopped on its own, e.g. a device error; resync.
                self.gestures.lock().await.reset();
            }
        }
        let _ = self.app.emit_to(
            MAIN_LABEL,
            "dictation-update",
            DictationUpdate {
                status,
                phrase: None,
            },
        );
    }

    pub async fn on_overlay_phrase(self: &Arc<Self>, phrase: DictationPhrase) {
        let trimmed = phrase.text.trim().to_string();
        if trimmed.is_empty() {
            return;
        }

        // A failed rewrite falls back to the raw transcript rather than dropping
        // what was just said.
        let mut text = trimmed.clone();
        if phrase.sink == "insert" {
            match self.rewriter.clean_up_dictation(&trimmed).await {
                Ok(Some(cleaned)) => text = cleaned,
                Ok(None) => {}
                Err(message) => self.report_error(&message).await,
            }
        }

        let insert = self.settings.lock().await.value().insert_into_focused_app;
        if phrase.sink == "insert" && insert {
            self.helper.paste(&format!("{text} ")).await;
        }

        let updated = self.stats.lock().await.record_phrase(&text);
        let _ = self.app.emit("stats-changed", updated);

        let active = self.session.lock().await.is_some();
        let _ = self.app.emit_to(
            MAIN_LABEL,
            "dictation-update",
            DictationUpdate {
                status: DictationStatus {
                    state: if active { "listening".into() } else { "idle".into() },
                    sink: phrase.sink.clone(),
                    mode: "hold".into(),
                    message: None,
                },
                phrase: Some(DictationPhrase {
                    text,
                    sink: phrase.sink,
                }),
            },
        );
    }

    /// Rewrites whatever is selected in the focused app, in place.
    pub async fn polish_selection(self: &Arc<Self>) {
        if *self.polishing.lock().await {
            return;
        }
        if self.session.lock().await.is_some() {
            self.report_error("Finish dictating before polishing.").await;
            return;
        }
        if !self.rewriter.is_configured().await {
            self.report_error("Add an OpenRouter API key in Settings first.")
                .await;
            self.show_overlay().await;
            self.send_to_overlay("fail", "insert", "hold").await;
            return;
        }

        *self.polishing.lock().await = true;
        *self.polish_cancelled.lock().await = false;
        self.show_overlay().await;
        self.send_to_overlay("busy", "insert", "hold").await;
        self.capture_escape().await;

        let outcome = async {
            let selection = self.helper.request_selection().await?;
            let polished = self.rewriter.polish(&selection).await?;
            if *self.polish_cancelled.lock().await {
                return Err("Cancelled.".to_string());
            }
            if polished != selection {
                self.helper.paste(&polished).await;
            }
            Ok::<(), String>(())
        }
        .await;

        self.release_escape().await;

        match outcome {
            Ok(()) => self.send_to_overlay("stop", "insert", "hold").await,
            Err(message) if message == "Cancelled." => {
                self.send_to_overlay("cancel", "insert", "hold").await;
            }
            Err(message) => {
                self.send_to_overlay("fail", "insert", "hold").await;
                self.report_error(&message).await;
            }
        }

        *self.polishing.lock().await = false;
    }

    pub async fn request_permission(&self, scope: &str) {
        self.helper.request_permission(scope).await;
    }

    pub async fn refresh_permissions(&self) {
        self.helper.refresh_permissions().await;
    }

    async fn show_overlay(&self) {
        let settings = self.settings.lock().await.value();
        let Some(overlay) = self.app.get_webview_window(OVERLAY_LABEL) else {
            return;
        };
        crate::place_overlay(&overlay, &settings);
        // Never focus it: focus must stay with the app being dictated into, or
        // the synthetic paste lands in Waveform.
        let _ = overlay.show();
        let _ = overlay.set_always_on_top(true);
    }

    fn hide_overlay(&self) {
        if let Some(overlay) = self.app.get_webview_window(OVERLAY_LABEL) {
            let _ = overlay.hide();
        }
    }

    async fn send_to_overlay(&self, action: &str, sink: &str, mode: &str) {
        let _ = self.app.emit_to(
            OVERLAY_LABEL,
            "dictation-command",
            DictationCommand {
                action: action.into(),
                sink: sink.into(),
                mode: mode.into(),
            },
        );
    }

    async fn report_error(&self, message: &str) {
        let _ = self.app.emit_to(
            MAIN_LABEL,
            "dictation-update",
            DictationUpdate {
                status: DictationStatus {
                    state: "error".into(),
                    sink: "insert".into(),
                    mode: "hold".into(),
                    message: Some(message.into()),
                },
                phrase: None,
            },
        );
    }

    async fn patch_status<F: FnOnce(&mut HotkeyStatus)>(&self, patch: F) {
        {
            let mut status = self.status.lock().await;
            patch(&mut status);
        }
        let next = self.snapshot().await;
        let _ = self.app.emit_to(MAIN_LABEL, "hotkey-status-changed", next);
    }
}
