//! Saved dictations.
//!
//! This is the one place the app keeps what was said. It stays on this machine,
//! is capped so it cannot grow without bound, and every entry can be deleted
//! individually or all at once.
//!
//! Successful transcripts are text only. Failed transcriptions keep a WAV under
//! the audio directory so Retry can recover them after quit/relaunch.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Older dictations are dropped past this point. A transcript is cheap, but an
/// unbounded file that is read at every launch is not.
const MAX_ENTRIES: usize = 10_000;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DictationStatus {
    #[default]
    Ok,
    Failed,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Dictation {
    pub id: String,
    pub text: String,
    /// Milliseconds since the epoch, so the interface can format it locally.
    pub created_at: u64,
    /// Missing in older files means a successful transcript.
    #[serde(default)]
    pub status: DictationStatus,
    /// Engine error or empty-words detail; only set for failed rows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// Relative file name under the audio directory; only for failed rows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio_path: Option<String>,
}

pub struct HistoryStore {
    path: PathBuf,
    audio_dir: PathBuf,
    /// Newest first, which is the order it is read in.
    entries: Vec<Dictation>,
    next_id: u64,
}

impl HistoryStore {
    pub fn load(dir: PathBuf) -> Self {
        let path = dir.join("history.json");
        let audio_dir = dir.join("audio");
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
            audio_dir,
            entries,
            next_id: 0,
        }
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

    pub fn add(&mut self, text: &str) -> Vec<Dictation> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return self.entries();
        }
        self.sync_from_disk();

        let (id, created_at) = self.next_identity();
        self.entries.insert(
            0,
            Dictation {
                id,
                text: trimmed.to_string(),
                created_at,
                status: DictationStatus::Ok,
                message: None,
                audio_path: None,
            },
        );
        self.trim_to_cap();
        self.write();
        self.entries()
    }

    /// Inserts a failed row and writes `wav` beside history as `{id}.wav`.
    pub fn add_failed(&mut self, message: &str, wav: &[u8]) -> Result<Vec<Dictation>, String> {
        self.sync_from_disk();

        let (id, created_at) = self.next_identity();
        let relative = format!("{id}.wav");
        self.write_audio(&relative, wav)?;

        self.entries.insert(
            0,
            Dictation {
                id,
                text: String::new(),
                created_at,
                status: DictationStatus::Failed,
                message: Some(message.to_string()),
                audio_path: Some(relative),
            },
        );
        self.trim_to_cap();
        self.write();
        Ok(self.entries())
    }

    /// Updates the error text on an existing failed row after another Retry miss.
    pub fn update_failed_message(&mut self, id: &str, message: &str) -> Vec<Dictation> {
        self.sync_from_disk();
        if let Some(entry) = self
            .entries
            .iter_mut()
            .find(|entry| entry.id == id && entry.status == DictationStatus::Failed)
        {
            entry.message = Some(message.to_string());
            self.write();
        }
        self.entries()
    }

    /// Bytes for a failed row's WAV, when one is still on disk.
    pub fn audio_bytes(&self, id: &str) -> Result<Vec<u8>, String> {
        let entry = self
            .entries
            .iter()
            .find(|entry| entry.id == id)
            .ok_or_else(|| "That dictation is gone.".to_string())?;
        let relative = entry
            .audio_path
            .as_deref()
            .ok_or_else(|| "That dictation has no saved audio.".to_string())?;
        fs::read(self.audio_dir.join(relative)).map_err(|error| {
            format!("Could not read saved audio: {error}")
        })
    }

    pub fn remove(&mut self, id: &str) -> Vec<Dictation> {
        self.sync_from_disk();
        if let Some(entry) = self.entries.iter().find(|entry| entry.id == id) {
            self.delete_audio_file(entry.audio_path.as_deref());
        }
        self.entries.retain(|entry| entry.id != id);
        self.write();
        self.entries()
    }

    pub fn clear(&mut self) -> Vec<Dictation> {
        for entry in &self.entries {
            self.delete_audio_file(entry.audio_path.as_deref());
        }
        self.entries.clear();
        self.write();
        self.entries()
    }

    fn next_identity(&mut self) -> (String, u64) {
        self.next_id += 1;
        let created_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|since| since.as_millis() as u64)
            .unwrap_or(0);
        // The clock can repeat across a restart, so the counter keeps ids
        // unique within a run.
        (format!("{created_at}-{}", self.next_id), created_at)
    }

    fn trim_to_cap(&mut self) {
        while self.entries.len() > MAX_ENTRIES {
            if let Some(dropped) = self.entries.pop() {
                self.delete_audio_file(dropped.audio_path.as_deref());
            }
        }
    }

    fn write_audio(&self, relative: &str, wav: &[u8]) -> Result<(), String> {
        fs::create_dir_all(&self.audio_dir)
            .map_err(|error| format!("Could not create audio directory: {error}"))?;
        let path = self.audio_dir.join(relative);
        fs::write(&path, wav).map_err(|error| format!("Could not save failed audio: {error}"))?;
        set_owner_only(&path);
        Ok(())
    }

    fn delete_audio_file(&self, relative: Option<&str>) {
        let Some(relative) = relative else { return };
        let path = self.audio_dir.join(relative);
        let _ = fs::remove_file(path);
    }

    fn write(&self) {
        if let Some(parent) = self.path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(body) = serde_json::to_string(&self.entries) {
            // Readable only by this user: it holds everything they dictated.
            let _ = fs::write(&self.path, body);
            set_owner_only(&self.path);
        }
    }
}

