//! Persisted preferences.
//!
//! The on-disk shape is deliberately identical to the Electron build's
//! settings.json, so the same file serves either host and a user switching
//! between them keeps their configuration.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

pub const POLISH_SHORTCUTS: [&str; 5] = ["none", "Alt+1", "Alt+2", "Alt+3", "Alt+P"];
const HOTKEY_IDS: [&str; 8] = [
    "none",
    "fn",
    "right-command",
    "left-command",
    "right-option",
    "left-option",
    "right-control",
    "right-shift",
];
const MODEL_IDS: [&str; 2] = ["parakeet-tdt-0.6b-v3", "qwen3-asr-0.6b"];

pub const DEFAULT_TRANSFORM_PROMPT: &str = include_str!("prompts/transform.txt");
pub const DEFAULT_POLISH_PROMPT: &str = include_str!("prompts/polish.txt");

/// Serialized as camelCase so one settings.json serves both hosts and the
/// shape matches what the shared frontend expects.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AppSettings {
    pub model_id: String,
    /// Empty means follow macOS's current default input device.
    pub microphone_device_id: String,
    /// Human-readable label shown in the tray while the main window is hidden.
    pub microphone_device_name: String,
    pub hotkey_id: String,
    pub hold_ms: u64,
    pub double_tap_ms: u64,
    pub overlay_placement: String,
    pub overlay_x: Option<i32>,
    pub overlay_y: Option<i32>,
    /// Where the pill's centre sat inside the window when `overlay_x`/
    /// `overlay_y` were recorded. A saved frame only points at the same spot on
    /// screen if this is known, because the window has to grow around the pill
    /// to make room for its tooltips.
    pub overlay_cx: Option<f64>,
    pub overlay_cy: Option<f64>,
    pub theme: String,
    pub open_router_model: String,
    pub transform_on_dictate: bool,
    pub transform_prompt: String,
    pub polish_prompt: String,
    pub polish_shortcut: String,
    /// Show a menu bar icon, which is the only way back to a closed window
    /// when the Dock icon is hidden.
    pub menu_bar_icon: bool,
    /// Register Waveform as a login item for the current macOS user.
    pub launch_at_login: bool,
    /// Keep the compact listening indicator visible while not dictating.
    pub show_flow_bar_always: bool,
    /// Drop out of the Dock while the window is closed, leaving only the menu
    /// bar icon. Ignored unless `menu_bar_icon` is on, or the app would have
    /// no visible presence at all.
    pub hide_dock_when_closed: bool,
    /// Whether the sidebar is folded away. A window preference rather than a
    /// dictation one, but it belongs with the rest so it survives a restart.
    pub sidebar_collapsed: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            model_id: MODEL_IDS[0].to_string(),
            microphone_device_id: String::new(),
            microphone_device_name: String::new(),
            hotkey_id: "fn".to_string(),
            hold_ms: 300,
            double_tap_ms: 420,
            overlay_placement: "bottom".to_string(),
            overlay_x: None,
            overlay_y: None,
            overlay_cx: None,
            overlay_cy: None,
            theme: "system".to_string(),
            open_router_model: "anthropic/claude-3.5-haiku".to_string(),
            transform_on_dictate: false,
            transform_prompt: DEFAULT_TRANSFORM_PROMPT.trim().to_string(),
            polish_prompt: DEFAULT_POLISH_PROMPT.trim().to_string(),
            polish_shortcut: "Alt+1".to_string(),
            menu_bar_icon: true,
            launch_at_login: false,
            show_flow_bar_always: false,
            hide_dock_when_closed: false,
            sidebar_collapsed: false,
        }
    }
}

impl AppSettings {
    /// Rebuilds a valid value field by field, falling back to `base`.
    ///
    /// Applies to both the file on disk and patches from the frontend, so a
    /// corrupt file or a stale window can never put the app in a broken state.
    pub fn normalize(mut self, base: &AppSettings) -> Self {
        if !MODEL_IDS.contains(&self.model_id.as_str()) {
            self.model_id = base.model_id.clone();
        }
        self.microphone_device_id = bounded_text(&self.microphone_device_id, 1_024);
        self.microphone_device_name = bounded_text(&self.microphone_device_name, 200);
        if !HOTKEY_IDS.contains(&self.hotkey_id.as_str()) {
            self.hotkey_id = base.hotkey_id.clone();
        }
        // A global accelerator is taken from every other app, so only the
        // offered combinations may ever reach the shortcut manager.
        if !POLISH_SHORTCUTS.contains(&self.polish_shortcut.as_str()) {
            self.polish_shortcut = base.polish_shortcut.clone();
        }
        if !matches!(self.overlay_placement.as_str(), "top" | "bottom") {
            self.overlay_placement = base.overlay_placement.clone();
        }
        if !matches!(self.theme.as_str(), "system" | "light" | "dark") {
            self.theme = base.theme.clone();
        }
        self.hold_ms = self.hold_ms.clamp(120, 900);
        self.double_tap_ms = self.double_tap_ms.clamp(180, 900);
        self.open_router_model = non_empty(&self.open_router_model, &base.open_router_model, 200);
        self.transform_prompt = non_empty(&self.transform_prompt, &base.transform_prompt, 8_000);
        self.polish_prompt = non_empty(&self.polish_prompt, &base.polish_prompt, 8_000);
        // Leaving the Dock with no menu bar icon would strand the app with no
        // way to reach it, so the two settings are not independent.
        if !self.menu_bar_icon {
            self.hide_dock_when_closed = false;
        }
        self
    }
}

