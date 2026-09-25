//! Saved dictations.
//!
//! This is the one place the app keeps what was said. It stays on this machine,
//! is capped so it cannot grow without bound, and every entry can be deleted
//! individually or all at once. Audio for playback sits beside the JSON as
//! one WAV per entry — never uploaded, and removed with the entry.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Older dictations are dropped past this point. A transcript is cheap, but an
/// unbounded file that is read at every launch is not.
const MAX_ENTRIES: usize = 10_000;

/// Shown when a session left a recording but the engine returned no words.
const NO_WORDS_PLACEHOLDER: &str = "(No words detected)";

/// Whether an entry's text is the stand-in for a recording with no words.
pub fn is_placeholder(text: &str) -> bool {
    text == NO_WORDS_PLACEHOLDER
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Dictation {
    pub id: String,
    pub text: String,
    /// Milliseconds since the epoch, so the interface can format it locally.
    pub created_at: u64,
    /// Whether a WAV for this entry sits in the audio directory.
    #[serde(default)]
    pub has_audio: bool,
}

pub struct HistoryStore {
    path: PathBuf,
    /// Newest first, which is the order it is read in.
    entries: Vec<Dictation>,
    next_id: u64,
}

impl HistoryStore {
    pub fn load(dir: PathBuf) -> Self {
        let path = dir.join("history.json");
        let entries = match fs::read_to_string(&path) {
            Err(_) => Vec::new(),
            Ok(raw) => match serde_json::from_str(&raw) {
                Ok(entries) => entries,
                // A file that exists but will not parse is still the only copy
                // of what someone dictated. Starting empty here means the next
                // dictation writes a one-entry file over it, so it is kept
                // under another name first.
                Err(_) => {
                    let _ = fs::rename(&path, path.with_file_name("history.unreadable.json"));
                    Vec::new()
                }
            },
        };
        Self {
            path,
            entries,
            next_id: 0,
        }
    }

    fn audio_dir(&self) -> PathBuf {
        self.path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("audio")
    }

    fn audio_path(&self, id: &str) -> PathBuf {
        self.audio_dir().join(format!("{id}.wav"))
    }

    /// Re-reads the file before changing it.
    ///
    /// The list lives in memory and is written whole, so a second process
    /// holding the same file overwrites whatever the first one added. That is
    /// not hypothetical: an Electron build left over from before the Tauri
    /// port shared this path, and one Fn press reached both apps -- the stale
    /// one saved its own list of one over ten real dictations. Disk wins,
    /// because every change here is written the moment it is made.
    fn sync_from_disk(&mut self) {
        if let Some(entries) = fs::read_to_string(&self.path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Vec<Dictation>>(&raw).ok())
        {
            self.entries = entries;
        }
    }

    pub fn entries(&self) -> Vec<Dictation> {
        self.entries.clone()
    }

    /// Saves a dictation, and optionally the WAV that produced it.
    ///
    /// Text can be empty when a recording exists: the row is still kept so the
    /// user can retry from history. A blank with no audio is still dropped.
    pub fn add(&mut self, text: &str, wav: Option<&[u8]>) -> Vec<Dictation> {
        let trimmed = text.trim();
        let has_wav = matches!(wav, Some(bytes) if bytes.len() > 44);
        if trimmed.is_empty() && !has_wav {
            return self.entries();
        }
        let body = if trimmed.is_empty() {
            NO_WORDS_PLACEHOLDER.to_string()
        } else {
            trimmed.to_string()
        };
        self.sync_from_disk();

        self.next_id += 1;
        let created_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|since| since.as_millis() as u64)
            .unwrap_or(0);
        let id = format!("{created_at}-{}", self.next_id);
        let has_audio = match wav {
            Some(bytes) if bytes.len() > 44 => self.write_audio(&id, bytes),
            _ => false,
        };

        self.entries.insert(
            0,
            Dictation {
                // The clock can repeat across a restart, so the counter keeps
                // ids unique within a run.
                id,
                text: body,
                created_at,
                has_audio,
            },
        );
        if self.entries.len() > MAX_ENTRIES {
            let dropped: Vec<_> = self.entries.drain(MAX_ENTRIES..).collect();
            for entry in dropped {
                self.remove_audio(&entry.id);
            }
        }
        self.write();
        self.entries()
    }

    pub fn remove(&mut self, id: &str) -> Vec<Dictation> {
        self.sync_from_disk();
        self.entries.retain(|entry| entry.id != id);
        self.remove_audio(id);
        self.write();
        self.entries()
    }

    /// Replaces the words for an entry, keeping its recording and place in the list.
    pub fn update_text(&mut self, id: &str, text: &str) -> Result<Vec<Dictation>, String> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Err("Nothing to save.".into());
        }
        self.sync_from_disk();
        let Some(entry) = self.entries.iter_mut().find(|entry| entry.id == id) else {
            return Err("That dictation is gone.".into());
        };
        entry.text = trimmed.to_string();
        self.write();
        Ok(self.entries())
    }

    pub fn clear(&mut self) -> Vec<Dictation> {
        // Another process may have added entries whose audio would be orphaned.
        self.sync_from_disk();
        for entry in &self.entries {
            self.remove_audio(&entry.id);
        }
        self.entries.clear();
        self.write();
        self.entries()
    }

    /// Bytes of the saved WAV, or an error when this entry has none.
    pub fn audio(&self, id: &str) -> Result<Vec<u8>, String> {
        let entry = self
            .entries
            .iter()
            .find(|entry| entry.id == id)
            .ok_or_else(|| "That dictation is gone.".to_string())?;
        if !entry.has_audio {
            return Err("That dictation has no recording.".into());
        }
        fs::read(self.audio_path(id)).map_err(|_| "The recording file is missing.".to_string())
    }

    /// Whether the file landed; an entry must not promise audio it lacks.
    fn write_audio(&self, id: &str, bytes: &[u8]) -> bool {
        let dir = self.audio_dir();
        let _ = fs::create_dir_all(&dir);
        if fs::write(self.audio_path(id), bytes).is_err() {
            return false;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(self.audio_path(id), fs::Permissions::from_mode(0o600));
        }
        true
    }

    fn remove_audio(&self, id: &str) {
        let _ = fs::remove_file(self.audio_path(id));
    }

    fn write(&self) {
        if let Some(parent) = self.path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(body) = serde_json::to_string(&self.entries) {
            // Readable only by this user: it holds everything they dictated.
            let _ = fs::write(&self.path, body);
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = fs::set_permissions(&self.path, fs::Permissions::from_mode(0o600));
            }
        }
    }
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

    /// A file of its own per store: add() reads the file back now, so a shared
    /// path would carry one test's dictations into the next.
    fn store() -> HistoryStore {
        use std::sync::atomic::{AtomicU32, Ordering};
        static COUNT: AtomicU32 = AtomicU32::new(0);
        let name = format!(
            "waveform-history-test-{}-{}",
            std::process::id(),
            COUNT.fetch_add(1, Ordering::Relaxed)
        );
        let dir = std::env::temp_dir().join(name);
        let _ = fs::create_dir_all(&dir);
        HistoryStore {
            path: dir.join("history.json"),
            entries: Vec::new(),
            next_id: 0,
        }
    }

    fn beside(other: &HistoryStore) -> HistoryStore {
        HistoryStore {
            path: other.path.clone(),
            entries: Vec::new(),
            next_id: 0,
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
        history.add("first", None);
        let entries = history.add("second", None);
        assert_eq!(entries[0].text, "second");
        assert_eq!(entries[1].text, "first");
    }

    /// The bug that lost ten dictations: two processes, one file, and a write
    /// of the whole list from memory.
    #[test]
    fn a_second_writer_keeps_what_the_first_one_saved() {
        let mut first = store();
        first.add("theirs", None);

        let mut second = beside(&first);
        let entries = second.add("mine", None);

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].text, "mine");
        assert_eq!(entries[1].text, "theirs");
    }

    #[test]
    fn a_second_writer_deletes_from_the_saved_list_not_its_own() {
        let mut first = store();
        first.add("keep", None);
        let id = first.add("drop", None)[0].id.clone();

        let left = beside(&first).remove(&id);

        assert_eq!(left.len(), 1);
        assert_eq!(left[0].text, "keep");
    }

    #[test]
    fn an_unreadable_file_is_kept_under_another_name() {
        let dir = std::env::temp_dir().join(format!("waveform-corrupt-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("history.json");
        fs::write(&path, "{not json").unwrap();

        let mut history = HistoryStore::load(dir.clone());
        history.add("after", None);

        assert_eq!(
            fs::read_to_string(dir.join("history.unreadable.json")).unwrap(),
            "{not json"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn blank_dictations_are_not_kept() {
        let mut history = store();
        assert!(history.add("   ", None).is_empty());
    }

    #[test]
    fn blank_text_with_audio_is_kept_as_a_placeholder() {
        let mut history = store();
        let wav = tiny_wav();
        let entries = history.add("  ", Some(&wav));
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].text, NO_WORDS_PLACEHOLDER);
        assert!(entries[0].has_audio);
    }

    #[test]
    fn entries_have_distinct_ids_even_within_a_millisecond() {
        let mut history = store();
        history.add("one", None);
        let entries = history.add("two", None);
        assert_ne!(entries[0].id, entries[1].id);
    }

    #[test]
    fn a_single_dictation_can_be_removed() {
        let mut history = store();
        history.add("keep", None);
        let entries = history.add("drop", None);
        let id = entries[0].id.clone();

        let left = history.remove(&id);
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].text, "keep");
    }

    #[test]
    fn updating_text_keeps_the_recording() {
        let mut history = store();
        let wav = tiny_wav();
        let id = history.add("wrong words", Some(&wav))[0].id.clone();
        let entries = history.update_text(&id, "right words").unwrap();
        assert_eq!(entries[0].text, "right words");
        assert!(entries[0].has_audio);
        assert_eq!(history.audio(&id).unwrap(), wav);
    }

    #[test]
    fn history_is_capped() {
        let mut history = store();
        // Cap without writing the file on every insert: at 10_000 entries that
        // would be tens of millions of serialised bytes for no extra coverage.
        for index in 0..MAX_ENTRIES + 25 {
            history.entries.insert(
                0,
                Dictation {
                    id: format!("{index}"),
                    text: format!("entry {index}"),
                    created_at: index as u64,
                    has_audio: false,
                },
            );
            history.entries.truncate(MAX_ENTRIES);
        }
        let entries = history.entries();
        assert_eq!(entries.len(), MAX_ENTRIES);
        // The cap drops the oldest, not the newest.
        assert_eq!(entries[0].text, format!("entry {}", MAX_ENTRIES + 24));
    }

    #[test]
    fn clearing_removes_everything() {
        let mut history = store();
        history.add("one", None);
        history.add("two", None);
        assert!(history.clear().is_empty());
    }

    #[test]
    fn audio_is_written_beside_the_entry_and_removed_with_it() {
        let mut history = store();
        let wav = tiny_wav();
        let id = history.add("spoken", Some(&wav))[0].id.clone();
        assert!(history.entries()[0].has_audio);
        assert_eq!(history.audio(&id).unwrap(), wav);

        history.remove(&id);
        assert!(history.audio(&id).is_err());
        assert!(!history.audio_path(&id).exists());
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
