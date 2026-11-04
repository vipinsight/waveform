//! Deleting old recordings.
//!
//! "Keep audio for" deletes the WAVs of dictations and meetings older than
//! the chosen window. Only the audio goes: transcripts, polished text and
//! summaries stay. Nothing is deleted until `GRACE_MS` after the window was
//! last changed, so picking a shorter one by mistake can be put back before
//! anything is lost.

use crate::history::HistoryStore;
use crate::meetings::MeetingsStore;
use crate::settings::AppSettings;
use std::time::{SystemTime, UNIX_EPOCH};

/// The windows offered, in days. Zero keeps recordings forever.
pub const KEEP_DAYS: [u32; 5] = [0, 1, 14, 30, 60];

/// How long a change to the window waits before anything is deleted.
pub const GRACE_MS: u64 = 2 * 60 * 60 * 1000;

/// How often the app looks for recordings past the window.
pub const SWEEP_EVERY: std::time::Duration = std::time::Duration::from_secs(15 * 60);

const DAY_MS: u64 = 24 * 60 * 60 * 1000;

/// Recordings made before this are deleted, or `None` when nothing should be:
/// the window is "forever", or it changed less than `GRACE_MS` ago.
pub fn cutoff(settings: &AppSettings, now_ms: u64) -> Option<u64> {
    if settings.keep_audio_days == 0 {
        return None;
    }
    if settings
        .keep_audio_changed_at
        .is_some_and(|changed| now_ms < changed.saturating_add(GRACE_MS))
    {
        return None;
    }
    Some(now_ms.saturating_sub(u64::from(settings.keep_audio_days) * DAY_MS))
}

/// Deletes what is past the window. Returns (dictations, meetings) that lost
/// their audio.
pub fn sweep(
    settings: &AppSettings,
    history: &mut HistoryStore,
    meetings: &mut MeetingsStore,
    now_ms: u64,
) -> Result<(usize, usize), String> {
    let Some(cutoff) = cutoff(settings, now_ms) else {
        return Ok((0, 0));
    };
    Ok((history.drop_audio_before(cutoff)?, meetings.drop_audio_before(cutoff)?))
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keeping(days: u32, changed_at: Option<u64>) -> AppSettings {
        AppSettings {
            keep_audio_days: days,
            keep_audio_changed_at: changed_at,
            ..AppSettings::default()
        }
    }

    #[test]
    fn forever_deletes_nothing() {
        assert_eq!(cutoff(&keeping(0, None), 100 * DAY_MS), None);
    }

    #[test]
    fn the_window_counts_back_from_now() {
        let now = 100 * DAY_MS;
        assert_eq!(cutoff(&keeping(14, None), now), Some(86 * DAY_MS));
        assert_eq!(cutoff(&keeping(1, None), now), Some(99 * DAY_MS));
    }

    /// A shorter window waits out the grace period before it deletes.
    #[test]
    fn a_change_waits_before_deleting() {
        let changed = 100 * DAY_MS;
        let settings = keeping(1, Some(changed));
        assert_eq!(cutoff(&settings, changed), None);
        assert_eq!(cutoff(&settings, changed + GRACE_MS - 1), None);
        assert_eq!(
            cutoff(&settings, changed + GRACE_MS),
            Some(changed + GRACE_MS - DAY_MS)
        );
    }
}
