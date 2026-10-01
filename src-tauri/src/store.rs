//! The one database the app keeps: `waveform.db`, beside the audio folder.
//!
//! Text and numbers only. Audio stays as one WAV per entry on disk, and the
//! database holds the file name, never the bytes. SQLite in WAL mode lets a
//! second process -- a stale build still running, a future helper -- write at
//! the same time without either losing the other's rows, which is the failure
//! the whole-file JSON stores could only paper over by re-reading before
//! every write.
//!
//! The file is created readable only by this user. SQLite gives the `-wal` and
//! `-shm` files the main file's permissions, so setting them once, before the
//! first write, covers all three.

use rusqlite::{Connection, OpenFlags};
use serde::Deserialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// Bumped when the schema changes; `migrate_schema` brings older files up.
const SCHEMA_VERSION: i64 = 2;

/// Shared handle to the open database.
///
/// Cloning shares the connection. The stores built on it (`HistoryStore`,
/// `StatsStore`) each sit behind their own async lock in the app, and this
/// mutex is what keeps their statements from interleaving on one connection.
#[derive(Clone)]
pub struct Database {
    connection: Arc<Mutex<Connection>>,
    dir: PathBuf,
}

/// What opening the database did, for the app log.
///
/// Opening cannot log itself -- the logger is built after the stores -- so it
/// hands back what it has to say.
pub struct Opened {
    pub database: Database,
    pub notes: Vec<String>,
}

impl Database {
    /// Opens or creates `waveform.db` in `dir`, bringing the schema up to date
    /// and importing the JSON files it replaces, if they are still there.
    ///
    /// A file that exists but is not a database is kept under another name
    /// rather than overwritten: it may still be someone's only copy. If even
    /// a fresh file cannot be opened, the app runs on a database in memory so
    /// dictation still works for this session, and says so.
    pub fn open(dir: &Path) -> Opened {
        let _ = fs::create_dir_all(dir);
        let path = dir.join("waveform.db");
        let mut notes = Vec::new();

        match Self::open_file(&path) {
            Ok(database) => {
                notes.extend(database.import_json(dir));
                return Opened { database, notes };
            }
            Err(error) => notes.push(format!("waveform.db could not be opened: {error}")),
        }

        set_aside(&path, &mut notes);

        match Self::open_file(&path) {
            Ok(database) => {
                notes.extend(database.import_json(dir));
                Opened { database, notes }
            }
            Err(error) => {
                notes.push(format!(
                    "a fresh waveform.db could not be opened either ({error}); \
                     keeping this session's dictations in memory only"
                ));
                let connection =
                    Connection::open_in_memory().expect("an in-memory SQLite database");
                let database = Self {
                    connection: Arc::new(Mutex::new(connection)),
                    dir: dir.to_path_buf(),
                };
                database
                    .with(migrate_schema)
                    .expect("schema on an in-memory database");
                Opened { database, notes }
            }
        }
    }

    /// Where the app's data lives; the audio folder is a sibling of the file.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Runs `work` with the connection. Use a transaction inside for anything
    /// that touches more than one row.
    pub fn with<T>(
        &self,
        work: impl FnOnce(&mut Connection) -> rusqlite::Result<T>,
    ) -> rusqlite::Result<T> {
        // A panic while holding the lock poisons it; the data underneath is
        // still fine, so carry on with the connection rather than failing
        // every later call.
        let mut guard = self
            .connection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        work(&mut guard)
    }

