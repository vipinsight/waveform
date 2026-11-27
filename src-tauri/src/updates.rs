//! Finding out that a new version exists, downloading it in the background,
//! and installing it when the user restarts for it -- or quits, or restarts
//! for any other reason: see [`install_pending_on_exit`].
//!
//! Waveform is not in the App Store, so nothing tells anyone that a release
//! happened. The manifest is a static `latest.json` attached to the newest
//! GitHub release, and the payload is checked against a key compiled into this
//! binary before it is unpacked: Apple's signature says the app came from us,
//! this one says the update did.
//!
//! The check is the only request Waveform makes that the user did not ask for,
//! which is why it can be switched off. Everything else on the network -- AI
//! Polish, a model download -- happens because something was pressed.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

/// A release that is newer than this one.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    /// Release notes. The only thing that says why to bother.
    pub notes: String,
}

/// Progress, so a download of tens of megabytes is not a frozen button.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateEvent {
    pub stage: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<f32>,
    /// The version being offered or installed, so the button can name it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

fn emit(app: &AppHandle, stage: &str, message: &str, progress: Option<f32>) {
    emit_version(app, stage, message, progress, None);
}

fn emit_version(
    app: &AppHandle,
    stage: &str,
    message: &str,
    progress: Option<f32>,
    version: Option<&str>,
) {
    let _ = app.emit(
        "update-event",
        UpdateEvent {
            stage: stage.to_string(),
            message: message.to_string(),
            progress,
            version: version.map(str::to_string),
        },
    );
}

/// A new version, downloaded and verified, waiting for a restart to install it.
struct Downloaded {
    update: Update,
    bytes: Vec<u8>,
}

/// The update a background download finished, if any.
///
/// Kept here so the menu bar and a window opened later can both say so: the
/// event announcing it is gone by the time either asks. Only memory: an update
/// downloaded and never applied is fetched again on the next launch, which is
/// simpler than a file on disk that could outlive the version it was for.
static READY: std::sync::Mutex<Option<Downloaded>> = std::sync::Mutex::new(None);

/// The version downloaded and waiting for a restart, if any.
///
/// Not merely one a check has found: nothing offers a restart until there is
/// something to install on it.
pub fn available() -> Option<String> {
    READY
        .lock()
        .ok()
        .and_then(|ready| ready.as_ref().map(|ready| ready.update.version.clone()))
}

fn set_ready(app: &AppHandle, next: Option<Downloaded>) {
    let changed = READY
        .lock()
        .map(|mut ready| {
            let before = ready.as_ref().map(|ready| ready.update.version.clone());
            let after = next.as_ref().map(|next| next.update.version.clone());
            *ready = next;
            before != after
        })
        .unwrap_or(false);
    // The menu bar's badge and menu item follow this.
    if changed {
        crate::refresh_tray_menu(app);
    }
}

fn take_ready(app: &AppHandle) -> Option<Downloaded> {
    let taken = READY.lock().ok().and_then(|mut ready| ready.take());
    if taken.is_some() {
        crate::refresh_tray_menu(app);
    }
    taken
}

/// Set while a download runs, so a daily check landing in the middle of a slow
/// one does not start a second copy of the same tens of megabytes.
static DOWNLOADING: AtomicBool = AtomicBool::new(false);

/// Set while an install runs. A second press used to start a second download
/// over the first: the button stayed live through the silent re-check.
static INSTALLING: AtomicBool = AtomicBool::new(false);

/// Waits before the first check, then keeps one going daily.
const FIRST_CHECK_AFTER: Duration = Duration::from_secs(20);
const BETWEEN_CHECKS: Duration = Duration::from_secs(24 * 60 * 60);

/// Looks for a new version in the background, for as long as the app runs.
///
/// Waveform can be running with nothing on screen, started at login and left
/// alone for days, so a check at launch alone would never fire again. The
/// setting is read each time round rather than captured: switching it off
/// should stop the next check, not the one after a restart.
pub fn spawn_checks(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Not at launch: the first seconds belong to the window, the engine and
        // the hotkey helper.
        tokio::time::sleep(FIRST_CHECK_AFTER).await;
        loop {
            let wanted = {
                let state = app.state::<crate::AppState>();
                let settings = state.settings.lock().await;
                settings.value().automatic_update_check
            };
            if wanted {
                // The failure is already reported as an event; nothing here can
                // do anything useful about it either way.
                let _ = check(&app).await;
            }
            tokio::time::sleep(BETWEEN_CHECKS).await;
        }
    });
}

/// Asks the manifest what the newest version is, and starts downloading it.
///
/// `None` means this is already it, which is worth saying: a check with no
/// visible outcome reads as broken. The download runs on its own and is
/// announced with a `ready` event; nothing is installed until a restart is
/// asked for, so finding an update never takes the app away mid-dictation.
pub async fn check(app: &AppHandle) -> Result<Option<UpdateInfo>, String> {
    emit(app, "checking", "Checking for updates…", None);

    let outcome = app
        .updater()
        .map_err(|error| format!("The updater is not configured: {error}"))?
        .check()
        .await;

    match outcome {
        Ok(Some(update)) => {
            let info = UpdateInfo {
                version: update.version.clone(),
                notes: update.body.clone().unwrap_or_default(),
            };
            if available().as_deref() == Some(info.version.as_str()) {
                emit_ready(app, &info.version);
            } else {
                // A newer release than the one waiting replaces it once its own
                // download finishes; until then the older one stays offered.
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    // Reported as an event; there is nobody here to tell.
                    let _ = download(&app, update).await;
                });
            }
            Ok(Some(info))
        }
        Ok(None) => {
            set_ready(app, None);
            emit(app, "current", "Waveform is up to date", None);
            Ok(None)
        }
        Err(error) => {
            // Being unable to ask is not the same as there being nothing to
            // find, and saying "up to date" to a failed check is a lie.
            let message = format!("Could not check for updates: {error}");
            // An update already downloaded is still good; a failed check is
            // no reason to stop offering it.
            match available() {
                Some(version) => emit_ready(app, &version),
                None => emit(app, "error", &message, None),
            }
            Err(message)
        }
    }
}

