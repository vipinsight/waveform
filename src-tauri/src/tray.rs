//! The menu bar icon and its menu, rebuilt whenever something it names changes.

use crate::bundle::app_display_name;
use crate::history::Dictation as SavedDictation;
use crate::meetings::Meeting;
use crate::menu::handle_menu_action;
use crate::model_server::MODELS;
use crate::state::AppState;
use crate::{hotkey, mic, updates};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::Manager;

/// One line of a dictation, for a menu that has one line to give it.
///
/// Line breaks become spaces before anything is measured: a menu item draws a
/// single line whatever it is handed, so a newline would only make the width
/// unpredictable. The cut is by character rather than by byte, because a
/// dictation is text and slicing UTF-8 mid-character panics.
fn menu_preview(text: &str) -> String {
    const MAX_CHARS: usize = 44;
    let flattened = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flattened.chars().count() <= MAX_CHARS {
        return flattened;
    }
    let kept: String = flattened.chars().take(MAX_CHARS).collect();
    format!("{}…", kept.trim_end())
}

/// Writes an accelerator the way a menu does, so the menu bar reads like one.
fn accelerator_label(accelerator: &str) -> String {
    if accelerator == "none" {
        return "Off".into();
    }
    accelerator
        .replace("CommandOrControl+", "⌘")
        .replace("Command+", "⌘")
        .replace("Control+", "⌃")
        .replace("Alt+", "⌥")
        .replace("Shift+", "⇧")
}

/// The model picker for the menu bar.
///
/// The whole catalogue, under the same headings the models page uses, so the
/// two places a model is chosen do not present different lists. A model that
/// would need a download or a terminal is listed and disabled: the menu bar
/// can switch between models that are here, and the window is where models
/// arrive.
fn build_model_menu(
    app: &tauri::AppHandle,
    selected: &str,
    state: &AppState,
) -> tauri::Result<Submenu<tauri::Wry>> {
    // "Speech", because polish has a model too and this is not it.
    let menu = Submenu::new(app, "Speech Model", true)?;
    let mut heading: Option<&str> = None;
    for (index, definition) in MODELS.iter().enumerate() {
        let group = definition.group.heading();
        // Separators rather than nested submenus: the point of this menu is to
        // switch models in one gesture, and a submenu per group adds a hop to
        // every one of them.
        if heading.is_some_and(|previous| previous != group) {
            menu.append(&PredefinedMenuItem::separator(app)?)?;
        }
        heading = Some(group);
        let item = CheckMenuItem::with_id(
            app,
            format!("model-{index}"),
            definition.short_label,
            state.models.is_ready(definition) || definition.id == selected,
            definition.id == selected,
            None::<&str>,
        )?;
        menu.append(&item)?;
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(
        app,
        "model-settings",
        "Model settings…",
        true,
        None::<&str>,
    )?)?;
    Ok(menu)
}

/// The meeting being recorded, if the recorder can say so without waiting.
fn state_recording(app: &tauri::AppHandle) -> Option<Meeting> {
    let recorder = app.state::<AppState>().recorder.clone();
    tauri::async_runtime::block_on(async {
        tokio::time::timeout(std::time::Duration::from_millis(200), recorder.recording())
            .await
            .ok()
            .flatten()
    })
}

