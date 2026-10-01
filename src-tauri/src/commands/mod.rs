//! The commands a window invokes, grouped by what they act on.
//!
//! Each function's name is the string the renderer calls it by, through
//! `src/renderer/tauri-bridge.ts`, so the names here are part of the contract
//! and the grouping is only for the people reading them.

pub(crate) mod app;
pub(crate) mod dictation;
pub(crate) mod dictionary;
pub(crate) mod history;
pub(crate) mod logs;
pub(crate) mod meetings;
pub(crate) mod models;
pub(crate) mod overlay;
pub(crate) mod polish;
pub(crate) mod settings;
pub(crate) mod speech;
pub(crate) mod updates;

/// Every command, for the builder. Listed by group so a missing one is found
/// by looking in one place.
pub(crate) fn handler() -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        app::show_main_window,
        app::app_version,
        app::app_name,
        app::open_url,
        settings::get_settings,
        settings::update_settings,
        settings::set_available_microphones,
        history::get_stats,
        history::get_history,
        history::edit_dictation,
        history::delete_dictation,
        history::clear_history,
        history::get_dictation_audio,
        history::save_dictation_audio,
        history::save_dictation,
        history::update_dictation,
        meetings::meeting_recorder_status,
        meetings::list_meetings,
        meetings::get_meeting,
        meetings::start_meeting,
        meetings::stop_meeting,
        meetings::cancel_meeting,
        meetings::rename_meeting,
        meetings::rename_meeting_speaker,
        meetings::summarize_meeting,
        meetings::finish_meeting,
        meetings::tag_meeting_speakers,
        meetings::delete_meeting,
        meetings::get_meeting_audio,
        meetings::install_diarizer,
        meetings::show_meetings,
        meetings::cancel_diarizer_install,
        meetings::remove_diarizer,
        dictionary::get_dictionary,
        dictionary::add_dictionary_term,
        dictionary::update_dictionary_term,
        dictionary::remove_dictionary_term,
        dictionary::import_dictionary,
        dictionary::decline_dictionary_suggestion,
        models::get_model_state,
        models::start_model,
        models::select_model,
        models::model_catalog,
        models::download_model,
        models::delete_model,
        models::cancel_model_download,
        speech::transcribe,
        speech::request_microphone,
        speech::start_native_capture,
        speech::stop_native_capture,
        logs::get_logs,
        logs::clear_logs,
        logs::append_log,
        updates::check_for_update,
        updates::install_update,
        updates::update_available,
        dictation::toggle_dictation,
        dictation::start_overlay_dictation,
        dictation::accept_dictation,
        dictation::polish_dictation,
        dictation::cancel_dictation,
        dictation::retry_dictation,
        dictation::dismiss_dictation_retry,
        dictation::preview_indicator,
        dictation::report_dictation_state,
        dictation::report_dictation_clip,
        dictation::report_dictation_phrase,
        dictation::get_hotkey_status,
        dictation::request_hotkey_permission,
        dictation::open_privacy_settings,
        polish::get_ai_status,
        polish::polish_model_catalog,
        polish::download_polish_model,
        polish::delete_polish_model,
        polish::cancel_polish_model_download,
        polish::set_openrouter_key,
        polish::clear_openrouter_key,
        polish::polish_selection,
        overlay::set_overlay_hit_region,
        overlay::begin_overlay_drag,
        overlay::drag_overlay,
        overlay::end_overlay_drag,
    ]
}
