//! Persisted preferences.
//!
//! The on-disk shape is deliberately identical to the Electron build's
//! settings.json, so the same file serves either host and a user switching
//! between them keeps their configuration.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

pub const POLISH_SHORTCUTS: [&str; 5] = ["none", "Alt+1", "Alt+2", "Alt+3", "Alt+P"];
/// How much a dictation may be changed before it is inserted. Kept in step
/// with src/shared/polish-levels.ts, which is where what each one means lives.
pub const POLISH_LEVELS: [&str; 3] = ["none", "light", "medium"];
const HOTKEY_IDS: [&str; 7] = [
    "none",
    "fn",
    "right-command",
    "left-command",
    "right-option",
    "left-option",
    "right-shift",
];
/// The models the engine actually knows about.
///
/// Read from the engine's own table rather than repeated here: a hand-kept
/// copy that fell behind is what silently reverted every attempt to choose
/// Whisper, because `normalize` treated a real model id as corrupt input.
fn is_known_model(id: &str) -> bool {
    crate::model_server::MODELS.iter().any(|model| model.id == id)
}

/// Kept in step with src/shared/languages.ts. ISO 639-1, which is what all
/// three engines take; empty asks the engine to detect.
const SPEECH_LANGUAGES: [&str; 14] = [
    "", "en", "hi", "es", "fr", "de", "it", "pt", "nl", "ru", "ar", "ja", "ko", "zh",
];

fn default_model_id() -> &'static str {
    crate::model_server::DEFAULT_MODEL_ID
}

pub const DEFAULT_TRANSFORM_PROMPT: &str = include_str!("prompts/transform.txt");
pub const DEFAULT_POLISH_PROMPT: &str = include_str!("prompts/polish.txt");

/// Kept in step with src/shared/prompts.ts, which is where the list the
/// interface offers lives and why these particular ids were chosen.
pub const DEFAULT_OPENROUTER_MODEL: &str = "openai/gpt-4.1-mini";
/// Defaults that turned out not to name a model OpenRouter serves.
pub const RETIRED_OPENROUTER_MODELS: [&str; 1] = ["anthropic/claude-3.5-haiku"];
/// Defaults nobody chose, replaced on load wherever they are still stored
/// unedited. A default is not a preference worth preserving.
///
/// The first dictation prompt predates the rules about how spoken numbers and
/// times are written down. The second still rewrote grammar and phrasing.
pub const RETIRED_TRANSFORM_PROMPTS: [&str; 2] = [
    include_str!("prompts/transform-retired.txt"),
    include_str!("prompts/transform-retired-grammar.txt"),
];
/// Polish prompts nobody chose. The first was a copy editor; the second tidied
/// dictation rather than fixing anything, which is the wrong job for text
/// somebody typed and selected -- and far more instruction than a local model
/// half a gigabyte wide can hold.
pub const RETIRED_POLISH_PROMPTS: [&str; 2] = [
    include_str!("prompts/polish-retired.txt"),
    include_str!("prompts/polish-retired-dictation.txt"),
];

