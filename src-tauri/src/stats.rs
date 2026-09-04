//! Lifetime dictation counters.
//!
//! Aggregate counts only -- never transcribed text -- so the Activity view can
//! say something true without the app keeping a record of what was said.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AppStats {
    pub words: u64,
    pub phrases: u64,
    pub sessions: u64,
}

pub struct StatsStore {
    path: PathBuf,
    current: AppStats,
}

impl StatsStore {
    pub fn load(dir: PathBuf) -> Self {
        let path = dir.join("stats.json");
        let current = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        Self { path, current }
    }

    pub fn value(&self) -> AppStats {
        self.current
    }

    pub fn record_session(&mut self) -> AppStats {
        self.current.sessions += 1;
        self.write();
        self.current
    }

    pub fn record_phrase(&mut self, text: &str) -> AppStats {
        self.current.words += text.split_whitespace().count() as u64;
        self.current.phrases += 1;
        self.write();
        self.current
    }

    fn write(&self) {
        if let Some(parent) = self.path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(body) = serde_json::to_string(&self.current) {
            let _ = fs::write(&self.path, format!("{body}\n"));
        }
    }
}
