//! Keeps dictated text going to the app it was spoken into.
//!
//! The paste is a synthetic ⌘V, so it lands in whatever app is frontmost when
//! the session ends. Opening Waveform's own window mid-dictation made that
//! Waveform, which has nowhere to put the words: the session ended and the
//! text reached only the history. The app that was frontmost when dictation
//! began is remembered, and brought back before pasting if Waveform is the one
//! in front by then.
//!
//! This runs in Waveform rather than the hotkey helper on purpose. macOS lets
//! the active app hand activation to another; a background helper asking for
//! the same thing can be refused.

use objc2::runtime::{AnyObject, Bool};
use objc2::{class, msg_send};

/// `NSApplicationActivateIgnoringOtherApps`. Ignored from macOS 14, where
/// activation from the active app is honoured anyway; still needed before it.
const ACTIVATE_IGNORING_OTHER_APPS: usize = 1 << 1;

fn own_pid() -> i32 {
    std::process::id() as i32
}

/// Process id of the frontmost app, if AppKit reports one.
pub fn frontmost_pid() -> Option<i32> {
    unsafe {
        let workspace: *mut AnyObject = msg_send![class!(NSWorkspace), sharedWorkspace];
        if workspace.is_null() {
            return None;
        }
        let app: *mut AnyObject = msg_send![workspace, frontmostApplication];
        if app.is_null() {
            return None;
        }
        let pid: i32 = msg_send![app, processIdentifier];
        Some(pid)
    }
}

/// The frontmost app, unless it is Waveform itself.
pub fn frontmost_other_app() -> Option<i32> {
    frontmost_pid().filter(|pid| *pid != own_pid())
}

pub fn waveform_is_frontmost() -> bool {
    frontmost_pid() == Some(own_pid())
}

/// Brings `pid` forward. False when it has quit or AppKit refused.
pub fn activate(pid: i32) -> bool {
    unsafe {
        let app: *mut AnyObject = msg_send![
            class!(NSRunningApplication),
            runningApplicationWithProcessIdentifier: pid
        ];
        if app.is_null() {
            return false;
        }
        let terminated: Bool = msg_send![app, isTerminated];
        if terminated.as_bool() {
            return false;
        }
        let activated: Bool = msg_send![app, activateWithOptions: ACTIVATE_IGNORING_OTHER_APPS];
        activated.as_bool()
    }
}
