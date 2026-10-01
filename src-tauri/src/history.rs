//! Saved dictations.
//!
//! This is the one place the app keeps what was said. It stays on this machine,
//! is capped so it cannot grow without bound, and every entry can be deleted
//! individually or all at once. Rows live in `waveform.db` (see `store`);
//! audio for playback sits beside it as one WAV per entry -- never uploaded,
//! and removed with the entry.
//!
//! Both the words the engine returned and the words AI Polish made of them
//! are kept, with the model that produced each. The window is shown one text
//! -- the polished one when there is one -- so that a later "undo the edit"
//! has the original to go back to, and a transcript that reads wrong can be
//! traced to the model that wrote it.

use crate::store::Database;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

/// Older dictations are dropped past this point. A transcript is cheap, but an
/// unbounded list that is sent to the window whole is not.
const MAX_ENTRIES: usize = 10_000;

/// Shown for a recording the engine found no words in.
///
/// Not stored: the row keeps an empty transcript, and this is put in front of
/// it on the way out so the list has something to show and the Retry button
/// has something to sit beside.
const NO_WORDS_PLACEHOLDER: &str = "(No words detected)";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dictation {
    pub id: String,
    /// What the list shows: the polished text when there is one, else the
    /// transcript, else the no-words placeholder.
    pub text: String,
    /// Milliseconds since the epoch, so the interface can format it locally.
    pub created_at: u64,
    /// Whether a WAV for this entry sits in the audio directory.
    pub has_audio: bool,
    /// What the speech model returned. Empty when it found no words.
    pub transcribed_text: String,
    /// What AI Polish made of it, when it ran.
    pub polished_text: Option<String>,
    pub speech_model: String,
    pub polish_model: Option<String>,
}

impl Dictation {
    /// Whether anyone said anything: a failed attempt's row is not text to paste.
    pub fn has_words(&self) -> bool {
        !self.transcribed_text.is_empty()
    }
}

/// A dictation about to be saved.
pub struct NewDictation<'a> {
    /// What the engine returned, joined across the session's phrases.
    pub transcribed: &'a str,
    /// What polish made of it, if it ran and changed anything.
    pub polished: Option<&'a str>,
    pub speech_model: &'a str,
    /// The model polish ran on; `None` when it did not run.
    pub polish_model: Option<&'a str>,
    pub wav: Option<&'a [u8]>,
}

pub struct HistoryStore {
    db: Database,
    /// Keeps ids unique within a run when the clock repeats. See `fresh_id`.
    next_id: u64,
}

impl HistoryStore {
    pub fn new(db: Database) -> Self {
        Self { db, next_id: 0 }
    }

    fn audio_dir(&self) -> PathBuf {
        self.db.dir().join("audio")
    }

    fn audio_path(&self, file: &str) -> PathBuf {
        self.audio_dir().join(file)
    }

    /// Every dictation, newest first.
    pub fn entries(&self) -> Result<Vec<Dictation>, String> {
        self.db.with(|connection| read_all(connection)).map_err(describe)
    }

    /// Saves a dictation, and optionally the WAV that produced it.
    ///
    /// Text can be empty when a recording exists: the row is still kept so the
    /// user can retry from history. A blank with no audio is dropped.
    pub fn add(&mut self, dictation: NewDictation<'_>) -> Result<Vec<Dictation>, String> {
        let transcribed = dictation.transcribed.trim();
        let polished = dictation
            .polished
            .map(str::trim)
            .filter(|text| !text.is_empty() && *text != transcribed);
        let has_wav = matches!(dictation.wav, Some(bytes) if bytes.len() > 44);
        if transcribed.is_empty() && !has_wav {
            return self.entries();
        }

        let created_at = now_ms();
        let id = self.fresh_id(created_at)?;
        let audio_file = match dictation.wav {
            Some(bytes) if has_wav => self.write_audio(&id, bytes),
            _ => None,
        };

        let dropped = self
            .db
            .with(|connection| {
                let transaction = connection.transaction()?;
                transaction.execute(
                    "INSERT INTO dictations
                        (id, created_at, transcribed_text, polished_text, speech_model, polish_model, audio_file)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![
                        id,
                        created_at as i64,
                        transcribed,
                        polished,
                        dictation.speech_model,
                        polished.and(dictation.polish_model),
                        audio_file,
                    ],
                )?;
                let dropped = cap(&transaction)?;
                transaction.commit()?;
                Ok(dropped)
            })
            .map_err(describe)?;
        for file in dropped {
            self.remove_audio(&file);
        }
        self.entries()
    }

