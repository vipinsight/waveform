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
    pub hotkey_id: String,
    pub insert_into_focused_app: bool,
    pub hold_ms: u64,
    pub double_tap_ms: u64,
    pub overlay_placement: String,
    pub overlay_x: Option<i32>,
    pub overlay_y: Option<i32>,
    pub theme: String,
    pub open_router_model: String,
    pub transform_on_dictate: bool,
    pub transform_prompt: String,
    pub polish_prompt: String,
    pub polish_shortcut: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            model_id: MODEL_IDS[0].to_string(),
            hotkey_id: "fn".to_string(),
            insert_into_focused_app: true,
            hold_ms: 300,
            double_tap_ms: 420,
            overlay_placement: "bottom".to_string(),
            overlay_x: None,
            overlay_y: None,
            theme: "system".to_string(),
            open_router_model: "anthropic/claude-3.5-haiku".to_string(),
            transform_on_dictate: false,
            transform_prompt: DEFAULT_TRANSFORM_PROMPT.trim().to_string(),
            polish_prompt: DEFAULT_POLISH_PROMPT.trim().to_string(),
            polish_shortcut: "Alt+1".to_string(),
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
            "insertIntoFocusedApp": true,
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
        assert!(body.contains("\"insertIntoFocusedApp\""));
        assert!(!body.contains("model_id"));
    }

    #[test]
    fn restores_a_blanked_prompt() {
        let base = AppSettings::default();
        let mut input = base.clone();
        input.polish_prompt = "   ".into();
        assert_eq!(input.normalize(&base).polish_prompt, base.polish_prompt);
    }
}
