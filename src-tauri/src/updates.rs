//! Finding out that a new version exists, and installing it.
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
use tauri_plugin_updater::UpdaterExt;

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

/// Asks the manifest what the newest version is.
///
/// `None` means this is already it, which is worth saying: a check with no
/// visible outcome reads as broken.
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
            emit_version(
                app,
                "available",
                &format!("Waveform {} is available", info.version),
                None,
                Some(&info.version),
            );
            Ok(Some(info))
        }
        Ok(None) => {
            emit(app, "current", "Waveform is up to date", None);
            Ok(None)
        }
        Err(error) => {
            // Being unable to ask is not the same as there being nothing to
            // find, and saying "up to date" to a failed check is a lie.
            let message = format!("Could not check for updates: {error}");
            emit(app, "error", &message, None);
            Err(message)
        }
    }
}

/// Downloads the new version and swaps it in. Does not relaunch.
///
/// Checks again rather than taking a handle from the caller: the reply to a
/// check crosses to the window as plain data, and one JSON request is cheaper
/// than holding a download open across it.
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
    // Said before the re-check, which is a network round trip: without it the
    // button sat unchanged after the press, and read as not working.
    emit(app, "downloading", "Preparing the update…", None);
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
            let message = "There is no update to install.".to_string();
            emit(app, "current", "Waveform is up to date", None);
            message
        })?;

    let version = update.version.clone();
    emit_version(
        app,
        "downloading",
        &format!("Downloading Waveform {version}…"),
        Some(0.0),
        Some(&version),
    );

    let handle = app.clone();
    let finished = app.clone();
    let downloaded = std::sync::atomic::AtomicU64::new(0);
    let label = version.clone();
    let installing = version.clone();

    update
        .download_and_install(
            move |chunk, total| {
                let done = downloaded
                    .fetch_add(chunk as u64, std::sync::atomic::Ordering::Relaxed)
                    + chunk as u64;
                let fraction = total.map(|total| (done as f32 / total.max(1) as f32).min(1.0));
                emit_version(
                    &handle,
                    "downloading",
                    &format!("Downloading Waveform {label}…"),
                    fraction,
                    Some(&label),
                );
            },
            // Unpacking and swapping the bundle takes a moment of its own;
            // a bar parked at 100% looked stuck.
            move || {
                emit_version(
                    &finished,
                    "installing",
                    &format!("Installing Waveform {installing}…"),
                    None,
                    Some(&installing),
                );
            },
        )
        .await
        .map_err(|error| {
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
