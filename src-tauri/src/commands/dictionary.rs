//! The terms the speech engine is asked to get right.

use crate::dictionary::{self, Suggestion, Term};
use crate::state::AppState;
use tauri::{Emitter, State};

#[tauri::command]
pub async fn get_dictionary(state: State<'_, AppState>) -> Result<Vec<Term>, String> {
    state.dictionary.lock().await.terms()
}

/// Adds a term the user typed, or one they accepted from a correction.
#[tauri::command]
pub async fn add_dictionary_term(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    text: String,
    heard_as: Vec<String>,
    learned: Option<bool>,
) -> Result<Vec<Term>, String> {
    let source = if learned.unwrap_or(false) {
        dictionary::Source::Learned
    } else {
        dictionary::Source::Manual
    };
    let terms = state.dictionary.lock().await.add(&text, &heard_as, source)?;
    let _ = app.emit("dictionary-changed", &terms);
    Ok(terms)
}

#[tauri::command]
pub async fn update_dictionary_term(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: i64,
    text: String,
    heard_as: Vec<String>,
) -> Result<Vec<Term>, String> {
    let terms = state.dictionary.lock().await.update(id, &text, &heard_as)?;
    let _ = app.emit("dictionary-changed", &terms);
    Ok(terms)
}

#[tauri::command]
pub async fn remove_dictionary_term(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: i64,
) -> Result<Vec<Term>, String> {
    let terms = state.dictionary.lock().await.remove(id)?;
    let _ = app.emit("dictionary-changed", &terms);
    Ok(terms)
}

/// Adds every term in a pasted list, comma or line separated. Existing terms
/// are kept; nothing is removed by an import.
#[tauri::command]
pub async fn import_dictionary(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    text: String,
) -> Result<Vec<Term>, String> {
    let mut dictionary = state.dictionary.lock().await;
    let mut terms = dictionary.terms()?;
    for term in split_terms(&text) {
        terms = dictionary.add(&term, &[], dictionary::Source::Manual)?;
    }
    let _ = app.emit("dictionary-changed", &terms);
    Ok(terms)
}

/// The user did not want this correction learned.
#[tauri::command]
pub async fn decline_dictionary_suggestion(
    state: State<'_, AppState>,
    suggestion: Suggestion,
) -> Result<(), String> {
    state.dictionary.lock().await.decline(&suggestion)
}

/// Terms out of a pasted list: commas and line breaks separate them.
pub(crate) fn split_terms(text: &str) -> Vec<String> {
    text.split([',', '\n', ';'])
        .map(|term| term.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|term| !term.is_empty())
        .collect()
}
