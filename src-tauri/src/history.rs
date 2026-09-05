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
        let entries: Vec<Dictation> = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        Self {
            path,
            entries,
            next_id: 0,
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

    fn store() -> HistoryStore {
        HistoryStore {
            path: std::env::temp_dir().join("waveform-history-test.json"),
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
