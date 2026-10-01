//! What every command and menu reaches for: the stores, the engines and the
//! handful of flags that have to be readable from the main thread.

use crate::dictation::Dictation;
use crate::dictionary::DictionaryStore;
use crate::history::HistoryStore;
use crate::local_llm::LocalDownloads;
use crate::logs::Logs;
use crate::meeting::Recorder;
use crate::mic::NativeCapture;
use crate::model_server::ModelServer;
use crate::rewrite::Rewriter;
use crate::settings::SettingsStore;
use crate::stats::StatsStore;
use crate::transcribe::Engine;
use serde::Deserialize;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::Mutex;

pub struct AppState {
    pub(crate) settings: Arc<Mutex<SettingsStore>>,
    pub(crate) logs: Arc<Logs>,
    pub(crate) stats: Arc<Mutex<StatsStore>>,
    pub(crate) history: Arc<Mutex<HistoryStore>>,
    pub(crate) dictionary: Arc<Mutex<DictionaryStore>>,
    pub(crate) engine: Engine,
    pub(crate) recorder: Arc<Recorder>,
    pub(crate) models: Arc<ModelServer>,
    pub(crate) dictation: Arc<Dictation>,
    pub(crate) rewriter: Arc<Rewriter>,
    /// Fetches the models the local polish engine runs.
    pub(crate) polish_downloads: Arc<LocalDownloads>,
    /// Bounds captured when an overlay drag begins, so moves are relative.
    pub(crate) drag_origin: Mutex<Option<(f64, f64)>>,
    /// Set once a quit has stopped the meeting, so the second exit goes through.
    pub(crate) quitting_after_stop: AtomicBool,
    /// Mirrors the setting of the same name.
    ///
    /// Window events arrive on the main thread, where blocking on the async
    /// settings lock could deadlock against a task already holding it. Closing
    /// a window is the worst possible place to risk that, so this one flag is
    /// kept where it can be read without waiting.
    pub(crate) hide_dock_when_closed: AtomicBool,
    /// WebKit enumerates input devices; the tray uses this cached list when
    /// Waveform's main window is closed.
    pub(crate) microphones: StdMutex<Vec<MicrophoneDevice>>,
    /// Whether the pointer is over the HUD, from `watch_overlay_hover`. Read
    /// on the main thread while handling reopen, so it cannot be a lock.
    pub(crate) overlay_hovered: AtomicBool,
    /// The part of the HUD's window that is actually the pill, reported by the
    /// HUD itself because the shape is decided in CSS. Everything outside it is
    /// made click-through.
    pub(crate) overlay_hit_region: StdMutex<Option<(f64, f64, f64, f64)>>,
    pub(crate) capture: Arc<NativeCapture>,
}

#[derive(Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MicrophoneDevice {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) display_label: String,
}