    pub fn remove(&mut self, id: &str) -> Result<Vec<Dictation>, String> {
        let audio = self
            .db
            .with(|connection| {
                connection
                    .query_row(
                        "DELETE FROM dictations WHERE id = ?1 RETURNING audio_file",
                        [id],
                        |row| row.get::<_, Option<String>>(0),
                    )
                    .optional()
            })
            .map_err(describe)?;
        if let Some(Some(file)) = audio {
            self.remove_audio(&file);
        }
        self.entries()
    }

    /// Replaces the transcript for an entry after it was transcribed again,
    /// keeping its recording and place in the list.
    ///
    /// Any polished text is dropped with the words it was made from.
    pub fn update_text(&mut self, id: &str, text: &str) -> Result<Vec<Dictation>, String> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Err("Nothing to save.".into());
        }
        let changed = self
            .db
            .with(|connection| {
                connection.execute(
                    "UPDATE dictations
                        SET transcribed_text = ?2, polished_text = NULL, polish_model = NULL
                      WHERE id = ?1",
                    params![id, trimmed],
                )
            })
            .map_err(describe)?;
        if changed == 0 {
            return Err("That dictation is gone.".into());
        }
        self.entries()
    }

    /// Replaces the words a user corrected by hand.
    ///
    /// Unlike `update_text`, this is not the engine speaking again: the edit
    /// goes on the text the user was looking at -- the polished one when
    /// polish ran -- and the engine's own words stay underneath, so the
    /// dictionary can still learn what was heard and what it should have been.
    pub fn edit_text(&mut self, id: &str, text: &str) -> Result<Vec<Dictation>, String> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Err("Nothing to save.".into());
        }
        let changed = self
            .db
            .with(|connection| {
                connection.execute(
                    "UPDATE dictations
                        SET polished_text = CASE WHEN polished_text IS NULL THEN NULL ELSE ?2 END,
                            transcribed_text = CASE WHEN polished_text IS NULL THEN ?2 ELSE transcribed_text END
                      WHERE id = ?1",
                    params![id, trimmed],
                )
            })
            .map_err(describe)?;
        if changed == 0 {
            return Err("That dictation is gone.".into());
        }
        self.entries()
    }

    pub fn clear(&mut self) -> Result<Vec<Dictation>, String> {
        let files = self
            .db
            .with(|connection| {
                let transaction = connection.transaction()?;
                let files = audio_files(&transaction, "SELECT audio_file FROM dictations")?;
                transaction.execute("DELETE FROM dictations", [])?;
                transaction.commit()?;
                Ok(files)
            })
            .map_err(describe)?;
        for file in files {
            self.remove_audio(&file);
        }
        self.entries()
    }

    /// Bytes of the saved WAV, or an error when this entry has none.
    pub fn audio(&self, id: &str) -> Result<Vec<u8>, String> {
        let file = self
            .db
            .with(|connection| {
                connection
                    .query_row(
                        "SELECT audio_file FROM dictations WHERE id = ?1",
                        [id],
                        |row| row.get::<_, Option<String>>(0),
                    )
                    .optional()
            })
            .map_err(describe)?
            .ok_or_else(|| "That dictation is gone.".to_string())?
            .ok_or_else(|| "That dictation has no recording.".to_string())?;
        fs::read(self.audio_path(&file)).map_err(|_| "The recording file is missing.".to_string())
    }

    /// An id no row has.
    ///
    /// `<ms>-<n>`, as before: the counter keeps ids apart within a
    /// millisecond, and the check against the table keeps them apart from a
    /// second process that happens to be on the same millisecond and count.
    fn fresh_id(&mut self, created_at: u64) -> Result<String, String> {
        for _ in 0..1_000 {
            self.next_id += 1;
            let id = format!("{created_at}-{}", self.next_id);
            let taken: bool = self
                .db
                .with(|connection| {
                    connection.query_row(
                        "SELECT EXISTS(SELECT 1 FROM dictations WHERE id = ?1)",
                        [&id],
                        |row| row.get(0),
                    )
                })
                .map_err(describe)?;
            if !taken {
                return Ok(id);
            }
        }
        Err("Could not find a free id for this dictation.".into())
    }

    /// The file name when the WAV landed; an entry must not promise audio it lacks.
    fn write_audio(&self, id: &str, bytes: &[u8]) -> Option<String> {
        let dir = self.audio_dir();
        let _ = fs::create_dir_all(&dir);
        let file = format!("{id}.wav");
        let path = self.audio_path(&file);
        if fs::write(&path, bytes).is_err() {
            return None;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
        }
        Some(file)
    }

    fn remove_audio(&self, file: &str) {
        let _ = fs::remove_file(self.audio_path(file));
    }
}

