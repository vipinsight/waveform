//! Turns the HUD into a panel that does not activate Waveform.
//!
//! The HUD is built non-focusable so it can never take focus from the app being
//! dictated into -- the whole insertion path depends on that, because the paste
//! is a synthetic keystroke and lands wherever focus happens to be. But
//! `focusable(false)` only teaches the window to refuse *key* status: tao
//! overrides `canBecomeKeyWindow`, and nothing more. The window is an ordinary
//! `NSWindow`, and clicking any ordinary window of a background application
//! activates that application. So pressing cancel or accept made Waveform
//! frontmost, and the paste that followed had nowhere right to go.
//!
//! AppKit has exactly one answer to this: `NSWindowStyleMaskNonactivatingPanel`,
//! which it honours only on an `NSPanel`. There is no way to ask for it after
//! the fact, so the window is given a new class -- a subclass of `NSPanel` that
//! still refuses key status, keeping the original promise intact.
//!
//! Reclassing a live object is a real liberty, so it is taken carefully:
//!
//!   * An object cannot be reclassed into something that needs more storage
//!     than it was allocated with. `NSPanel` adds no instance variables to
//!     `NSWindow` today, but that is AppKit's business and not a promise, so
//!     the sizes are compared and the swap is refused if they ever disagree.
//!   * tao's subclass also overrides `sendEvent:`, to drag a window by its
//!     background. Waveform does not use that -- the HUD is dragged from the
//!     renderer in screen coordinates -- and the superclass call it wraps is
//!     what `NSPanel` does anyway.
//!   * tao keeps a `focusable` instance variable, read only by the overrides
//!     being replaced and written only by `set_focusable`, which is never
//!     called on this window. Calling it after this point would not find the
//!     variable.

use objc2::runtime::{AnyClass, AnyObject, Bool, ClassBuilder, Sel};
use objc2::{class, msg_send, sel};
use std::ffi::CStr;
use std::sync::OnceLock;

/// `NSWindowStyleMaskNonactivatingPanel`, which AppKit honours only on a panel.
const NON_ACTIVATING_PANEL: usize = 1 << 7;

const CLASS_NAME: &CStr = c"WaveformPanel";

/// Answers `canBecomeKeyWindow` and `canBecomeMainWindow`.
///
/// A non-activating panel is allowed to take keys without its app coming
/// forward, which is more than the HUD wants: it has no text to type into, and
/// a panel holding keys is a panel the dictated text could be pasted into.
extern "C" fn refuse(_: &AnyObject, _: Sel) -> Bool {
    Bool::NO
}

fn panel_class() -> Option<&'static AnyClass> {
    static CLASS: OnceLock<Option<&'static AnyClass>> = OnceLock::new();
    *CLASS.get_or_init(|| {
        if let Some(existing) = AnyClass::get(CLASS_NAME) {
            return Some(existing);
        }
        let mut builder = ClassBuilder::new(CLASS_NAME, class!(NSPanel))?;
        unsafe {
            builder.add_method(
                sel!(canBecomeKeyWindow),
                refuse as extern "C" fn(_, _) -> Bool,
            );
            builder.add_method(
                sel!(canBecomeMainWindow),
                refuse as extern "C" fn(_, _) -> Bool,
            );
        }
        Some(builder.register())
    })
}

/// Must run on the main thread, which is where Tauri's setup hook already is.
pub fn make_non_activating(window: &tauri::WebviewWindow) -> Result<(), String> {
    let pointer = window.ns_window().map_err(|error| error.to_string())?;
    if pointer.is_null() {
        return Err("the HUD has no NSWindow".into());
    }
    let object = unsafe { &*(pointer as *mut AnyObject) };
    let panel = panel_class().ok_or("could not register WaveformPanel")?;

    let current = object.class();
    if panel.instance_size() > current.instance_size() {
        return Err(format!(
            "{} needs {} bytes and the window was allocated {}",
            panel.name().to_string_lossy(),
            panel.instance_size(),
            current.instance_size(),
        ));
    }

    unsafe {
        objc2::ffi::object_setClass(pointer as *mut AnyObject, panel);
        let mask: usize = msg_send![object, styleMask];
        let _: () = msg_send![object, setStyleMask: mask | NON_ACTIVATING_PANEL];
        // Panels take themselves off screen when their application deactivates,
        // which is precisely when this one has to be visible.
        let _: () = msg_send![object, setHidesOnDeactivate: false];
    }
    Ok(())
}