/// Serialized as camelCase so one settings.json serves both hosts and the
/// shape matches what the shared frontend expects.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AppSettings {
    pub model_id: String,
    /// Language handed to the speech model. Empty asks it to detect, which on a
    /// single dictated phrase it does unreliably.
    pub speech_language: String,
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
    /// Where a rewrite runs: "openrouter" for the hosted models, or "local"
    /// for a model downloaded onto this Mac.
    pub polish_engine: String,
    pub open_router_model: String,
    /// Which downloaded model rewrites when the engine is "local". Kept
    /// whether or not that engine is selected, so switching back does not
    /// forget the choice.
    pub local_model_id: String,
    /// How much the model may change a dictation: "none", "light" or "medium".
    ///
    /// Defaulted to empty rather than to a level, because empty is how a
    /// settings file written before levels existed is recognised -- and such a
    /// file has a `transform_on_dictate` that has to decide the level instead.
    /// `normalize` never leaves it empty.
    #[serde(default)]
    pub polish_level: String,
    /// Whether a dictation is run through the model at all.
    ///
    /// Derived from `polish_level` by `normalize` rather than set, so the two
    /// cannot disagree. It is kept because it is the question the dictation
    /// and rewrite paths actually ask, and because it is all an older settings
    /// file carries.
    pub transform_on_dictate: bool,
    /// The instruction the dictation path runs, at whichever level is
    /// selected. Choosing a level writes that level's default here; the
    /// Instructions editor overwrites it.
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
    /// Look for a new version on launch, and once a day after that.
    ///
    /// The only request Waveform makes that nobody asked for, which is the
    /// reason it can be turned off. Pressing Check now still checks.
    pub automatic_update_check: bool,
    /// Whether the sidebar is folded away. A window preference rather than a
    /// dictation one, but it belongs with the rest so it survives a restart.
    pub sidebar_collapsed: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            model_id: default_model_id().to_string(),
            speech_language: "en".to_string(),
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
            // The hosted engine, because this field arrived after the app did:
            // a settings file written before it exists takes the default, and
            // for everyone already polishing through OpenRouter that has to be
            // the engine they were already using.
            polish_engine: "openrouter".to_string(),
            open_router_model: DEFAULT_OPENROUTER_MODEL.to_string(),
            local_model_id: crate::local_llm::DEFAULT_LOCAL_MODEL_ID.to_string(),
            // Off, because this is the one setting that changes the words
            // somebody is about to paste into their own document.
            polish_level: "none".to_string(),
            transform_on_dictate: false,
            transform_prompt: DEFAULT_TRANSFORM_PROMPT.trim().to_string(),
            polish_prompt: DEFAULT_POLISH_PROMPT.trim().to_string(),
            polish_shortcut: "Alt+1".to_string(),
            menu_bar_icon: true,
            launch_at_login: false,
            show_flow_bar_always: false,
            hide_dock_when_closed: false,
            automatic_update_check: true,
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
        if !is_known_model(&self.model_id) {
            self.model_id = base.model_id.clone();
        }
        if !SPEECH_LANGUAGES.contains(&self.speech_language.as_str()) {
            self.speech_language = base.speech_language.clone();
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
        if !matches!(self.polish_engine.as_str(), "openrouter" | "local") {
            self.polish_engine = base.polish_engine.clone();
        }
        // Read from the engine's own table rather than repeated here, for the
        // same reason as the speech models: a copy that fell behind would
        // silently revert every attempt to choose a model it had not heard of.
        if !crate::local_llm::is_known(&self.local_model_id) {
            self.local_model_id = base.local_model_id.clone();
        }
        // A file written before levels existed names no level, only the switch
        // this replaced. Switched on, that switch removed filler and fixed
        // punctuation, which is the light level -- so that is what it becomes,
        // rather than everyone who had polish on losing it to the default.
        if self.polish_level.is_empty() {
            let was_on = self.transform_on_dictate;
            self.polish_level = if was_on { "light" } else { "none" }.to_string();
        }
        if !POLISH_LEVELS.contains(&self.polish_level.as_str()) {
            self.polish_level = base.polish_level.clone();
        }
        // Derived, never taken from the input: the level is the setting, and
        // this is what it means to everything that only needs to know whether
        // a model runs.
        self.transform_on_dictate = self.polish_level != "none";
        self.hold_ms = self.hold_ms.clamp(120, 900);
        self.double_tap_ms = self.double_tap_ms.clamp(180, 900);
        self.open_router_model = non_empty(&self.open_router_model, &base.open_router_model, 200);
        // The old default is not a model OpenRouter serves, so every rewrite
        // request made with it failed and fell back to the raw transcript. It
        // is replaced rather than kept, because keeping it preserves nothing.
        if RETIRED_OPENROUTER_MODELS.contains(&self.open_router_model.as_str()) {
            self.open_router_model = DEFAULT_OPENROUTER_MODEL.to_string();
        }
        if RETIRED_TRANSFORM_PROMPTS
            .iter()
            .any(|retired| self.transform_prompt.trim() == retired.trim())
        {
            self.transform_prompt = DEFAULT_TRANSFORM_PROMPT.trim().to_string();
        }
        if RETIRED_POLISH_PROMPTS
            .iter()
            .any(|retired| self.polish_prompt.trim() == retired.trim())
        {
            self.polish_prompt = DEFAULT_POLISH_PROMPT.trim().to_string();
        }
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
    /// A prompt left at an old default is replaced, since nobody chose it.
    #[test]
    fn a_retired_prompt_is_replaced_on_load() {
        for retired in RETIRED_TRANSFORM_PROMPTS {
            let mut stored = AppSettings::default();
            stored.transform_prompt = retired.trim().to_string();
            let loaded = stored.normalize(&AppSettings::default());
            assert_eq!(loaded.transform_prompt, DEFAULT_TRANSFORM_PROMPT.trim());
        }
    }

    /// The copy-editor polish default rewrote wording; the next one tidied
    /// dictation rather than fixing typed text. Both are replaced the same way,
    /// so a default nobody edited is not kept as a preference.
    #[test]
    fn a_retired_polish_prompt_is_replaced_on_load() {
        for retired in RETIRED_POLISH_PROMPTS {
            let mut stored = AppSettings::default();
            stored.polish_prompt = retired.trim().to_string();
            let loaded = stored.normalize(&AppSettings::default());
            assert_eq!(loaded.polish_prompt, DEFAULT_POLISH_PROMPT.trim());
        }
    }

    /// The level replaced an on/off switch, and a file written while that
    /// switch existed names no level at all. Switched on, it did what the
    /// light level does, so that is the level it has to load as -- anything
    /// else silently turns polish off for everyone who had it on.
    #[test]
    fn a_file_without_a_level_keeps_the_switch_it_had() {
        let on: AppSettings = serde_json::from_str(r#"{"transformOnDictate":true}"#)
            .expect("a settings file missing the level still parses");
        let on = on.normalize(&AppSettings::default());
        assert_eq!(on.polish_level, "light");
        assert!(on.transform_on_dictate);

        let off: AppSettings = serde_json::from_str(r#"{"transformOnDictate":false}"#)
            .expect("a settings file missing the level still parses");
        let off = off.normalize(&AppSettings::default());
        assert_eq!(off.polish_level, "none");
        assert!(!off.transform_on_dictate);
    }

    /// The switch is a view of the level, so it cannot be set against it --
    /// a stale window or a hand-edited file must not end up with polish off
    /// at a level that asked for it, or on at "none".
    #[test]
    fn the_switch_follows_the_level_it_is_stored_with() {
        for (level, running) in [("none", false), ("light", true), ("medium", true)] {
            let mut stored = AppSettings::default();
            stored.polish_level = level.into();
            stored.transform_on_dictate = !running;
            let loaded = stored.normalize(&AppSettings::default());
            assert_eq!(loaded.polish_level, level);
            assert_eq!(loaded.transform_on_dictate, running);
        }
    }

    /// A level from a later version, or a typed-in one, is not a level this
    /// build can run.
    #[test]
    fn rejects_a_level_it_does_not_have() {
        let mut stored = AppSettings::default();
        stored.polish_level = "heavy".into();
        let loaded = stored.normalize(&AppSettings::default());
        assert_eq!(loaded.polish_level, "none");
    }

    /// Polish meant OpenRouter and nothing else until the local engine existed,
    /// so a file written before the setting has to go on meaning that.
    #[test]
    fn a_file_without_an_engine_keeps_polishing_where_it_was() {
        let stored: AppSettings =
            serde_json::from_str(r#"{"openRouterModel":"openai/gpt-4.1-mini"}"#)
                .expect("a settings file missing the new fields still parses");
        let loaded = stored.normalize(&AppSettings::default());
        assert_eq!(loaded.polish_engine, "openrouter");
        assert_eq!(loaded.local_model_id, crate::local_llm::DEFAULT_LOCAL_MODEL_ID);
    }

    /// A model id the engine has never heard of would resolve to the default at
    /// load time, so the choice is rejected here instead of loading something
    /// else under the name that was picked.
    #[test]
    fn only_a_local_model_the_engine_has_can_be_chosen() {
        let mut stored = AppSettings::default();
        stored.polish_engine = "local".into();
        stored.local_model_id = "qwen3-1.7b-q4".into();
        let loaded = stored.clone().normalize(&AppSettings::default());
        assert_eq!(loaded.polish_engine, "local");
        assert_eq!(loaded.local_model_id, "qwen3-1.7b-q4");

        stored.polish_engine = "ollama".into();
        stored.local_model_id = "gpt2-large".into();
        let loaded = stored.normalize(&AppSettings::default());
        assert_eq!(loaded.polish_engine, "openrouter");
        assert_eq!(loaded.local_model_id, crate::local_llm::DEFAULT_LOCAL_MODEL_ID);
    }

    /// A prompt the user wrote is theirs, however close to an old default.
    #[test]
    fn an_edited_prompt_survives_load() {
        let mut stored = AppSettings::default();
        stored.transform_prompt = "Clean it up. Keep it short.".into();
        stored.polish_prompt = "Make it rhyme.".into();
        let loaded = stored.normalize(&AppSettings::default());
        assert_eq!(loaded.transform_prompt, "Clean it up. Keep it short.");
        assert_eq!(loaded.polish_prompt, "Make it rhyme.");
    }

    /// The old default never named a real model, so every rewrite failed and
    /// fell back to the raw transcript. Loading must not preserve it.
    #[test]
    fn a_retired_model_is_replaced_on_load() {
        let mut stored = AppSettings::default();
        stored.open_router_model = "anthropic/claude-3.5-haiku".into();
        let loaded = stored.normalize(&AppSettings::default());
        assert_eq!(loaded.open_router_model, DEFAULT_OPENROUTER_MODEL);
    }

    /// A model the user chose themselves is theirs to keep.
    #[test]
    fn a_chosen_model_survives_load() {
        let mut stored = AppSettings::default();
        stored.open_router_model = "google/gemini-2.5-flash".into();
        let loaded = stored.normalize(&AppSettings::default());
        assert_eq!(loaded.open_router_model, "google/gemini-2.5-flash");
    }

    use super::*;

    /// Every speech model the engine can run must survive being saved.
    ///
    /// This list used to be a hand-kept copy that had fallen behind, so
    /// choosing Whisper was written to disk, read back as corrupt, and
    /// silently replaced -- which looked exactly like a picker that would not
    /// take the click.
    #[test]
    fn every_engine_model_survives_load() {
        for model in crate::model_server::MODELS.iter() {
            let mut stored = AppSettings::default();
            stored.model_id = model.id.into();
            let loaded = stored.normalize(&AppSettings::default());
            assert_eq!(loaded.model_id, model.id);
        }
    }

    /// Off must survive a reload, or the switch is decorative. On is the
    /// default because an app nobody can update is worse than one that asks.
    #[test]
    fn the_update_check_can_be_turned_off_for_good() {
        assert!(AppSettings::default().automatic_update_check);
        let mut stored = AppSettings::default();
        stored.automatic_update_check = false;
        assert!(!stored.normalize(&AppSettings::default()).automatic_update_check);
    }

    #[test]
    fn rejects_an_unknown_speech_model() {
        let base = AppSettings::default();
        let mut input = base.clone();
        input.model_id = "whisper-enormous".into();
        assert_eq!(input.normalize(&base).model_id, base.model_id);
    }

    #[test]
    fn an_unoffered_language_falls_back() {
        let base = AppSettings::default();
        let mut input = base.clone();
        input.speech_language = "elvish".into();
        assert_eq!(input.normalize(&base).speech_language, base.speech_language);
    }

    /// Empty is a real choice: it asks the engine to detect the language.
    #[test]
    fn detection_is_a_keepable_language_choice() {
        let base = AppSettings::default();
        let mut input = base.clone();
        input.speech_language = String::new();
        assert_eq!(input.normalize(&base).speech_language, "");
    }

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
