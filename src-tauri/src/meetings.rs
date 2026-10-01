//! Saved meetings: a title, the lines that were said, who said them, and a
//! summary. Rows live in `waveform.db`; the recordings sit beside it under
//! `meetings/<id>/` as one WAV per track.
//!
//! A meeting is not a dictation. It has several speakers, runs for an hour,
//! and what is wanted afterwards is the record rather than the words in a
//! text field -- so it is its own table rather than ten thousand rows in
//! history, and the Transcripts page does not fill with it.

use crate::store::Database;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

/// Where a meeting is in its life.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    /// Audio is arriving; lines land as phrases are transcribed.
    Recording,
    /// Stopped; speakers are being tagged and the summary written.
    Processing,
    /// Everything that can be done has been.
    Ready,
    /// Processing stopped early; `stage` says why. The transcript is intact.
    Failed,
}

impl State {
    fn as_str(self) -> &'static str {
        match self {
            State::Recording => "recording",
            State::Processing => "processing",
            State::Ready => "ready",
            State::Failed => "failed",
        }
    }

    fn parse(value: &str) -> State {
        match value {
            "recording" => State::Recording,
            "processing" => State::Processing,
            "failed" => State::Failed,
            _ => State::Ready,
        }
    }
}

/// Which side of the call a line came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Track {
    /// The microphone: the person at this Mac.
    Mic,
    /// What the Mac was playing: everyone else.
    System,
}

impl Track {
    pub fn as_str(self) -> &'static str {
        match self {
            Track::Mic => "mic",
            Track::System => "system",
        }
    }

    fn parse(value: &str) -> Track {
        if value == "mic" {
            Track::Mic
        } else {
            Track::System
        }
    }
}

/// The raw speaker label given to every line from the microphone.
pub const LOCAL_SPEAKER: &str = "me";

/// Something processing skipped or could not do, for the window to show as
/// a banner with a button rather than a sentence in a corner.
///
/// `kind` is one of: `interrupted`, `other-side-not-heard`, `no-summary-key`,
/// `speaker-tool-missing`, `summary-failed`, `summary-unparsed`,
/// `nothing-said`. `text` says it in words for anywhere that only has words.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Note {
    pub kind: String,
    pub text: String,
}