fn emit_ready(app: &AppHandle, version: &str) {
    emit_version(
        app,
        "ready",
        &format!("Waveform {version} is ready"),
        None,
        Some(version),
    );
}

/// Fetches and verifies the update, then keeps it for [`install`].
///
/// Does nothing if a download is already running: whichever check started it
/// will announce the result.
async fn download(app: &AppHandle, update: Update) -> Result<(), String> {
    if DOWNLOADING.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let outcome = download_once(app, update).await;
    DOWNLOADING.store(false, Ordering::SeqCst);
    outcome
}

async fn download_once(app: &AppHandle, update: Update) -> Result<(), String> {
    let version = update.version.clone();
    emit_version(
        app,
        "downloading",
        &format!("Downloading Waveform {version}…"),
        Some(0.0),
        Some(&version),
    );

    let handle = app.clone();
    let mut downloaded: u64 = 0;
    let label = version.clone();
    let bytes = update
        .download(
            move |chunk, total| {
                downloaded += chunk as u64;
                let fraction =
                    total.map(|total| (downloaded as f32 / total.max(1) as f32).min(1.0));
                emit_version(
                    &handle,
                    "downloading",
                    &format!("Downloading Waveform {label}…"),
                    fraction,
                    Some(&label),
                );
            },
            || {},
        )
        .await
        .map_err(|error| {
            let message = format!("Could not download the update: {error}");
            emit(app, "error", &message, None);
            message
        })?;

    set_ready(app, Some(Downloaded { update, bytes }));
    emit_ready(app, &version);
    Ok(())
}

/// Installs the downloaded version. Does not relaunch.
///
/// Normally the bytes are already here. Pressed with nothing downloaded -- a
/// window still showing an offer from before a failed download -- it checks
/// and downloads first, rather than doing nothing.
pub async fn install(app: &AppHandle) -> Result<(), String> {
    if INSTALLING.swap(true, Ordering::SeqCst) {
        return Err("An update is already installing.".into());
    }
    let outcome = install_once(app).await;
    // Only a failure gets here in practice: success is followed by a restart.
    INSTALLING.store(false, Ordering::SeqCst);
    outcome
}

async fn install_once(app: &AppHandle) -> Result<(), String> {
    let ready = match take_ready(app) {
        Some(ready) => ready,
        None => {
            if DOWNLOADING.load(Ordering::SeqCst) {
                let message = "The update is still downloading.".to_string();
                emit(app, "error", &message, None);
                return Err(message);
            }
            let update = app
                .updater()
                .map_err(|error| format!("The updater is not configured: {error}"))?
                .check()
                .await
                .map_err(|error| {
                    let message = format!("Could not check for updates: {error}");
                    emit(app, "error", &message, None);
                    message
                })?
                .ok_or_else(|| {
                    emit(app, "current", "Waveform is up to date", None);
                    "There is no update to install.".to_string()
                })?;
            download(app, update).await?;
            take_ready(app).ok_or_else(|| "The update did not download.".to_string())?
        }
    };

    let version = ready.update.version.clone();
    emit_version(
        app,
        "installing",
        &format!("Installing Waveform {version}…"),
        None,
        Some(&version),
    );
    // A failed install drops the bytes: "Try Again" checks and downloads
    // afresh rather than replaying whatever just failed.
    ready.update.install(&ready.bytes).map_err(|error| {
        let message = format!("Could not install the update: {error}");
        emit(app, "error", &message, None);
        message
    })?;

    emit_version(
        app,
        "installed",
        &format!("Waveform {version} installed — restarting"),
        Some(1.0),
        Some(&version),
    );
    Ok(())
}

/// Installs a downloaded update as the app exits, so the next launch is the
/// new version.
///
/// "Restart to Update" is one way to get it; quitting from the menu bar or
/// with ⌘Q, logging out, or any other restart should be another. Called from
/// the Exit event, which a restart from a background task also passes through
/// before relaunching, so that relaunch lands on the new version too.
///
/// Synchronous and quiet: this runs on the AppKit thread with the app on its
/// way out, so there is no window left to tell and no tray worth refreshing.
/// Skipped when nothing is downloaded, when a download is only part way
/// through, and when "Restart to Update" is already installing -- that path
/// has taken the bytes and will finish on its own. A failure leaves the old
/// version in place, and the next launch's check downloads it again.
///
/// Not called on SIGTERM. That is how `pnpm app` replaces a running dev build,
/// and installing a release over the bundle it just built would undo it.
pub fn install_pending_on_exit() {
    if INSTALLING.swap(true, Ordering::SeqCst) {
        return;
    }
    let ready = READY.lock().ok().and_then(|mut ready| ready.take());
    if let Some(ready) = ready {
        if let Err(error) = ready.update.install(&ready.bytes) {
            eprintln!(
                "Could not install Waveform {} on quit: {error}",
                ready.update.version
            );
        }
    }
    // Left set: the app is exiting, and a second Exit must not try again.
}