/// Blank text falls back, so a field cannot be lost by clearing an input.
fn non_empty(value: &str, fallback: &str, max_len: usize) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return fallback.to_string();
    }
    trimmed.chars().take(max_len).collect()
}

/// Empty is valid for a microphone id: it means system default.
fn bounded_text(value: &str, max_len: usize) -> String {
    value.trim().chars().take(max_len).collect()
}

pub struct SettingsStore {
    path: PathBuf,
    current: AppSettings,
}

impl SettingsStore {
    pub fn load(dir: PathBuf) -> Self {
        let path = dir.join("settings.json");
        let current = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<AppSettings>(&raw).ok())
            .map(|parsed| parsed.normalize(&AppSettings::default()))
            .unwrap_or_default();
        Self { path, current }
    }

    pub fn value(&self) -> AppSettings {
        self.current.clone()
    }

    pub fn update(&mut self, patch: AppSettings) -> AppSettings {
        self.current = patch.normalize(&self.current);
        self.write();
        self.current.clone()
    }

    fn write(&self) {
        if let Some(parent) = self.path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(body) = serde_json::to_string_pretty(&self.current) {
            // Settings are not worth crashing over; they stay in memory.
            let _ = fs::write(&self.path, format!("{body}\n"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_an_unknown_hotkey() {
        let base = AppSettings::default();
        let mut input = base.clone();
        input.hotkey_id = "f13".into();
        assert_eq!(input.normalize(&base).hotkey_id, base.hotkey_id);
    }

    #[test]
    fn keeps_an_optional_microphone_selection() {
        let base = AppSettings::default();
        let mut selected = base.clone();
        selected.microphone_device_id = "built-in-mic-id".into();
        selected.microphone_device_name = "MacBook Pro Microphone".into();
        let selected = selected.normalize(&base);
        assert_eq!(selected.microphone_device_id, "built-in-mic-id");

        let mut defaulted = selected.clone();
        defaulted.microphone_device_id.clear();
        defaulted.microphone_device_name.clear();
        let defaulted = defaulted.normalize(&selected);
        assert!(defaulted.microphone_device_id.is_empty());
    }

    #[test]
    fn only_accepts_offered_polish_shortcuts() {
        let base = AppSettings::default();
        let mut input = base.clone();
        input.polish_shortcut = "Cmd+Q".into();
        assert_eq!(input.normalize(&base).polish_shortcut, "Alt+1");

        let mut allowed = base.clone();
        allowed.polish_shortcut = "Alt+2".into();
        assert_eq!(allowed.normalize(&base).polish_shortcut, "Alt+2");
    }

    #[test]
    fn clamps_timings() {
        let base = AppSettings::default();
        let mut input = base.clone();
        input.hold_ms = 5;
        assert_eq!(input.clone().normalize(&base).hold_ms, 120);
        input.hold_ms = 99_999;
        assert_eq!(input.normalize(&base).hold_ms, 900);
    }

    /// The Electron build writes this file; both hosts must read each other's.
    #[test]
    fn reads_a_camel_case_settings_file() {
        let raw = r#"{
            "modelId": "qwen3-asr-0.6b",
            "hotkeyId": "right-option",
            "insertIntoFocusedApp": false,
            "holdMs": 200,
            "doubleTapMs": 420,
            "overlayPlacement": "bottom",
            "overlayX": null,
            "overlayY": null,
            "theme": "light",
            "polishShortcut": "Alt+1"
        }"#;
        let parsed: AppSettings = serde_json::from_str(raw).expect("parses");
        let settings = parsed.normalize(&AppSettings::default());
        assert_eq!(settings.model_id, "qwen3-asr-0.6b");
        assert_eq!(settings.hotkey_id, "right-option");
        assert_eq!(settings.hold_ms, 200);
        assert_eq!(settings.theme, "light");
    }

    #[test]
    fn writes_camel_case_keys() {
        let body = serde_json::to_string(&AppSettings::default()).expect("serializes");
        assert!(body.contains("\"modelId\""));
        assert!(!body.contains("\"insertIntoFocusedApp\""));
        assert!(body.contains("\"launchAtLogin\""));
        assert!(body.contains("\"showFlowBarAlways\""));
        assert!(!body.contains("model_id"));
    }

    /// The app must always keep at least one way back to its window.
    #[test]
    fn hiding_the_dock_requires_a_menu_bar_icon() {
        let base = AppSettings::default();
        let mut input = base.clone();
        input.menu_bar_icon = false;
        input.hide_dock_when_closed = true;

        let settings = input.normalize(&base);
        assert!(!settings.hide_dock_when_closed);
    }

    #[test]
    fn keeps_the_dock_setting_when_the_menu_bar_icon_is_on() {
        let base = AppSettings::default();
        let mut input = base.clone();
        input.menu_bar_icon = true;
        input.hide_dock_when_closed = true;

        assert!(input.normalize(&base).hide_dock_when_closed);
    }

    #[test]
    fn restores_a_blanked_prompt() {
        let base = AppSettings::default();
        let mut input = base.clone();
        input.polish_prompt = "   ".into();
        assert_eq!(input.normalize(&base).polish_prompt, base.polish_prompt);
    }
}