    fn open_file(path: &Path) -> rusqlite::Result<Self> {
        // Created empty by us first so the permissions are right before
        // SQLite writes a byte -- and before it creates the WAL beside it.
        if !path.exists() {
            let _ = fs::write(path, b"");
        }
        restrict(path);

        let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX;
        let mut connection = Connection::open_with_flags(path, flags)?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        // WAL is what lets two processes write without one blocking the
        // other for the length of a transaction. NORMAL sync is safe under
        // WAL: a crash loses at most the last transaction, never the file.
        connection.pragma_update(None, "journal_mode", "wal")?;
        connection.pragma_update(None, "synchronous", "normal")?;
        connection.pragma_update(None, "foreign_keys", "on")?;
        migrate_schema(&mut connection)?;

        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
            dir: path.parent().unwrap_or_else(|| Path::new(".")).to_path_buf(),
        })
    }

    /// Imports `history.json` and `stats.json` if the tables they feed are
    /// still empty, then renames each file so it is not imported twice.
    ///
    /// Each file is its own transaction: a history file that will not parse
    /// does not stop the counters coming across, and vice versa. A file that
    /// fails is left exactly where it was, so nothing is lost by trying.
    fn import_json(&self, dir: &Path) -> Vec<String> {
        let mut notes = Vec::new();
        let history = dir.join("history.json");
        let stats = dir.join("stats.json");

        if history.exists() {
            match self.with(|connection| import_history(connection, &history)) {
                Ok(Some(count)) => {
                    notes.push(format!("imported {count} dictation(s) from history.json"));
                    retire(&history);
                }
                Ok(None) => {}
                Err(error) => notes.push(format!("history.json was not imported: {error}")),
            }
        }
        if stats.exists() {
            match self.with(|connection| import_stats(connection, &stats)) {
                Ok(true) => {
                    notes.push("imported the lifetime counters from stats.json".to_string());
                    retire(&stats);
                }
                Ok(false) => {}
                Err(error) => notes.push(format!("stats.json was not imported: {error}")),
            }
        }
        notes
    }
}

/// Creates the tables, or brings an older file up to `SCHEMA_VERSION`.
fn migrate_schema(connection: &mut Connection) -> rusqlite::Result<()> {
    let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version >= SCHEMA_VERSION {
        return Ok(());
    }
    let transaction = connection.transaction()?;
    if version < 1 {
        transaction.execute_batch(
            "CREATE TABLE IF NOT EXISTS dictations (
                id               TEXT PRIMARY KEY,
                created_at       INTEGER NOT NULL,
                transcribed_text TEXT NOT NULL,
                polished_text    TEXT,
                speech_model     TEXT NOT NULL,
                polish_model     TEXT,
                audio_file       TEXT
            );
            CREATE INDEX IF NOT EXISTS dictations_created_at
                ON dictations(created_at DESC);
            CREATE TABLE IF NOT EXISTS stats (
                key   TEXT PRIMARY KEY,
                value INTEGER NOT NULL
            );",
        )?;
    }
    if version < 2 {
        transaction.execute_batch(
            "CREATE TABLE IF NOT EXISTS dictionary (
                id           INTEGER PRIMARY KEY,
                text         TEXT NOT NULL COLLATE NOCASE UNIQUE,
                heard_as     TEXT NOT NULL DEFAULT '[]',
                source       TEXT NOT NULL,
                uses         INTEGER NOT NULL DEFAULT 0,
                last_used_at INTEGER,
                created_at   INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS dictionary_declined (
                heard_as TEXT NOT NULL,
                text     TEXT NOT NULL,
                count    INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (heard_as, text)
            );",
        )?;
    }
    transaction.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    transaction.commit()
}

/// The shape `history.json` had. Kept only to read it one last time.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyDictation {
    id: String,
    text: String,
    created_at: u64,
    #[serde(default)]
    has_audio: bool,
}

/// What the old file wrote for a recording the engine found no words in.
/// Those rows become an empty transcript; the window puts the words back.
const LEGACY_PLACEHOLDER: &str = "(No words detected)";

/// Speech model recorded for rows that predate the column.
pub const UNKNOWN_MODEL: &str = "unknown";

