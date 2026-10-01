//! The one clock every store and log line reads.

/// Milliseconds since the Unix epoch, or zero on a clock set before 1970.
///
/// Zero rather than a panic: this is read while saving a dictation and while
/// logging an error, neither of which should be the thing that fails.
pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or(0)
}
