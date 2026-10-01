//! Saved dictations and the lifetime counters kept beside them.

use crate::dictionary::{self, Suggestion};
use crate::history::{Dictation as SavedDictation, NewDictation};
use crate::state::AppState;
use crate::stats::AppStats;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
pub async fn get_stats(state: State<'_, AppState>) -> Result<AppStats, String> {
    Ok(state.stats.lock().await.value())
}

#[tauri::command]
pub async fn get_history(state: State<'_, AppState>) -> Result<Vec<SavedDictation>, String> {
    state.history.lock().await.entries()
}

#[tauri::command]
pub async fn delete_dictation(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<SavedDictation>, String> {
    let entries = state.history.lock().await.remove(&id)?;
    let _ = app.emit("history-changed", &entries);
    Ok(entries)
}

#[tauri::command]
pub async fn clear_history(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<SavedDictation>, String> {
    let entries = state.history.lock().await.clear()?;
    let _ = app.emit("history-changed", &entries);
    Ok(entries)
}

#[tauri::command]
pub async fn get_dictation_audio(
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<u8>, String> {
    state.history.lock().await.audio(&id)
}

/// Copies a dictation's recording into Downloads and shows it in Finder.
///
/// Downloads rather than a save panel: it needs no extra plugin, and Finder
/// opening on the file is the "where did it go" answer a panel would give.
/// The name comes from the window (it formats the time locally) and is
/// reduced to a bare file name here, so it cannot point anywhere else.
#[tauri::command]
pub async fn save_dictation_audio(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    file_name: String,
) -> Result<String, String> {
    let bytes = state.history.lock().await.audio(&id)?;
    let dir = app
        .path()
        .download_dir()
        .map_err(|_| "Could not find the Downloads folder.".to_string())?;
    let path = unused_path(&dir, &export_file_stem(&file_name));
    std::fs::write(&path, bytes).map_err(|error| format!("Could not save the audio: {error}"))?;
    let _ = app.opener().reveal_item_in_dir(&path);
    Ok(path.to_string_lossy().into_owned())
}

/// A file name with no directory in it, and no extension (".wav" is added).
fn export_file_stem(requested: &str) -> String {
    let stem: String = requested
        .trim()
        .trim_end_matches(".wav")
        .chars()
        .filter(|character| !matches!(character, '/' | '\\' | ':' | '\0'))
        .take(120)
        .collect();
    let stem = stem.trim().trim_start_matches('.').to_string();
    if stem.is_empty() {
        "Waveform dictation".into()
    } else {
        stem
    }
}

/// `stem.wav`, or `stem 2.wav` and onward when that is taken.
fn unused_path(dir: &Path, stem: &str) -> PathBuf {
    let first = dir.join(format!("{stem}.wav"));
    if !first.exists() {
        return first;
    }
    (2..)
        .map(|index| dir.join(format!("{stem} {index}.wav")))
        .find(|candidate| !candidate.exists())
        .unwrap_or(first)
}

/// Saves a file transcription the same way a spoken one is saved.
#[tauri::command]
pub async fn save_dictation(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    text: String,
    wav_bytes: Option<Vec<u8>>,
) -> Result<Vec<SavedDictation>, String> {
    let speech_model = state.settings.lock().await.value().model_id;
    let entries = state.history.lock().await.add(NewDictation {
        transcribed: &text,
        polished: None,
        speech_model: &speech_model,
        polish_model: None,
        wav: wav_bytes.as_deref(),
    })?;
    let _ = app.emit("history-changed", &entries);
    Ok(entries)
}

/// Replaces the words on a saved dictation after a re-transcription.
#[tauri::command]
pub async fn update_dictation(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    text: String,
) -> Result<Vec<SavedDictation>, String> {
    let entries = state.history.lock().await.update_text(&id, &text)?;
    let _ = app.emit("history-changed", &entries);
    Ok(entries)
}

/// What a transcript edit returns: the list, what the edit suggests learning,
/// and -- when learning is automatic -- what was added without asking.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditOutcome {
    entries: Vec<SavedDictation>,
    suggestions: Vec<Suggestion>,
    added: Vec<Suggestion>,
}

/// Saves words the user corrected by hand on a saved dictation.
///
/// The difference between what was there and what they typed is where the
/// dictionary learns from, so it is worked out here while both are known.
#[tauri::command]
pub async fn edit_dictation(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    text: String,
) -> Result<EditOutcome, String> {
    let mut history = state.history.lock().await;
    let before = history
        .entries()?
        .into_iter()
        .find(|entry| entry.id == id)
        .map(|entry| entry.text)
        .ok_or_else(|| "That dictation is gone.".to_string())?;
    let entries = history.edit_text(&id, &text)?;
    drop(history);
    let _ = app.emit("history-changed", &entries);
    let suggestions = state
        .dictionary
        .lock()
        .await
        .suggestions_for(&before, &text)
        .unwrap_or_default();
    if state.settings.lock().await.value().dictionary_learning != "auto" {
        return Ok(EditOutcome {
            entries,
            suggestions,
            added: Vec::new(),
        });
    }
    // Automatic: every term-shaped correction goes straight in, as learned.
    let mut added = Vec::new();
    {
        let mut dictionary = state.dictionary.lock().await;
        for suggestion in suggestions {
            if dictionary
                .add(&suggestion.text, std::slice::from_ref(&suggestion.heard_as), dictionary::Source::Learned)
                .is_ok()
            {
                added.push(suggestion);
            }
        }
        if !added.is_empty() {
            let _ = app.emit("dictionary-changed", dictionary.terms().unwrap_or_default());
        }
    }
    Ok(EditOutcome {
        entries,
        suggestions: Vec::new(),
        added,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_audio_names_cannot_leave_downloads() {
        assert_eq!(export_file_stem("../../etc/passwd"), "etcpasswd");
        assert_eq!(export_file_stem("Waveform 2026-09-25 at 13.12.04.wav"), "Waveform 2026-09-25 at 13.12.04");
        assert_eq!(export_file_stem("  .hidden"), "hidden");
        assert_eq!(export_file_stem("///"), "Waveform dictation");
    }

    #[test]
    fn saved_audio_never_overwrites() {
        let dir = std::env::temp_dir().join(format!("waveform-save-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let first = unused_path(&dir, "clip");
        assert_eq!(first, dir.join("clip.wav"));
        std::fs::write(&first, b"x").unwrap();
        assert_eq!(unused_path(&dir, "clip"), dir.join("clip 2.wav"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