fn read_all(connection: &Connection) -> rusqlite::Result<Vec<Dictation>> {
    let mut select = connection.prepare_cached(
        "SELECT id, created_at, transcribed_text, polished_text, speech_model, polish_model, audio_file
           FROM dictations
          ORDER BY created_at DESC, rowid DESC",
    )?;
    let rows = select.query_map([], |row| {
        let transcribed_text: String = row.get(2)?;
        let polished_text: Option<String> = row.get(3)?;
        let audio_file: Option<String> = row.get(6)?;
        let text = match &polished_text {
            Some(polished) => polished.clone(),
            None if transcribed_text.is_empty() => NO_WORDS_PLACEHOLDER.to_string(),
            None => transcribed_text.clone(),
        };
        Ok(Dictation {
            id: row.get(0)?,
            text,
            created_at: row.get::<_, i64>(1)? as u64,
            has_audio: audio_file.is_some(),
            transcribed_text,
            polished_text,
            speech_model: row.get(4)?,
            polish_model: row.get(5)?,
        })
    })?;
    rows.collect()
}

/// Drops everything past the newest `MAX_ENTRIES`, returning their audio files.
fn cap(connection: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut delete = connection.prepare(
        "DELETE FROM dictations
          WHERE rowid IN (
                SELECT rowid FROM dictations
                 ORDER BY created_at DESC, rowid DESC
                 LIMIT -1 OFFSET ?1)
      RETURNING audio_file",
    )?;
    let files = delete
        .query_map([MAX_ENTRIES as i64], |row| row.get::<_, Option<String>>(0))?
        .filter_map(Result::ok)
        .flatten()
        .collect();
    Ok(files)
}

fn audio_files(connection: &Connection, sql: &str) -> rusqlite::Result<Vec<String>> {
    let mut select = connection.prepare(sql)?;
    let files = select
        .query_map([], |row| row.get::<_, Option<String>>(0))?
        .filter_map(Result::ok)
        .flatten()
        .collect();
    Ok(files)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or(0)
}

fn describe(error: rusqlite::Error) -> String {
    format!("History could not be saved: {error}")
}

