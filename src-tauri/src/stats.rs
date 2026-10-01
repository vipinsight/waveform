//! Lifetime dictation counters.
//!
//! Aggregate counts only -- never transcribed text -- so the Activity view can
//! say something true without the app keeping a record of what was said.
//!
//! Three rows in the `stats` table of `waveform.db`, bumped in place. An
//! increment is one statement, so two processes counting at once both land,
//! which a counter read into memory and written back as a file could not
//! promise.

use crate::store::Database;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AppStats {
    pub words: u64,
    pub phrases: u64,
    pub sessions: u64,
}

pub struct StatsStore {
    db: Database,
}

impl StatsStore {
    pub fn new(db: Database) -> Self {
        Self { db }
    }

    /// The counters as they stand. A database that cannot be read reports
    /// zeros rather than failing the page that asked.
    pub fn value(&self) -> AppStats {
        self.db.with(read).unwrap_or_default()
    }

    pub fn record_session(&mut self) -> AppStats {
        let _ = self.db.with(|connection| bump(connection, "sessions", 1));
        self.value()
    }

    pub fn record_phrase(&mut self, text: &str) -> AppStats {
        let words = text.split_whitespace().count() as i64;
        let _ = self.db.with(|connection| {
            let transaction = connection.transaction()?;
            bump(&transaction, "words", words)?;
            bump(&transaction, "phrases", 1)?;
            transaction.commit()
        });
        self.value()
    }
}

fn read(connection: &mut Connection) -> rusqlite::Result<AppStats> {
    let mut select = connection.prepare_cached("SELECT key, value FROM stats")?;
    let mut stats = AppStats::default();
    for row in select.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))? {
        let (key, value) = row?;
        let value = value.max(0) as u64;
        match key.as_str() {
            "words" => stats.words = value,
            "phrases" => stats.phrases = value,
            "sessions" => stats.sessions = value,
            _ => {}
        }
    }
    Ok(stats)
}

/// Adds to a counter, creating it on first use.
fn bump(connection: &Connection, key: &str, by: i64) -> rusqlite::Result<()> {
    connection.execute(
        "INSERT INTO stats (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = value + excluded.value",
        params![key, by],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::temp_dir;

    fn store() -> StatsStore {
        StatsStore::new(Database::open(&temp_dir("stats")).database)
    }

    #[test]
    fn starts_at_zero() {
        let stats = store().value();
        assert_eq!((stats.words, stats.phrases, stats.sessions), (0, 0, 0));
    }

    #[test]
    fn counts_words_phrases_and_sessions() {
        let mut stats = store();
        stats.record_session();
        stats.record_phrase("one two three");
        let value = stats.record_phrase("four");
        assert_eq!(value.sessions, 1);
        assert_eq!(value.phrases, 2);
        assert_eq!(value.words, 4);
    }

    /// Two processes counting at once both land.
    #[test]
    fn a_second_counter_adds_to_the_same_total() {
        let mut first = store();
        first.record_phrase("a b");
        let mut second = StatsStore::new(Database::open(first.db.dir()).database);
        let value = second.record_phrase("c");
        assert_eq!(value.words, 3);
        assert_eq!(value.phrases, 2);
        assert_eq!(first.value().words, 3);
    }
}