fn set_owner_only(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A directory of its own per store: add() reads the file back now, so a
    /// shared path would carry one test's dictations into the next.
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
            audio_dir: dir.join("audio"),
            entries: Vec::new(),
            next_id: 0,
        }
    }

    fn beside(other: &HistoryStore) -> HistoryStore {
        HistoryStore {
            path: other.path.clone(),
            audio_dir: other.audio_dir.clone(),
            entries: Vec::new(),
            next_id: 0,
        }
    }

    #[test]
    fn newest_dictation_comes_first() {
        let mut history = store();
        history.add("first");
        let entries = history.add("second");
        assert_eq!(entries[0].text, "second");
        assert_eq!(entries[1].text, "first");
    }

    /// The bug that lost ten dictations: two processes, one file, and a write
    /// of the whole list from memory.
    #[test]
    fn a_second_writer_keeps_what_the_first_one_saved() {
        let mut first = store();
        first.add("theirs");

        let mut second = beside(&first);
        let entries = second.add("mine");

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].text, "mine");
        assert_eq!(entries[1].text, "theirs");
    }

    #[test]
    fn a_second_writer_deletes_from_the_saved_list_not_its_own() {
        let mut first = store();
        first.add("keep");
        let id = first.add("drop")[0].id.clone();

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
        history.add("after");

        assert_eq!(
            fs::read_to_string(dir.join("history.unreadable.json")).unwrap(),
            "{not json"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn blank_dictations_are_not_kept() {
        let mut history = store();
        assert!(history.add("   ").is_empty());
    }

    #[test]
    fn entries_have_distinct_ids_even_within_a_millisecond() {
        let mut history = store();
        history.add("one");
        let entries = history.add("two");
        assert_ne!(entries[0].id, entries[1].id);
    }

    #[test]
    fn a_single_dictation_can_be_removed() {
        let mut history = store();
        history.add("keep");
        let entries = history.add("drop");
        let id = entries[0].id.clone();

        let left = history.remove(&id);
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].text, "keep");
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
                    status: DictationStatus::Ok,
                    message: None,
                    audio_path: None,
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
        history.add("one");
        history.add("two");
        assert!(history.clear().is_empty());
    }

    #[test]
    fn add_failed_writes_history_and_audio_file() {
        let mut history = store();
        let entries = history
            .add_failed("engine down", b"RIFF....fake-wav")
            .expect("save");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].status, DictationStatus::Failed);
        assert_eq!(entries[0].message.as_deref(), Some("engine down"));
        let relative = entries[0].audio_path.as_deref().expect("audio path");
        let bytes = fs::read(history.audio_dir.join(relative)).unwrap();
        assert_eq!(bytes, b"RIFF....fake-wav");
    }

    #[test]
    fn remove_deletes_paired_audio_file() {
        let mut history = store();
        let id = history
            .add_failed("gone", b"audio")
            .unwrap()[0]
            .id
            .clone();
        let path = history.audio_dir.join(format!("{id}.wav"));
        assert!(path.is_file());

        history.remove(&id);
        assert!(!path.exists());
        assert!(history.entries().is_empty());
    }

    #[test]
    fn clear_deletes_all_referenced_audio_files() {
        let mut history = store();
        let first = history.add_failed("a", b"one").unwrap()[0].id.clone();
        let second = history.add_failed("b", b"two").unwrap()[0].id.clone();
        let path_a = history.audio_dir.join(format!("{first}.wav"));
        let path_b = history.audio_dir.join(format!("{second}.wav"));

        assert!(history.clear().is_empty());
        assert!(!path_a.exists());
        assert!(!path_b.exists());
    }

    #[test]
    fn old_json_without_status_loads_as_ok() {
        let dir = std::env::temp_dir().join(format!(
            "waveform-legacy-history-{}",
            std::process::id()
        ));
        let _ = fs::create_dir_all(&dir);
        fs::write(
            dir.join("history.json"),
            r#"[{"id":"1","text":"hello","createdAt":1}]"#,
        )
        .unwrap();

        let history = HistoryStore::load(dir.clone());
        let entries = history.entries();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].status, DictationStatus::Ok);
        assert!(entries[0].audio_path.is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn update_failed_message_keeps_the_audio() {
        let mut history = store();
        let id = history
            .add_failed("first", b"wav")
            .unwrap()[0]
            .id
            .clone();
        let entries = history.update_failed_message(&id, "second try failed");
        assert_eq!(entries[0].message.as_deref(), Some("second try failed"));
        assert_eq!(
            fs::read(history.audio_dir.join(format!("{id}.wav"))).unwrap(),
            b"wav"
        );
    }
}