impl Note {
    pub fn new(kind: &str, text: impl Into<String>) -> Self {
        Self {
            kind: kind.to_string(),
            text: text.into(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Meeting {
    pub id: String,
    pub title: String,
    /// Milliseconds since the epoch.
    pub created_at: u64,
    pub duration_ms: u64,
    pub state: State,
    /// What processing is doing now, or why it stopped.
    pub stage: Option<String>,
    pub language: String,
    pub speech_model: String,
    /// Raw speaker label to the name the user gave it.
    pub speakers: BTreeMap<String, String>,
    /// The summary in its fixed shape, when one has been written.
    pub summary: Option<String>,
    pub summary_model: Option<String>,
    /// Whether the other side of the call was recorded too.
    pub has_system_audio: bool,
    /// What processing skipped or could not do.
    pub notes: Vec<Note>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Line {
    pub idx: i64,
    pub start_ms: u64,
    pub end_ms: u64,
    pub track: Track,
    /// Raw label: `me` for the microphone, `speaker_NN` after tagging, none
    /// for a remote line that has not been tagged yet.
    pub speaker: Option<String>,
    pub text: String,
}

pub struct MeetingsStore {
    db: Database,
    next_id: u64,
}

impl MeetingsStore {
    pub fn new(db: Database) -> Self {
        Self { db, next_id: 0 }
    }

    /// Where a meeting's recordings live.
    pub fn dir(&self, id: &str) -> PathBuf {
        self.db.dir().join("meetings").join(id)
    }

    pub fn create(&mut self, title: &str, language: &str, speech_model: &str) -> Result<Meeting, String> {
        let created_at = now_ms();
        let id = self.fresh_id(created_at)?;
        let title = clean_title(title, created_at);
        self.db
            .with(|connection| {
                connection.execute(
                    "INSERT INTO meetings
                        (id, title, created_at, duration_ms, state, stage, language, speech_model,
                         speakers, summary, summary_model, has_system_audio)
                     VALUES (?1, ?2, ?3, 0, 'recording', NULL, ?4, ?5, '{}', NULL, NULL, 0)",
                    params![id, title, created_at as i64, language, speech_model],
                )
            })
            .map_err(describe)?;
        self.get(&id)?.ok_or_else(|| "The meeting was not saved.".to_string())
    }

    /// Every meeting, newest first.
    pub fn list(&self) -> Result<Vec<Meeting>, String> {
        self.db
            .with(|connection| {
                let mut select = connection.prepare_cached(&format!(
                    "{SELECT_MEETING} ORDER BY created_at DESC, rowid DESC"
                ))?;
                let rows = select.query_map([], read_meeting)?;
                rows.collect()
            })
            .map_err(describe)
    }

    pub fn get(&self, id: &str) -> Result<Option<Meeting>, String> {
        self.db
            .with(|connection| {
                connection
                    .query_row(&format!("{SELECT_MEETING} WHERE id = ?1"), [id], read_meeting)
                    .optional()
            })
            .map_err(describe)
    }

    pub fn lines(&self, id: &str) -> Result<Vec<Line>, String> {
        self.db
            .with(|connection| {
                let mut select = connection.prepare_cached(
                    "SELECT idx, start_ms, end_ms, track, speaker, text
                       FROM meeting_lines WHERE meeting_id = ?1
                      ORDER BY start_ms, idx",
                )?;
                let rows = select.query_map([id], |row| {
                    let track: String = row.get(3)?;
                    Ok(Line {
                        idx: row.get(0)?,
                        start_ms: row.get::<_, i64>(1)?.max(0) as u64,
                        end_ms: row.get::<_, i64>(2)?.max(0) as u64,
                        track: Track::parse(&track),
                        speaker: row.get(4)?,
                        text: row.get(5)?,
                    })
                })?;
                rows.collect()
            })
            .map_err(describe)
    }

    /// Appends a transcribed phrase. Microphone lines are the local speaker
    /// from the start; remote lines wait for tagging.
    pub fn add_line(
        &mut self,
        id: &str,
        track: Track,
        start_ms: u64,
        end_ms: u64,
        text: &str,
    ) -> Result<Line, String> {
        let text = text.trim();
        if text.is_empty() {
            return Err("Nothing to add.".into());
        }
        let speaker = match track {
            Track::Mic => Some(LOCAL_SPEAKER.to_string()),
            Track::System => None,
        };
        let idx = self
            .db
            .with(|connection| {
                let transaction = connection.transaction()?;
                let idx: i64 = transaction.query_row(
                    "SELECT COALESCE(MAX(idx), -1) + 1 FROM meeting_lines WHERE meeting_id = ?1",
                    [id],
                    |row| row.get(0),
                )?;
                transaction.execute(
                    "INSERT INTO meeting_lines (meeting_id, idx, start_ms, end_ms, track, speaker, text)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![id, idx, start_ms as i64, end_ms as i64, track.as_str(), speaker, text],
                )?;
                transaction.execute(
                    "UPDATE meetings SET duration_ms = MAX(duration_ms, ?2) WHERE id = ?1",
                    params![id, end_ms as i64],
                )?;
                transaction.commit()?;
                Ok(idx)
            })
            .map_err(describe)?;
        Ok(Line {
            idx,
            start_ms,
            end_ms,
            track,
            speaker,
            text: text.to_string(),
        })
    }

    pub fn set_state(&mut self, id: &str, state: State, stage: Option<&str>) -> Result<(), String> {
        self.db
            .with(|connection| {
                connection.execute(
                    "UPDATE meetings SET state = ?2, stage = ?3 WHERE id = ?1",
                    params![id, state.as_str(), stage],
                )
            })
            .map(|_| ())
            .map_err(describe)
    }

    pub fn set_duration(&mut self, id: &str, duration_ms: u64) -> Result<(), String> {
        self.db
            .with(|connection| {
                connection.execute(
                    "UPDATE meetings SET duration_ms = MAX(duration_ms, ?2) WHERE id = ?1",
                    params![id, duration_ms as i64],
                )
            })
            .map(|_| ())
            .map_err(describe)
    }

    pub fn set_has_system_audio(&mut self, id: &str, has: bool) -> Result<(), String> {
        self.db
            .with(|connection| {
                connection.execute(
                    "UPDATE meetings SET has_system_audio = ?2 WHERE id = ?1",
                    params![id, has],
                )
            })
            .map(|_| ())
            .map_err(describe)
    }

    pub fn set_title(&mut self, id: &str, title: &str) -> Result<Meeting, String> {
        let created_at = self
            .get(id)?
            .ok_or_else(|| "That meeting is gone.".to_string())?
            .created_at;
        let title = clean_title(title, created_at);
        self.db
            .with(|connection| {
                connection.execute(
                    "UPDATE meetings SET title = ?2 WHERE id = ?1",
                    params![id, title],
                )
            })
            .map_err(describe)?;
        self.get(id)?.ok_or_else(|| "That meeting is gone.".to_string())
    }

    /// Tags remote lines with the speakers diarization found. `tags` pairs a
    /// line's `idx` with its raw label; lines not named keep what they had.
    pub fn tag_lines(&mut self, id: &str, tags: &[(i64, String)]) -> Result<(), String> {
        self.db
            .with(|connection| {
                let transaction = connection.transaction()?;
                for (idx, speaker) in tags {
                    transaction.execute(
                        "UPDATE meeting_lines SET speaker = ?3 WHERE meeting_id = ?1 AND idx = ?2",
                        params![id, idx, speaker],
                    )?;
                }
                transaction.commit()
            })
            .map_err(describe)
    }

    /// Gives a raw speaker label a name; an empty name removes it.
    pub fn rename_speaker(&mut self, id: &str, label: &str, name: &str) -> Result<Meeting, String> {
        let mut meeting = self.get(id)?.ok_or_else(|| "That meeting is gone.".to_string())?;
        let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
        if name.is_empty() {
            meeting.speakers.remove(label);
        } else {
            meeting.speakers.insert(label.to_string(), name);
        }
        let speakers = serde_json::to_string(&meeting.speakers).unwrap_or_else(|_| "{}".into());
        self.db
            .with(|connection| {
                connection.execute(
                    "UPDATE meetings SET speakers = ?2 WHERE id = ?1",
                    params![id, speakers],
                )
            })
            .map_err(describe)?;
        Ok(meeting)
    }

    pub fn set_notes(&mut self, id: &str, notes: &[Note]) -> Result<(), String> {
        let json = serde_json::to_string(notes).unwrap_or_else(|_| "[]".into());
        self.db
            .with(|connection| {
                connection.execute(
                    "UPDATE meetings SET notes = ?2 WHERE id = ?1",
                    params![id, json],
                )
            })
            .map(|_| ())
            .map_err(describe)
    }

    pub fn set_summary(&mut self, id: &str, summary: Option<&str>, model: Option<&str>) -> Result<(), String> {
        self.db
            .with(|connection| {
                connection.execute(
                    "UPDATE meetings SET summary = ?2, summary_model = ?3 WHERE id = ?1",
                    params![id, summary, model],
                )
            })
            .map(|_| ())
            .map_err(describe)
    }

    /// Removes the meeting, its lines, and its recordings.
    pub fn delete(&mut self, id: &str) -> Result<(), String> {
        self.db
            .with(|connection| {
                let transaction = connection.transaction()?;
                transaction.execute("DELETE FROM meeting_lines WHERE meeting_id = ?1", [id])?;
                transaction.execute("DELETE FROM meetings WHERE id = ?1", [id])?;
                transaction.commit()
            })
            .map_err(describe)?;
        let _ = std::fs::remove_dir_all(self.dir(id));
        Ok(())
    }

    /// Meetings left `recording` or `processing` by a crash are closed as they
    /// stand, with a note the window turns into "Finish this meeting".
    pub fn close_abandoned(&mut self) -> Result<usize, String> {
        let note = serde_json::to_string(&[Note::new(
            "interrupted",
            "Waveform closed while this was recording. Everything up to that point was kept.",
        )])
        .unwrap_or_else(|_| "[]".into());
        self.db
            .with(|connection| {
                connection.execute(
                    "UPDATE meetings SET state = 'failed', stage = NULL, notes = ?1
                      WHERE state IN ('recording', 'processing')",
                    [note],
                )
            })
            .map_err(describe)
    }

    fn fresh_id(&mut self, created_at: u64) -> Result<String, String> {
        for _ in 0..1_000 {
            self.next_id += 1;
            let id = format!("m{created_at}-{}", self.next_id);
            let taken: bool = self
                .db
                .with(|connection| {
                    connection.query_row(
                        "SELECT EXISTS(SELECT 1 FROM meetings WHERE id = ?1)",
                        [&id],
                        |row| row.get(0),
                    )
                })
                .map_err(describe)?;
            if !taken {
                return Ok(id);
            }
        }
        Err("Could not find a free id for this meeting.".into())
    }
}

const SELECT_MEETING: &str = "SELECT id, title, created_at, duration_ms, state, stage, language, speech_model,
                                     speakers, summary, summary_model, has_system_audio, notes
                                FROM meetings";

fn read_meeting(row: &rusqlite::Row<'_>) -> rusqlite::Result<Meeting> {
    let state: String = row.get(4)?;
    let speakers: String = row.get(8)?;
    Ok(Meeting {
        id: row.get(0)?,
        title: row.get(1)?,
        created_at: row.get::<_, i64>(2)?.max(0) as u64,
        duration_ms: row.get::<_, i64>(3)?.max(0) as u64,
        state: State::parse(&state),
        stage: row.get(5)?,
        language: row.get(6)?,
        speech_model: row.get(7)?,
        speakers: serde_json::from_str(&speakers).unwrap_or_default(),
        summary: row.get(9)?,
        summary_model: row.get(10)?,
        has_system_audio: row.get::<_, i64>(11)? != 0,
        notes: row
            .get::<_, String>(12)
            .ok()
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default(),
    })
}

/// A title, or one made from the time when none was given.
fn clean_title(title: &str, created_at: u64) -> String {
    let trimmed = title.split_whitespace().collect::<Vec<_>>().join(" ");
    if trimmed.is_empty() {
        default_title(created_at)
    } else {
        trimmed.chars().take(200).collect()
    }
}

/// "Meeting, 1 Oct 14:30" in local time, so two in one day stay apart.
pub fn default_title(created_at: u64) -> String {
    // Local time without pulling in a timezone crate: ask the C library.
    let seconds = (created_at / 1_000) as libc_time_t;
    let mut tm = unsafe { std::mem::zeroed::<libc_tm>() };
    unsafe {
        localtime_r(&seconds, &mut tm);
    }
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let month = MONTHS.get(tm.tm_mon as usize).copied().unwrap_or("");
    format!(
        "Meeting, {} {month} {:02}:{:02}",
        tm.tm_mday, tm.tm_hour, tm.tm_min
    )
}

#[allow(non_camel_case_types)]
type libc_time_t = i64;

#[allow(non_camel_case_types)]
#[repr(C)]
struct libc_tm {
    tm_sec: i32,
    tm_min: i32,
    tm_hour: i32,
    tm_mday: i32,
    tm_mon: i32,
    tm_year: i32,
    tm_wday: i32,
    tm_yday: i32,
    tm_isdst: i32,
    tm_gmtoff: i64,
    tm_zone: *const u8,
}

extern "C" {
    fn localtime_r(time: *const libc_time_t, result: *mut libc_tm) -> *mut libc_tm;
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or(0)
}

fn describe(error: rusqlite::Error) -> String {
    format!("The meeting could not be saved: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::temp_dir;

    fn store() -> MeetingsStore {
        MeetingsStore::new(Database::open(&temp_dir("meetings")).database)
    }

    #[test]
    fn a_meeting_starts_recording_with_a_default_title() {
        let mut meetings = store();
        let meeting = meetings.create("  ", "en", "whisper").unwrap();
        assert!(meeting.title.starts_with("Meeting, "), "{}", meeting.title);
        assert_eq!(meeting.state, State::Recording);
        assert_eq!(meeting.duration_ms, 0);
        assert!(meeting.speakers.is_empty());
        assert!(!meeting.has_system_audio);
        assert_eq!(meetings.list().unwrap().len(), 1);
    }

    #[test]
    fn lines_land_in_time_order_and_stretch_the_duration() {
        let mut meetings = store();
        let id = meetings.create("Standup", "en", "w").unwrap().id;
        meetings.add_line(&id, Track::System, 5_000, 8_000, "second").unwrap();
        let first = meetings.add_line(&id, Track::Mic, 0, 3_000, "first").unwrap();
        assert_eq!(first.speaker.as_deref(), Some(LOCAL_SPEAKER));

        let lines = meetings.lines(&id).unwrap();
        assert_eq!(lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>(), vec!["first", "second"]);
        assert_eq!(lines[1].speaker, None);
        assert_eq!(meetings.get(&id).unwrap().unwrap().duration_ms, 8_000);
    }

    #[test]
    fn blank_lines_are_refused() {
        let mut meetings = store();
        let id = meetings.create("x", "en", "w").unwrap().id;
        assert!(meetings.add_line(&id, Track::Mic, 0, 1, "  ").is_err());
    }

    #[test]
    fn tagging_names_remote_lines_and_renaming_maps_labels() {
        let mut meetings = store();
        let id = meetings.create("x", "en", "w").unwrap().id;
        let a = meetings.add_line(&id, Track::System, 0, 1_000, "hello").unwrap();
        let b = meetings.add_line(&id, Track::System, 2_000, 3_000, "hi").unwrap();
        meetings
            .tag_lines(&id, &[(a.idx, "speaker_00".into()), (b.idx, "speaker_01".into())])
            .unwrap();
        let lines = meetings.lines(&id).unwrap();
        assert_eq!(lines[0].speaker.as_deref(), Some("speaker_00"));
        assert_eq!(lines[1].speaker.as_deref(), Some("speaker_01"));

        let meeting = meetings.rename_speaker(&id, "speaker_00", "  Priya  ").unwrap();
        assert_eq!(meeting.speakers.get("speaker_00").map(String::as_str), Some("Priya"));
        let meeting = meetings.rename_speaker(&id, "speaker_00", "").unwrap();
        assert!(meeting.speakers.is_empty());
        // Raw labels on the lines are untouched by a rename.
        assert_eq!(meetings.lines(&id).unwrap()[0].speaker.as_deref(), Some("speaker_00"));
    }

    #[test]
    fn state_summary_and_title_are_kept() {
        let mut meetings = store();
        let id = meetings.create("x", "en", "w").unwrap().id;
        meetings.set_state(&id, State::Processing, Some("Tagging speakers…")).unwrap();
        meetings.set_summary(&id, Some("One line.\n\nNext Steps\n- none"), Some("gpt")).unwrap();
        meetings.set_has_system_audio(&id, true).unwrap();
        meetings.set_state(&id, State::Ready, None).unwrap();
        let meeting = meetings.set_title(&id, " Weekly  sync ").unwrap();
        assert_eq!(meeting.title, "Weekly sync");
        assert_eq!(meeting.state, State::Ready);
        assert_eq!(meeting.stage, None);
        assert!(meeting.summary.unwrap().starts_with("One line."));
        assert_eq!(meeting.summary_model.as_deref(), Some("gpt"));
        assert!(meeting.has_system_audio);
    }

    #[test]
    fn deleting_removes_lines_and_the_folder() {
        let mut meetings = store();
        let id = meetings.create("x", "en", "w").unwrap().id;
        meetings.add_line(&id, Track::Mic, 0, 1_000, "a").unwrap();
        let dir = meetings.dir(&id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("mic.wav"), b"RIFF").unwrap();

        meetings.delete(&id).unwrap();

        assert!(meetings.get(&id).unwrap().is_none());
        assert!(meetings.lines(&id).unwrap().is_empty());
        assert!(!dir.exists());
    }

    #[test]
    fn a_meeting_left_recording_is_closed_on_the_next_launch() {
        let mut meetings = store();
        let id = meetings.create("x", "en", "w").unwrap().id;
        let done = meetings.create("y", "en", "w").unwrap().id;
        meetings.set_state(&done, State::Ready, None).unwrap();

        assert_eq!(meetings.close_abandoned().unwrap(), 1);
        let meeting = meetings.get(&id).unwrap().unwrap();
        assert_eq!(meeting.state, State::Failed);
        assert_eq!(meeting.stage, None);
        assert_eq!(meeting.notes[0].kind, "interrupted");
        assert_eq!(meetings.get(&done).unwrap().unwrap().state, State::Ready);
    }

    #[test]
    fn notes_round_trip() {
        let mut meetings = store();
        let id = meetings.create("x", "en", "w").unwrap().id;
        meetings
            .set_notes(&id, &[Note::new("no-summary-key", "Summaries need a key.")])
            .unwrap();
        let meeting = meetings.get(&id).unwrap().unwrap();
        assert_eq!(meeting.notes.len(), 1);
        assert_eq!(meeting.notes[0].kind, "no-summary-key");
        meetings.set_notes(&id, &[]).unwrap();
        assert!(meetings.get(&id).unwrap().unwrap().notes.is_empty());
    }

    #[test]
    fn ids_are_distinct_and_newest_lists_first() {
        let mut meetings = store();
        let a = meetings.create("a", "en", "w").unwrap();
        let b = meetings.create("b", "en", "w").unwrap();
        assert_ne!(a.id, b.id);
        assert_eq!(meetings.list().unwrap()[0].id, b.id);
    }

    #[test]
    fn the_default_title_names_the_day_and_time() {
        let title = default_title(1_790_000_000_000);
        assert!(title.starts_with("Meeting, "));
        assert!(title.contains(':'));
    }
}
