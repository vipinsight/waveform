//! What the app is doing, in words, kept where it can be read.
//!
//! Everything interesting here happens across three processes and two
//! webviews: the window, the overlay that owns the microphone, and an engine
//! that is either a subprocess or a blocking thread. When dictation produces
//! nothing there is no single place that says why, and the parts that know are
//! the parts with nowhere to write it down -- so answering "is the model even
//! working?" has meant reading code and guessing.
//!
//! One buffer, one event, and a page that shows it. Lines are pushed by
//! whichever side knows something, kept in memory only, and never written to
//! disk: the transcript store is the only thing this app writes down, and a log
//! that quietly recorded what was dictated would be a second one.
//!
//! `WAVEFORM_LOG_FILE` is the exception, and it is off unless someone sets it.
//! It appends the same lines to a file, for the case this buffer cannot serve:
//! something that goes wrong with the window closed, on a machine somebody else
//! is sitting at. Lines carry counts and stages, never the text itself, so what
//! it writes down is the same thing the page shows.

use std::collections::VecDeque;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

/// Lines kept. Enough for a session's worth of dictation, and small enough
/// that holding it costs nothing worth measuring.
const CAPACITY: usize = 400;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    /// Milliseconds since the epoch, so the page can show a clock time.
    pub at: u64,
    /// `info`, `warn` or `error`.
    pub level: String,
    /// Which part is speaking: `engine`, `capture`, `dictation`, `update`.
    pub source: String,
    pub message: String,
}

pub struct Logs {
    lines: Mutex<VecDeque<LogLine>>,
    /// Where lines are also appended, when asked for. Read once: an env var
    /// that changed under a running app would be a surprise, not a feature.
    file: Option<std::path::PathBuf>,
}

impl Logs {
    pub fn new() -> Self {
        Self {
            lines: Mutex::new(VecDeque::with_capacity(CAPACITY)),
            file: std::env::var_os("WAVEFORM_LOG_FILE").map(std::path::PathBuf::from),
        }
    }

    /// Records a line and pushes it to any window that is listening.
    ///
    /// A poisoned lock is dropped rather than propagated: logging is the thing
    /// that runs while something else is going wrong, and it must not be the
    /// reason a request fails.
    pub fn push(&self, app: &AppHandle, level: &str, source: &str, message: impl Into<String>) {
        let line = LogLine {
            at: now_ms(),
            level: level.to_string(),
            source: source.to_string(),
            message: message.into(),
        };
        if let Ok(mut lines) = self.lines.lock() {
            if lines.len() == CAPACITY {
                lines.pop_front();
            }
            lines.push_back(line.clone());
        }
        self.append(&line);
        let _ = app.emit("log-line", line);
    }

    /// Appends to `WAVEFORM_LOG_FILE`, where one was asked for. Failing to
    /// write is ignored for the reason a poisoned lock is: this runs while
    /// something else is going wrong.
    fn append(&self, line: &LogLine) {
        use std::io::Write;
        let Some(path) = self.file.as_ref() else {
            return;
        };
        let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) else {
            return;
        };
        let _ = writeln!(file, "{} {} {} {}", line.at, line.level, line.source, line.message);
    }

    pub fn info(&self, app: &AppHandle, source: &str, message: impl Into<String>) {
        self.push(app, "info", source, message);
    }

    pub fn error(&self, app: &AppHandle, source: &str, message: impl Into<String>) {
        self.push(app, "error", source, message);
    }

    /// Everything held, oldest first, for a window that opened late.
    pub fn all(&self) -> Vec<LogLine> {
        self.lines
            .lock()
            .map(|lines| lines.iter().cloned().collect())
            .unwrap_or_default()
    }

    pub fn clear(&self) {
        if let Ok(mut lines) = self.lines.lock() {
            lines.clear();
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or(0)
}
