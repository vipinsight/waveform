//! What this binary knows about the bundle it was launched from: its display
//! name, where its data lives, and where the checkout is when there is one.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::Manager;

/// Display name from this bundle's Info.plist, or "Waveform" when there is none
/// — tests, and a binary launched outside an `.app`.
///
/// The checkout build is "Waveform Dev" so it is not the copy in /Applications;
/// a release is "Waveform". Read from the bundle rather than compiled in,
/// because the two share this binary and disagree only in the Info.plist
/// `pnpm app` writes.
pub(crate) fn app_display_name() -> String {
    static NAME: OnceLock<String> = OnceLock::new();
    NAME.get_or_init(|| {
        bundle_plist_string("CFBundleDisplayName")
            .or_else(|| bundle_plist_string("CFBundleName"))
            .unwrap_or_else(|| "Waveform".into())
    })
    .clone()
}

fn bundle_plist_string(key: &str) -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let plist = exe.parent()?.parent()?.join("Info.plist");
    plist_string(&std::fs::read_to_string(plist).ok()?, key)
}

fn plist_string(body: &str, key: &str) -> Option<String> {
    let marker = format!("<key>{key}</key>");
    let rest = body.split_once(&marker)?.1.trim_start();
    let rest = rest.strip_prefix("<string>")?;
    let (value, _) = rest.split_once("</string>")?;
    Some(value.to_string())
}

/// The directory both hosts keep their settings, stats and model runtime in.
///
/// Tauri's `app_config_dir` would resolve to the bundle identifier, but the
/// Electron build uses the app *name*, and the Qwen runtime installer writes
/// there too. Matching that path is what actually lets one configuration and
/// one downloaded runtime serve either host.
pub(crate) fn user_data_dir(app: &tauri::AppHandle) -> PathBuf {
    if cfg!(target_os = "macos") {
        if let Some(home) = crate::paths::waveform_home() {
            return home;
        }
    }
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
}

/// Locates the repo when running unbundled; scripts/ lives beside it.
///
/// `CARGO_MANIFEST_DIR` is resolved by the compiler, so the fallback bakes the
/// build machine's absolute path -- and the builder's username with it -- into
/// the binary as a plain string. `--remap-path-prefix` does not reach an
/// `env!`, so a published build compiles without that arm: an installed .app
/// reads its scripts from the bundle's resources and has no checkout to find.
/// `WAVEFORM_PROJECT_ROOT` still points a dist build at one when asked.
#[cfg(feature = "dist")]
pub(crate) fn project_root() -> PathBuf {
    std::env::var("WAVEFORM_PROJECT_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

/// Locates the repo when running unbundled; scripts/ lives beside it.
#[cfg(not(feature = "dist"))]
pub(crate) fn project_root() -> PathBuf {
    std::env::var("WAVEFORM_PROJECT_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| PathBuf::from("."))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_display_name_from_the_plist() {
        let body = "\
            <key>CFBundleIdentifier</key><string>com.webtiara.waveform.dev</string>\n\
            <key>CFBundleDisplayName</key><string>Waveform Dev</string>\n";
        assert_eq!(
            plist_string(body, "CFBundleDisplayName").as_deref(),
            Some("Waveform Dev")
        );
        assert_eq!(
            plist_string(body, "CFBundleIdentifier").as_deref(),
            Some("com.webtiara.waveform.dev")
        );
        assert_eq!(plist_string(body, "CFBundleName"), None);
    }
}
