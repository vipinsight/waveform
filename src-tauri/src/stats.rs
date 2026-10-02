//! Lifetime dictation counters, and the same counts by day.
//!
//! Aggregate counts only -- never transcribed text -- so the Overview can
//! say something true without the app keeping a record of what was said.
//!
//! Three rows in the `stats` table of `waveform.db`, bumped in place, and
//! one row per local day in `daily_stats` for the calendar. An increment is
//! one statement, so two processes counting at once both land, which a
//! counter read into memory and written back as a file could not promise.
//! The day is SQLite's local date, so the calendar follows the Mac's clock
//! and time zone without the app carrying a calendar of its own.

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

/// One day with at least one phrase. `day` is `YYYY-MM-DD` in local time.
#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DayStat {
    pub day: String,
    pub words: u64,
    pub phrases: u64,
}

/// One calendar month with at least one phrase. `month` is `YYYY-MM`.
#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MonthStat {
    pub month: String,
    pub words: u64,
    pub phrases: u64,
    pub active_days: u64,
}

/// What the Overview's calendar and insights are drawn from.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    /// Today, local, so the window lays the grid out on the same clock
    /// the days were counted on.
    pub today: String,
    /// Every day with words in the last 53 weeks, oldest first.
    pub days: Vec<DayStat>,
    /// Every month with words, oldest first.
    pub months: Vec<MonthStat>,
    /// Days in a row ending today, or yesterday if today has nothing yet.
    pub current_streak: u64,
    pub longest_streak: u64,
    /// Days with at least one phrase, ever.
    pub active_days: u64,
}

