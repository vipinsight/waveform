//! Recording a meeting and reading it back, and the speaker tool that tags
//! who said what.

use crate::meeting::{MeetingDetail, RecorderStatus};
use crate::meetings::Meeting;
use crate::state::AppState;
use crate::windows::{present_main_window, MAIN_LABEL};
use tauri::{Emitter, State};

#[tauri::command]
pub async fn meeting_recorder_status(state: State<'_, AppState>) -> Result<RecorderStatus, String> {
    Ok(state.recorder.status().await)
}

#[tauri::command]
pub async fn list_meetings(state: State<'_, AppState>) -> Result<Vec<Meeting>, String> {
    state.recorder.list().await
}

#[tauri::command]
pub async fn get_meeting(state: State<'_, AppState>, id: String) -> Result<MeetingDetail, String> {
    state.recorder.detail(&id).await
}

#[tauri::command]
pub async fn start_meeting(state: State<'_, AppState>, title: Option<String>) -> Result<Meeting, String> {
    state.recorder.start(title.as_deref().unwrap_or("")).await
}

#[tauri::command]
pub async fn stop_meeting(state: State<'_, AppState>) -> Result<Meeting, String> {
    state.recorder.stop().await
}

/// Ends the recording and throws it away.
#[tauri::command]
pub async fn cancel_meeting(state: State<'_, AppState>) -> Result<(), String> {
    state.recorder.cancel().await
}

#[tauri::command]
pub async fn rename_meeting(state: State<'_, AppState>, id: String, title: String) -> Result<Meeting, String> {
    state.recorder.rename(&id, &title).await
}

#[tauri::command]
pub async fn rename_meeting_speaker(
    state: State<'_, AppState>,
    id: String,
    label: String,
    name: String,
) -> Result<Meeting, String> {
    state.recorder.rename_speaker(&id, &label, &name).await
}

/// Writes the summary again, after speakers were renamed or a key was added.
#[tauri::command]
pub async fn summarize_meeting(state: State<'_, AppState>, id: String) -> Result<MeetingDetail, String> {
    state.recorder.resummarize(&id).await
}

/// Runs processing again for an interrupted meeting: speakers, playback, summary.
#[tauri::command]
pub async fn finish_meeting(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.recorder.finish(&id).await
}

/// Tags speakers on a meeting recorded before the speaker tool was installed.
#[tauri::command]
pub async fn tag_meeting_speakers(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.recorder.tag_speakers(&id).await
}

#[tauri::command]
pub async fn delete_meeting(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.recorder.delete(&id).await
}

#[tauri::command]
pub async fn get_meeting_audio(state: State<'_, AppState>, id: String) -> Result<Vec<u8>, String> {
    state.recorder.audio(&id).await
}

/// Brings the window up on the live meeting; the HUD's clock calls this.
#[tauri::command]
pub async fn show_meetings(app: tauri::AppHandle) -> Result<(), String> {
    present_main_window(&app);
    let _ = app.emit_to(MAIN_LABEL, "open-meetings", "show");
    Ok(())
}

#[tauri::command]
pub async fn install_diarizer(state: State<'_, AppState>) -> Result<(), String> {
    state.recorder.install_diarizer().await
}

#[tauri::command]
pub async fn cancel_diarizer_install(state: State<'_, AppState>) -> Result<(), String> {
    state.recorder.cancel_diarizer_install();
    Ok(())
}

#[tauri::command]
pub async fn remove_diarizer(state: State<'_, AppState>) -> Result<(), String> {
    state.recorder.remove_diarizer().await
}