/// Imports the old history file. `None` when the table already has rows.
fn import_history(connection: &mut Connection, path: &Path) -> rusqlite::Result<Option<usize>> {
    let existing: i64 = connection.query_row("SELECT COUNT(*) FROM dictations", [], |row| row.get(0))?;
    if existing > 0 {
        return Ok(None);
    }
    let raw = fs::read_to_string(path).map_err(invalid)?;
    let entries: Vec<LegacyDictation> = serde_json::from_str(&raw).map_err(invalid)?;
    let audio_dir = path.parent().unwrap_or_else(|| Path::new(".")).join("audio");

    let transaction = connection.transaction()?;
    let mut count = 0;
    {
        let mut insert = transaction.prepare(
            "INSERT OR IGNORE INTO dictations
                (id, created_at, transcribed_text, polished_text, speech_model, polish_model, audio_file)
             VALUES (?1, ?2, ?3, NULL, ?4, NULL, ?5)",
        )?;
        for entry in entries {
            let text = if entry.text == LEGACY_PLACEHOLDER {
                String::new()
            } else {
                entry.text
            };
            let audio_file = format!("{}.wav", entry.id);
            let audio = if entry.has_audio && audio_dir.join(&audio_file).exists() {
                Some(audio_file)
            } else {
                None
            };
            count += insert.execute(rusqlite::params![
                entry.id,
                entry.created_at as i64,
                text,
                UNKNOWN_MODEL,
                audio
            ])?;
        }
    }
    transaction.commit()?;
    Ok(Some(count))
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct LegacyStats {
    words: u64,
    phrases: u64,
    sessions: u64,
}

/// Imports the old counters. `false` when the table already has rows.
fn import_stats(connection: &mut Connection, path: &Path) -> rusqlite::Result<bool> {
    let existing: i64 = connection.query_row("SELECT COUNT(*) FROM stats", [], |row| row.get(0))?;
    if existing > 0 {
        return Ok(false);
    }
    let raw = fs::read_to_string(path).map_err(invalid)?;
    let stats: LegacyStats = serde_json::from_str(&raw).map_err(invalid)?;

    let transaction = connection.transaction()?;
    for (key, value) in [
        ("words", stats.words),
        ("phrases", stats.phrases),
        ("sessions", stats.sessions),
    ] {
        transaction.execute(
            "INSERT INTO stats (key, value) VALUES (?1, ?2)",
            rusqlite::params![key, value as i64],
        )?;
    }
    transaction.commit()?;
    Ok(true)
}

/// Renames an imported file to `<stem>.migrated.json`, so it is kept for a
/// release or two in case the import has to be checked, and never read again.
fn retire(path: &Path) {
    let stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("file");
    let _ = fs::rename(path, path.with_file_name(format!("{stem}.migrated.json")));
}

/// Moves a database that would not open out of the way, with its WAL.
fn set_aside(path: &Path, notes: &mut Vec<String>) {
    for suffix in ["", "-wal", "-shm"] {
        let from = PathBuf::from(format!("{}{suffix}", path.display()));
        if !from.exists() {
            continue;
        }
        let to = path.with_file_name(format!("waveform.unreadable.db{suffix}"));
        let _ = fs::rename(&from, &to);
    }
    notes.push("waveform.db was kept as waveform.unreadable.db and a new one started".to_string());
}

/// Readable only by this user: it holds everything they dictated.
fn restrict(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    let _ = path;
}

/// Wraps a non-SQLite failure so it travels through `rusqlite::Result`.
fn invalid(error: impl std::error::Error + Send + Sync + 'static) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(error))
}

#[cfg(test)]
pub(crate) fn temp_dir(label: &str) -> PathBuf {
    use std::sync::atomic::{AtomicU32, Ordering};
    static COUNT: AtomicU32 = AtomicU32::new(0);
    let dir = std::env::temp_dir().join(format!(
        "waveform-{label}-{}-{}",
        std::process::id(),
        COUNT.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::create_dir_all(&dir);
    dir
}

#[cfg(test)]
mod tests {
    use super::*;

    fn count(database: &Database, table: &str) -> i64 {
        database
            .with(|connection| {
                connection.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0))
            })
            .unwrap()
    }

    #[test]
    fn creates_the_file_readable_only_by_this_user() {
        let dir = temp_dir("store-perms");
        let opened = Database::open(&dir);
        assert!(opened.notes.is_empty(), "{:?}", opened.notes);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(dir.join("waveform.db")).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn a_file_that_is_not_a_database_is_kept_under_another_name() {
        let dir = temp_dir("store-corrupt");
        fs::write(dir.join("waveform.db"), "this is not sqlite, it is prose").unwrap();

        let opened = Database::open(&dir);

        assert_eq!(
            fs::read_to_string(dir.join("waveform.unreadable.db")).unwrap(),
            "this is not sqlite, it is prose"
        );
        assert_eq!(count(&opened.database, "dictations"), 0);
        assert!(opened.notes.iter().any(|note| note.contains("unreadable")));
    }

    #[test]
    fn imports_the_old_files_once_and_retires_them() {
        let dir = temp_dir("store-import");
        let _ = fs::create_dir_all(dir.join("audio"));
        fs::write(dir.join("audio").join("100-1.wav"), b"RIFF").unwrap();
        fs::write(
            dir.join("history.json"),
            r#"[
              {"id":"200-2","text":"(No words detected)","createdAt":200,"hasAudio":true},
              {"id":"100-1","text":"hello there","createdAt":100,"hasAudio":true}
            ]"#,
        )
        .unwrap();
        fs::write(dir.join("stats.json"), r#"{"words":12,"phrases":3,"sessions":2}"#).unwrap();

        let opened = Database::open(&dir);

        assert_eq!(count(&opened.database, "dictations"), 2);
        let (text, model, audio): (String, String, Option<String>) = opened
            .database
            .with(|connection| {
                connection.query_row(
                    "SELECT transcribed_text, speech_model, audio_file FROM dictations WHERE id = '100-1'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
            })
            .unwrap();
        assert_eq!(text, "hello there");
        assert_eq!(model, UNKNOWN_MODEL);
        assert_eq!(audio.as_deref(), Some("100-1.wav"));

        // The placeholder becomes an empty transcript; its WAV is gone, so no file is promised.
        let (text, audio): (String, Option<String>) = opened
            .database
            .with(|connection| {
                connection.query_row(
                    "SELECT transcribed_text, audio_file FROM dictations WHERE id = '200-2'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
            })
            .unwrap();
        assert_eq!(text, "");
        assert_eq!(audio, None);

        let sessions: i64 = opened
            .database
            .with(|connection| {
                connection.query_row("SELECT value FROM stats WHERE key = 'sessions'", [], |row| {
                    row.get(0)
                })
            })
            .unwrap();
        assert_eq!(sessions, 2);

        assert!(!dir.join("history.json").exists());
        assert!(dir.join("history.migrated.json").exists());
        assert!(!dir.join("stats.json").exists());
        assert!(dir.join("stats.migrated.json").exists());

        // Opening again finds nothing to import and changes nothing.
        let again = Database::open(&dir);
        assert!(again.notes.is_empty(), "{:?}", again.notes);
        assert_eq!(count(&again.database, "dictations"), 2);
    }

    #[test]
    fn a_history_file_that_will_not_parse_is_left_alone() {
        let dir = temp_dir("store-bad-json");
        fs::write(dir.join("history.json"), "{not json").unwrap();
        fs::write(dir.join("stats.json"), r#"{"words":1}"#).unwrap();

        let opened = Database::open(&dir);

        assert_eq!(fs::read_to_string(dir.join("history.json")).unwrap(), "{not json");
        assert!(opened.notes.iter().any(|note| note.contains("history.json was not imported")));
        // The other file still came across.
        assert!(dir.join("stats.migrated.json").exists());
        assert_eq!(count(&opened.database, "stats"), 3);
    }

    #[test]
    fn two_handles_on_one_file_see_each_other() {
        let dir = temp_dir("store-two");
        let first = Database::open(&dir).database;
        let second = Database::open(&dir).database;
        first
            .with(|connection| {
                connection.execute(
                    "INSERT INTO stats (key, value) VALUES ('words', 5)",
                    [],
                )
            })
            .unwrap();
        let seen: i64 = second
            .with(|connection| {
                connection.query_row("SELECT value FROM stats WHERE key = 'words'", [], |row| row.get(0))
            })
            .unwrap();
        assert_eq!(seen, 5);
    }
}