/// How far back the calendar reaches: a year of weeks, like a commit graph.
const CALENDAR_DAYS: i64 = 53 * 7;

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
            bump_day(&transaction, words)?;
            transaction.commit()
        });
        self.value()
    }

    /// The calendar, the months and the streaks. Unreadable means empty.
    pub fn activity(&self) -> Activity {
        self.db.with(read_activity).unwrap_or_default()
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

/// Adds a phrase to today's row, creating the day on first use.
fn bump_day(connection: &Connection, words: i64) -> rusqlite::Result<()> {
    connection.execute(
        "INSERT INTO daily_stats (day, words, phrases) VALUES (date('now', 'localtime'), ?1, 1)
         ON CONFLICT(day) DO UPDATE SET words = words + excluded.words, phrases = phrases + 1",
        params![words],
    )?;
    Ok(())
}

fn read_activity(connection: &mut Connection) -> rusqlite::Result<Activity> {
    let today: String = connection.query_row("SELECT date('now', 'localtime')", [], |row| row.get(0))?;

    // Every active day as a day number, oldest first, for the streaks; the
    // calendar keeps only the recent ones. julianday is SQLite's own
    // arithmetic, so a leap day or a month end is its problem.
    let mut select = connection.prepare_cached(
        "SELECT day, words, phrases, CAST(julianday(day) AS INTEGER),
                CAST(julianday(date('now', 'localtime')) AS INTEGER) - CAST(julianday(day) AS INTEGER)
           FROM daily_stats
          WHERE phrases > 0
          ORDER BY day",
    )?;
    let mut days = Vec::new();
    let mut numbers: Vec<i64> = Vec::new();
    let mut ages: Vec<i64> = Vec::new();
    for row in select.query_map([], |row| {
        Ok((
            DayStat {
                day: row.get(0)?,
                words: row.get::<_, i64>(1)?.max(0) as u64,
                phrases: row.get::<_, i64>(2)?.max(0) as u64,
            },
            row.get::<_, i64>(3)?,
            row.get::<_, i64>(4)?,
        ))
    })? {
        let (day, number, age) = row?;
        numbers.push(number);
        ages.push(age);
        if age < CALENDAR_DAYS {
            days.push(day);
        }
    }
    let (current_streak, longest_streak) = streaks(&numbers, &ages);

    let mut select = connection.prepare_cached(
        "SELECT substr(day, 1, 7), SUM(words), SUM(phrases), COUNT(*)
           FROM daily_stats
          WHERE phrases > 0
          GROUP BY substr(day, 1, 7)
          ORDER BY substr(day, 1, 7)",
    )?;
    let months = select
        .query_map([], |row| {
            Ok(MonthStat {
                month: row.get(0)?,
                words: row.get::<_, i64>(1)?.max(0) as u64,
                phrases: row.get::<_, i64>(2)?.max(0) as u64,
                active_days: row.get::<_, i64>(3)?.max(0) as u64,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(Activity {
        today,
        days,
        months,
        current_streak,
        longest_streak,
        active_days: numbers.len() as u64,
    })
}

/// The run ending today (or yesterday, when today is still empty) and the
/// longest run ever. `numbers` are day numbers in ascending order; `ages`
/// how many days ago each was.
fn streaks(numbers: &[i64], ages: &[i64]) -> (u64, u64) {
    let mut longest = 0u64;
    let mut run = 0u64;
    let mut previous: Option<i64> = None;
    for &number in numbers {
        run = match previous {
            Some(last) if number == last + 1 => run + 1,
            _ => 1,
        };
        longest = longest.max(run);
        previous = Some(number);
    }
    // The last run counts as current only if it reaches today or yesterday.
    let current = match ages.last() {
        Some(&age) if age <= 1 => run,
        _ => 0,
    };
    (current, longest)
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

    #[test]
    fn a_phrase_lands_on_today() {
        let mut stats = store();
        stats.record_phrase("one two three");
        stats.record_phrase("four");
        let activity = stats.activity();
        assert_eq!(activity.days.len(), 1);
        assert_eq!(activity.days[0].day, activity.today);
        assert_eq!(activity.days[0].words, 4);
        assert_eq!(activity.days[0].phrases, 2);
        assert_eq!(activity.months.len(), 1);
        assert_eq!(activity.months[0].month, &activity.today[..7]);
        assert_eq!(activity.months[0].active_days, 1);
        assert_eq!(activity.current_streak, 1);
        assert_eq!(activity.longest_streak, 1);
        assert_eq!(activity.active_days, 1);
    }

    #[test]
    fn nothing_dictated_means_an_empty_calendar() {
        let activity = store().activity();
        assert!(activity.days.is_empty());
        assert_eq!(activity.current_streak, 0);
        assert_eq!(activity.today.len(), 10);
    }

    /// Streaks are runs of consecutive day numbers; the current one has to
    /// reach today or yesterday.
    #[test]
    fn streaks_follow_consecutive_days() {
        // Three in a row long ago, then two ending yesterday.
        assert_eq!(streaks(&[100, 101, 102, 200, 201], &[105, 104, 103, 2, 1]), (2, 3));
        // Ending today.
        assert_eq!(streaks(&[200, 201, 202], &[2, 1, 0]), (3, 3));
        // Broken two days ago: nothing current, the record stands.
        assert_eq!(streaks(&[200, 201, 202], &[4, 3, 2]), (0, 3));
        assert_eq!(streaks(&[], &[]), (0, 0));
    }

    /// Days before the calendar window stay out of `days` but count toward
    /// the streak record and the active-day total.
    #[test]
    fn old_days_stay_off_the_calendar_but_in_the_totals() {
        let stats = store();
        let _ = stats.db.with(|connection| {
            connection.execute(
                "INSERT INTO daily_stats (day, words, phrases) VALUES (date('now', 'localtime', '-400 days'), 50, 2)",
                [],
            )?;
            connection.execute(
                "INSERT INTO daily_stats (day, words, phrases) VALUES (date('now', 'localtime', '-10 days'), 20, 1)",
                [],
            )
        });
        let activity = stats.activity();
        assert_eq!(activity.days.len(), 1);
        assert_eq!(activity.days[0].words, 20);
        assert_eq!(activity.active_days, 2);
        assert_eq!(activity.months.len(), 2);
        assert_eq!(activity.current_streak, 0);
        assert_eq!(activity.longest_streak, 1);
    }
}