/// Joins mono PCM16 WAVs that share a format into one file for playback.
///
/// A session can cut several phrases at pauses; history stores one entry per
/// session, so the clips have to become one recording.
pub fn concat_mono_wavs(clips: &[Vec<u8>]) -> Option<Vec<u8>> {
    let clips: Vec<&[u8]> = clips
        .iter()
        .map(|clip| clip.as_slice())
        .filter(|clip| clip.len() > 44)
        .collect();
    if clips.is_empty() {
        return None;
    }
    if clips.len() == 1 {
        return Some(clips[0].to_vec());
    }

    let header = &clips[0][..44];
    // fmt chunk: bytes 20..36 must match or the joined file would lie.
    for clip in &clips[1..] {
        if clip[20..36] != header[20..36] {
            return Some(clips[0].to_vec());
        }
    }

    let mut data = Vec::new();
    for clip in &clips {
        data.extend_from_slice(&clip[44..]);
    }

    let mut out = Vec::with_capacity(44 + data.len());
    out.extend_from_slice(header);
    out.extend_from_slice(&data);
    let file_size = (out.len() - 8) as u32;
    let data_size = data.len() as u32;
    out[4] = file_size as u8;
    out[5] = (file_size >> 8) as u8;
    out[6] = (file_size >> 16) as u8;
    out[7] = (file_size >> 24) as u8;
    out[40] = data_size as u8;
    out[41] = (data_size >> 8) as u8;
    out[42] = (data_size >> 16) as u8;
    out[43] = (data_size >> 24) as u8;
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::temp_dir;

    fn store() -> HistoryStore {
        HistoryStore::new(Database::open(&temp_dir("history")).database)
    }

    /// A second handle on the same file, as a second process would have.
    fn beside(other: &HistoryStore) -> HistoryStore {
        HistoryStore::new(Database::open(other.db.dir()).database)
    }

    fn spoken<'a>(text: &'a str, wav: Option<&'a [u8]>) -> NewDictation<'a> {
        NewDictation {
            transcribed: text,
            polished: None,
            speech_model: "test-model",
            polish_model: None,
            wav,
        }
    }

    fn tiny_wav() -> Vec<u8> {
        let mut bytes = vec![0u8; 48];
        bytes[0..4].copy_from_slice(b"RIFF");
        bytes[8..12].copy_from_slice(b"WAVE");
        bytes[12..16].copy_from_slice(b"fmt ");
        bytes[16] = 16;
        bytes[20] = 1;
        bytes[22] = 1;
        bytes[24] = 0x80;
        bytes[25] = 0xBB;
        bytes[28] = 0x00;
        bytes[29] = 0x77;
        bytes[32] = 2;
        bytes[34] = 16;
        bytes[36..40].copy_from_slice(b"data");
        bytes[40] = 4;
        bytes
    }

    #[test]
    fn newest_dictation_comes_first() {
        let mut history = store();
        history.add(spoken("first", None)).unwrap();
        let entries = history.add(spoken("second", None)).unwrap();
        assert_eq!(entries[0].text, "second");
        assert_eq!(entries[1].text, "first");
    }

    /// The bug that lost ten dictations: two processes, one file, and a write
    /// of the whole list from memory.
    #[test]
    fn a_second_writer_keeps_what_the_first_one_saved() {
        let mut first = store();
        first.add(spoken("theirs", None)).unwrap();

        let mut second = beside(&first);
        let entries = second.add(spoken("mine", None)).unwrap();

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].text, "mine");
        assert_eq!(entries[1].text, "theirs");
        // And the first handle sees the second's row without reloading.
        assert_eq!(first.entries().unwrap().len(), 2);
    }

    #[test]
    fn a_second_writer_deletes_from_the_saved_list_not_its_own() {
        let mut first = store();
        first.add(spoken("keep", None)).unwrap();
        let id = first.add(spoken("drop", None)).unwrap()[0].id.clone();

        let left = beside(&first).remove(&id).unwrap();

        assert_eq!(left.len(), 1);
        assert_eq!(left[0].text, "keep");
    }

    #[test]
    fn blank_dictations_are_not_kept() {
        let mut history = store();
        assert!(history.add(spoken("   ", None)).unwrap().is_empty());
    }

    #[test]
    fn blank_text_with_audio_is_kept_and_shown_as_no_words() {
        let mut history = store();
        let wav = tiny_wav();
        let entries = history.add(spoken("  ", Some(&wav))).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].text, NO_WORDS_PLACEHOLDER);
        assert_eq!(entries[0].transcribed_text, "");
        assert!(!entries[0].has_words());
        assert!(entries[0].has_audio);
    }

    #[test]
    fn polished_text_is_shown_and_the_transcript_kept_underneath() {
        let mut history = store();
        let entries = history
            .add(NewDictation {
                transcribed: "um so we ship it thursday",
                polished: Some("We ship it Thursday."),
                speech_model: "whisper-cpp-small",
                polish_model: Some("qwen3-0.6b-q4"),
                wav: None,
            })
            .unwrap();
        let entry = &entries[0];
        assert_eq!(entry.text, "We ship it Thursday.");
        assert_eq!(entry.transcribed_text, "um so we ship it thursday");
        assert_eq!(entry.polished_text.as_deref(), Some("We ship it Thursday."));
        assert_eq!(entry.speech_model, "whisper-cpp-small");
        assert_eq!(entry.polish_model.as_deref(), Some("qwen3-0.6b-q4"));
    }

    /// Polish that changed nothing is not an edit worth keeping twice.
    #[test]
    fn an_unchanged_polish_is_not_recorded() {
        let mut history = store();
        let entries = history
            .add(NewDictation {
                transcribed: "Already clean.",
                polished: Some("Already clean."),
                speech_model: "m",
                polish_model: Some("p"),
                wav: None,
            })
            .unwrap();
        assert_eq!(entries[0].polished_text, None);
        assert_eq!(entries[0].polish_model, None);
    }

    #[test]
    fn entries_have_distinct_ids_even_within_a_millisecond() {
        let mut history = store();
        history.add(spoken("one", None)).unwrap();
        let entries = history.add(spoken("two", None)).unwrap();
        assert_ne!(entries[0].id, entries[1].id);
    }

    /// Two processes start their counters at zero; the table is what keeps
    /// their ids apart on a shared millisecond.
    #[test]
    fn a_second_writer_does_not_reuse_an_id() {
        let mut first = store();
        first.add(spoken("one", None)).unwrap();
        let mut second = beside(&first);
        let entries = second.add(spoken("two", None)).unwrap();
        assert_eq!(entries.len(), 2);
        assert_ne!(entries[0].id, entries[1].id);
    }

    #[test]
    fn a_single_dictation_can_be_removed() {
        let mut history = store();
        history.add(spoken("keep", None)).unwrap();
        let entries = history.add(spoken("drop", None)).unwrap();
        let id = entries[0].id.clone();

        let left = history.remove(&id).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].text, "keep");
    }

    #[test]
    fn removing_a_missing_id_is_harmless() {
        let mut history = store();
        history.add(spoken("keep", None)).unwrap();
        assert_eq!(history.remove("nope").unwrap().len(), 1);
    }

    #[test]
    fn updating_text_keeps_the_recording_and_drops_the_polish() {
        let mut history = store();
        let wav = tiny_wav();
        let id = history
            .add(NewDictation {
                transcribed: "wrong words",
                polished: Some("Wrong words."),
                speech_model: "m",
                polish_model: Some("p"),
                wav: Some(&wav),
            })
            .unwrap()[0]
            .id
            .clone();
        let entries = history.update_text(&id, "right words").unwrap();
        assert_eq!(entries[0].text, "right words");
        assert_eq!(entries[0].polished_text, None);
        assert_eq!(entries[0].polish_model, None);
        assert!(entries[0].has_audio);
        assert_eq!(history.audio(&id).unwrap(), wav);
    }

    #[test]
    fn a_hand_edit_changes_the_shown_text_and_keeps_the_engines_words() {
        let mut history = store();
        let plain = history.add(spoken("towery is the shell", None)).unwrap()[0].id.clone();
        let entries = history.edit_text(&plain, "Tauri is the shell").unwrap();
        let entry = entries.iter().find(|e| e.id == plain).unwrap();
        assert_eq!(entry.text, "Tauri is the shell");
        assert_eq!(entry.transcribed_text, "Tauri is the shell");

        let polished = history
            .add(NewDictation {
                transcribed: "um towery is the shell",
                polished: Some("Towery is the shell."),
                speech_model: "m",
                polish_model: Some("p"),
                wav: None,
            })
            .unwrap()[0]
            .id
            .clone();
        let entries = history.edit_text(&polished, "Tauri is the shell.").unwrap();
        let entry = entries.iter().find(|e| e.id == polished).unwrap();
        assert_eq!(entry.text, "Tauri is the shell.");
        assert_eq!(entry.polished_text.as_deref(), Some("Tauri is the shell."));
        assert_eq!(entry.transcribed_text, "um towery is the shell");
        assert_eq!(entry.polish_model.as_deref(), Some("p"));
    }

    #[test]
    fn updating_a_missing_entry_says_so() {
        let mut history = store();
        assert_eq!(
            history.update_text("nope", "words").unwrap_err(),
            "That dictation is gone."
        );
        assert_eq!(history.update_text("nope", "  ").unwrap_err(), "Nothing to save.");
    }

    #[test]
    fn history_is_capped_and_the_oldest_audio_goes_with_it() {
        let mut history = store();
        let wav = tiny_wav();
        // Rows go in directly so the test does not write 10,000 WAVs.
        history
            .db
            .with(|connection| {
                let transaction = connection.transaction()?;
                for index in 0..MAX_ENTRIES {
                    transaction.execute(
                        "INSERT INTO dictations (id, created_at, transcribed_text, speech_model)
                         VALUES (?1, ?2, ?3, 'm')",
                        params![format!("{index}"), index as i64, format!("entry {index}")],
                    )?;
                }
                transaction.commit()
            })
            .unwrap();
        // The oldest row gets a recording, so the cap has a file to remove.
        let oldest_file = history.write_audio("0", &wav).unwrap();
        history
            .db
            .with(|connection| {
                connection.execute(
                    "UPDATE dictations SET audio_file = ?1 WHERE id = '0'",
                    [&oldest_file],
                )
            })
            .unwrap();
        assert!(history.audio_path(&oldest_file).exists());

        let entries = history.add(spoken("newest", None)).unwrap();

        assert_eq!(entries.len(), MAX_ENTRIES);
        assert_eq!(entries[0].text, "newest");
        assert!(entries.iter().all(|entry| entry.id != "0"));
        assert!(!history.audio_path(&oldest_file).exists());
    }

    #[test]
    fn clearing_removes_everything_including_audio() {
        let mut history = store();
        let wav = tiny_wav();
        let id = history.add(spoken("one", Some(&wav))).unwrap()[0].id.clone();
        history.add(spoken("two", None)).unwrap();
        assert!(history.clear().unwrap().is_empty());
        assert!(!history.audio_path(&format!("{id}.wav")).exists());
    }

    #[test]
    fn audio_is_written_beside_the_entry_and_removed_with_it() {
        let mut history = store();
        let wav = tiny_wav();
        let id = history.add(spoken("spoken", Some(&wav))).unwrap()[0].id.clone();
        assert!(history.entries().unwrap()[0].has_audio);
        assert_eq!(history.audio(&id).unwrap(), wav);

        history.remove(&id).unwrap();
        assert_eq!(history.audio(&id).unwrap_err(), "That dictation is gone.");
        assert!(!history.audio_path(&format!("{id}.wav")).exists());
    }

    #[test]
    fn an_entry_without_a_recording_says_so() {
        let mut history = store();
        let id = history.add(spoken("typed", None)).unwrap()[0].id.clone();
        assert_eq!(
            history.audio(&id).unwrap_err(),
            "That dictation has no recording."
        );
    }

    #[test]
    fn joining_wavs_keeps_every_sample() {
        let a = tiny_wav();
        let mut b = tiny_wav();
        b[44] = 7;
        b[45] = 8;
        let joined = concat_mono_wavs(&[a.clone(), b.clone()]).unwrap();
        assert_eq!(&joined[44..48], &a[44..48]);
        assert_eq!(&joined[48..52], &b[44..48]);
        assert_eq!(joined.len(), 44 + 8);
    }
}