/// Builds menu contents independently of the persistent menu bar icon.
fn build_tray_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let name = app_display_name();
    let open = MenuItem::with_id(app, "open", format!("Open {name}"), true, None::<&str>)?;
    let polish = MenuItem::with_id(app, "polish", "Polish selection", true, None::<&str>)?;
    // A live microphone is never a surprise: while a meeting records, the
    // first thing in the menu says so and stops it.
    let recording = state_recording(app);
    let meeting_item = match &recording {
        Some(meeting) => MenuItem::with_id(
            app,
            "meeting-stop",
            format!("Stop recording “{}”", menu_preview(&meeting.title)),
            true,
            None::<&str>,
        )?,
        None => MenuItem::with_id(app, "meeting-record", "Record a meeting", true, None::<&str>)?,
    };
    let meeting_show = recording
        .as_ref()
        .map(|_| MenuItem::with_id(app, "meeting-show", "Show meeting", true, None::<&str>))
        .transpose()?;
    let quit = MenuItem::with_id(app, "quit", format!("Quit {name}"), true, None::<&str>)?;
    let microphone_menu = Submenu::new(app, "Microphone", true)?;
    let state = app.state::<AppState>();
    let settings = state
        .settings
        .try_lock()
        .map(|settings| settings.value())
        .unwrap_or_default();

    // Naming the keys here is the point: the menu bar is where someone looks
    // when they have forgotten them, and it is reachable without the window.
    let shortcut_menu = Submenu::new(app, "Shortcuts", true)?;
    let dictate_key = hotkey::label_for(&settings.hotkey_id).unwrap_or("Off");
    shortcut_menu.append(&MenuItem::with_id(
        app,
        "shortcut-dictate",
        format!("Dictate — {dictate_key}"),
        false,
        None::<&str>,
    )?)?;
    shortcut_menu.append(&MenuItem::with_id(
        app,
        "shortcut-polish",
        format!("Polish selection — {}", accelerator_label(&settings.polish_shortcut)),
        false,
        None::<&str>,
    )?)?;
    shortcut_menu.append(&PredefinedMenuItem::separator(app)?)?;
    shortcut_menu.append(&MenuItem::with_id(
        app,
        "shortcut-settings",
        "Change shortcuts…",
        true,
        None::<&str>,
    )?)?;

    // Disabled rather than hidden when there is nothing to paste, so the item
    // does not appear and disappear as history comes and goes.
    let last_dictation = state
        .history
        .try_lock()
        .ok()
        .and_then(|history| history.entries().ok())
        .and_then(|entries| entries.into_iter().find(SavedDictation::has_words))
        .map(|entry| entry.text);
    let paste_last = MenuItem::with_id(
        app,
        "paste-last",
        "Paste last transcription",
        last_dictation.is_some(),
        None::<&str>,
    )?;
    // What will be pasted, said once and quietly. A disabled item is how a menu
    // renders text that is there to be read rather than chosen.
    let paste_preview = last_dictation.as_deref().map(menu_preview);
    let paste_preview = paste_preview
        .map(|line| MenuItem::with_id(app, "paste-last-preview", line, false, None::<&str>))
        .transpose()?;
    let devices = state
        .microphones
        .lock()
        .map(|devices| devices.clone())
        .unwrap_or_default();
    // The renderer carries Waveform's automatic choice as the first entry.
    // Before the first capture there is no list yet, so the plain word stands in.
    // Empty-id Auto is stripped before it reaches the tray list, so the label
    // is rebuilt here to match Settings: capture prefers the built-in mic when
    // nothing is pinned, and falls back to macOS's default otherwise.
    let auto_label = if devices.is_empty()
        || devices
            .iter()
            .any(|device| mic::is_built_in_input(&device.label))
    {
        "Auto (built-in mic)".to_string()
    } else {
        "Auto-detect".to_string()
    };
    let system_default = CheckMenuItem::with_id(
        app,
        "microphone-default",
        auto_label,
        true,
        settings.microphone_device_id.is_empty(),
        None::<&str>,
    )?;
    microphone_menu.append(&system_default)?;
    for (index, device) in devices.iter().enumerate() {
        if device.id.is_empty() {
            continue;
        }
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
    let model_menu = build_model_menu(app, &settings.model_id, &state)?;
    microphone_menu.append(&PredefinedMenuItem::separator(app)?)?;
    microphone_menu.append(&microphone_settings)?;
    // Assembled rather than declared, because the preview line is only there
    // when there is a dictation for it to preview.
    let separator = PredefinedMenuItem::separator(app)?;
    // First, and only while there is one: the menu bar is where a menu bar
    // app is looked at, so an update waiting is said here, not only in a
    // window that may never be opened.
    let update = updates::available()
        .map(|version| {
            MenuItem::with_id(
                app,
                "install-update",
                format!("Update to {version} and Restart"),
                true,
                None::<&str>,
            )
        })
        .transpose()?;
    let mut items: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = Vec::new();
    if let Some(update) = update.as_ref() {
        items.push(update);
        items.push(&separator);
    }
    items.push(&meeting_item);
    if let Some(show) = meeting_show.as_ref() {
        items.push(show);
    }
    items.push(&separator);
    items.extend([
        &open as &dyn tauri::menu::IsMenuItem<tauri::Wry>,
        &separator,
        &model_menu,
        &microphone_menu,
        &shortcut_menu,
        &separator,
        &paste_last,
    ]);
    if let Some(preview) = paste_preview.as_ref() {
        items.push(preview);
    }
    items.extend([
        &polish as &dyn tauri::menu::IsMenuItem<tauri::Wry>,
        &separator,
        &quit,
    ]);
    Menu::with_items(app, &items)
}

