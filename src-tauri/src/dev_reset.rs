//! "Reset to a new install", for the checkout build only.
//!
//! Trying onboarding, a migration or the permission prompts again used to mean
//! quitting, deleting four folders by hand, running `tccutil` and relaunching.
//! This does the same from the Settings window.
//!
//! The erase cannot happen in this process: the engine, the history store and
//! the window-state plugin all still have files open, and some of them write on
//! the way out. So the app hands the work to a detached shell that waits for it
//! to exit, erases, resets permissions and opens the bundle again.

use std::path::PathBuf;
use std::process::{Command, Stdio};

/// The checkout build's bundle id, which TCC keys its grants by.
const BUNDLE_ID: &str = "com.webtiara.waveform.dev";

/// Whether this binary is the `pnpm app` build. Gated on `dev-data`, the same
/// feature that gives it its own Application Support folder, so a published
/// build can never offer to erase the real profile.
pub const ENABLED: bool = cfg!(feature = "dev-data");

/// Everything a fresh install would not have: settings, history, stats, models
/// and runtimes, the webview's storage and caches, and the defaults domain.
///
/// Legacy model locations outside Application Support (the NeMo cache, the
/// user Hugging Face hub) are left alone: the released app reads them too.
fn data_paths(config_dir: Option<PathBuf>) -> Vec<PathBuf> {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return Vec::new();
    };
    let library = home.join("Library");
    let mut paths: Vec<PathBuf> = crate::paths::waveform_home().into_iter().collect();
    paths.extend(config_dir);
    paths.extend([
        library.join("Caches").join(BUNDLE_ID),
        library.join("WebKit").join(BUNDLE_ID),
        library.join("HTTPStorages").join(BUNDLE_ID),
        library.join("HTTPStorages").join(format!("{BUNDLE_ID}.binarycookies")),
        library
            .join("Saved Application State")
            .join(format!("{BUNDLE_ID}.savedState")),
        library.join("Preferences").join(format!("{BUNDLE_ID}.plist")),
    ]);
    paths
}

/// The `.app` this binary runs from, so the relaunch opens the same build.
fn bundle_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let bundle = exe.parent()?.parent()?.parent()?;
    (bundle.extension()? == "app").then(|| bundle.to_path_buf())
}

/// Waits for `pid` (and the helpers inside the bundle) to exit, erases, resets
/// TCC and relaunches. Positional arguments: pid, bundle (may be empty), paths.
const SCRIPT: &str = r#"
pid="$1"; bundle="$2"; shift 2
n=0
while kill -0 "$pid" 2>/dev/null && [ "$n" -lt 150 ]; do sleep 0.1; n=$((n + 1)); done
if [ -n "$bundle" ]; then
  n=0
  while pgrep -f "$bundle/Contents/" >/dev/null 2>&1 && [ "$n" -lt 50 ]; do sleep 0.1; n=$((n + 1)); done
fi
defaults delete "$BUNDLE_ID" >/dev/null 2>&1
for path in "$@"; do rm -rf "$path"; done
tccutil reset All "$BUNDLE_ID" >/dev/null 2>&1
# The bundled helpers are signed as their own clients; clear whatever they got.
tccutil reset All waveform-hotkey >/dev/null 2>&1
tccutil reset All waveform-audiotap >/dev/null 2>&1
if [ -n "$bundle" ]; then open -n "$bundle"; fi
"#;

/// Starts the detached eraser. The caller exits the app right after.
pub fn schedule(config_dir: Option<PathBuf>) -> Result<(), String> {
    if !ENABLED {
        return Err("Reset is only available in the development build.".into());
    }
    let bundle = bundle_path()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default();
    Command::new("/bin/sh")
        .arg("-c")
        .arg(SCRIPT)
        .arg("waveform-dev-reset")
        .arg(std::process::id().to_string())
        .arg(bundle)
        .args(data_paths(config_dir))
        .env("BUNDLE_ID", BUNDLE_ID)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not start the reset: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn erases_only_this_builds_folders() {
        for path in data_paths(None) {
            let text = path.to_string_lossy();
            assert!(
                text.contains(BUNDLE_ID) || text.ends_with(crate::paths::DATA_DIR),
                "{text}"
            );
        }
    }
}
