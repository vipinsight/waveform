//! Saved dictations.
//!
//! This is the one place the app keeps what was said. It stays on this machine,
//! is capped so it cannot grow without bound, and every entry can be deleted
//! individually or all at once.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

/// Older dictations are dropped past this point. A transcript is cheap, but an
/// unbounded file that is read at every launch is not.
const MAX_ENTRIES: usize = 300;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Dictation {
    pub id: String,
    pub text: String,
    /// Milliseconds since the epoch, so the interface can format it locally.
    pub created_at: u64,
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

        self.next_id += 1;
        let created_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|since| since.as_millis() as u64)
            .unwrap_or(0);

        self.entries.insert(
            0,
            Dictation {
                // The clock can repeat across a restart, so the counter keeps
                // ids unique within a run.
                id: format!("{created_at}-{}", self.next_id),
                text: trimmed.to_string(),
                created_at,
            },
        );
        self.entries.truncate(MAX_ENTRIES);
        self.write();
        self.entries()
    }

    pub fn remove(&mut self, id: &str) -> Vec<Dictation> {
        self.sync_from_disk();
        self.entries.retain(|entry| entry.id != id);
        self.write();
        self.entries()
    }

    pub fn clear(&mut self) -> Vec<Dictation> {
        self.entries.clear();
        self.write();
        self.entries()
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A file of its own per store: add() reads the file back now, so a shared
    /// path would carry one test's dictations into the next.
    fn store() -> HistoryStore {
        use std::sync::atomic::{AtomicU32, Ordering};
        static COUNT: AtomicU32 = AtomicU32::new(0);
        let name = format!(
            "waveform-history-test-{}-{}.json",
            std::process::id(),
            COUNT.fetch_add(1, Ordering::Relaxed)
        );
        HistoryStore {
            path: std::env::temp_dir().join(name),
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
        for index in 0..MAX_ENTRIES + 25 {
            history.add(&format!("entry {index}"));
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
}