/// Creates the menu bar icon when first shown.
pub(crate) fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let menu = build_tray_menu(app)?;
    let icon = tray_icon()?;

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

/// The menu bar icon, with a small dot when an update is waiting.
///
/// The dot is part of the template image, so macOS draws it in the same ink
/// as the bars: news, the way other menu bar apps show it, not an alarm.
fn tray_icon() -> tauri::Result<tauri::image::Image<'static>> {
    let bytes: &'static [u8] = if updates::available().is_some() {
        include_bytes!("../../icons/tray-icon-update.png")
    } else {
        include_bytes!("../../icons/tray-icon.png")
    };
    tauri::image::Image::from_bytes(bytes)
}

/// WebView commands run off the AppKit thread. Tray mutation must return to it
/// or macOS aborts with a BoardServices threading violation.
pub(crate) fn refresh_tray_menu(app: &tauri::AppHandle) {
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        // Recreating the status item makes macOS remove and reinsert it,
        // shifting menu bar icons whenever dictation discovers microphones.
        if let Some(tray) = app.tray_by_id("waveform") {
            if let Ok(menu) = build_tray_menu(&app) {
                let _ = tray.set_menu(Some(menu));
            }
            if let Ok(icon) = tray_icon() {
                let _ = tray.set_icon(Some(icon));
                let _ = tray.set_icon_as_template(true);
            }
        }
    });
}

/// WebView commands run off the AppKit thread. Creating and removing a menu
/// bar icon must both return to it or macOS terminates the process.
pub(crate) fn set_tray_visibility(app: &tauri::AppHandle, visible: bool) {
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        if visible {
            if app.tray_by_id("waveform").is_none() {
                let _ = build_tray(&app);
            }
        } else {
            app.remove_tray_by_id("waveform");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_short_dictation_previews_whole() {
        assert_eq!(menu_preview("Hello there"), "Hello there");
    }

    #[test]
    fn a_preview_is_one_line() {
        assert_eq!(menu_preview("first line\nsecond  line"), "first line second line");
    }

    #[test]
    fn a_long_dictation_is_cut_and_marked() {
        let preview = menu_preview(&"word ".repeat(40));
        assert!(preview.ends_with('…'), "{preview}");
        assert!(preview.chars().count() <= 45, "{preview}");
    }

    /// Cutting by byte would split a multi-byte character and panic; a
    /// dictation is text, so this is the ordinary case rather than a corner.
    #[test]
    fn a_preview_cuts_between_characters() {
        assert_eq!(menu_preview(&"é".repeat(10)), "é".repeat(10));
        let preview = menu_preview(&"é".repeat(80));
        assert!(preview.ends_with('…'));
        assert!(preview.chars().count() <= 45);
    }
}
