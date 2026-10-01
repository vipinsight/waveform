//! Everything that happens once, at launch: opening the stores, building the
//! engines and the dictation coordinator, creating the windows, and deciding
//! what the app looks like when it comes up. And the two run events that need
//! the same state at the other end of the process's life.

use crate::bundle::{app_display_name, project_root, user_data_dir};
use crate::commands::dictionary::split_terms;
use crate::commands::settings::set_launch_at_login;
use crate::dictation::Dictation;
use crate::dictionary::{self, DictionaryStore};
use crate::history::HistoryStore;
use crate::local_llm::LocalDownloads;
use crate::meeting::{self, Recorder};
use crate::meetings::MeetingsStore;
use crate::model_server::{ModelEvent, ModelServer};
use crate::overlay_window::{build_overlay_window, watch_overlay_hover};
use crate::rewrite::Rewriter;
use crate::settings::SettingsStore;
use crate::state::AppState;
use crate::stats::StatsStore;
use crate::transcribe::Engine;
use crate::tray::build_tray;
use crate::windows::{present_main_window, MAIN_LABEL};
use crate::{logs, mic, resources, store, updates};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use tauri::{ActivationPolicy, Emitter, Manager, RunEvent, WindowEvent};
use tokio::sync::Mutex;

/// The argument the login item launches with, so a start at login can be
/// told from a start by hand.
pub(crate) const AUTOSTART_ARG: &str = "--autostart";

pub(crate) fn setup(app: &mut tauri::App, started_at_login: bool) -> Result<(), Box<dyn std::error::Error>> {
    let user_data = user_data_dir(app.handle());
    std::fs::create_dir_all(&user_data).ok();

    let settings = Arc::new(Mutex::new(SettingsStore::load(user_data.clone())));
    let opened = store::Database::open(&user_data);
    let stats = Arc::new(Mutex::new(StatsStore::new(opened.database.clone())));
    let history = Arc::new(Mutex::new(HistoryStore::new(opened.database.clone())));
    let dictionary = Arc::new(Mutex::new(DictionaryStore::new(opened.database.clone())));
    let meetings = Arc::new(Mutex::new(MeetingsStore::new(opened.database)));
    let initial = tauri::async_runtime::block_on(settings.lock()).value();
    let selected = initial.model_id.clone();

    // The one release before this kept a comma list in settings. It
    // becomes terms once, and the field is cleared so this does not
    // run again -- and so the list is not primed twice.
    let mut opened_notes = opened.notes;
    if !initial.speech_vocabulary.trim().is_empty() {
        let imported = split_terms(&initial.speech_vocabulary);
        let mut store = tauri::async_runtime::block_on(dictionary.lock());
        let mut outcome = Ok(());
        for term in &imported {
            if let Err(error) = store.add(term, &[], dictionary::Source::Manual) {
                outcome = Err(error);
                break;
            }
        }
        drop(store);
        match outcome {
            Ok(()) => {
                let mut patch = initial.clone();
                patch.speech_vocabulary = String::new();
                tauri::async_runtime::block_on(settings.lock()).update(patch);
                opened_notes.push(format!(
                    "moved {} vocabulary term(s) from settings into the dictionary",
                    imported.len()
                ));
            }
            Err(error) => opened_notes.push(format!(
                "the vocabulary setting was left in place: {error}"
            )),
        }
    }

    let logs = Arc::new(logs::Logs::new());
    logs.info(
        app.handle(),
        "app",
        format!("Waveform {} starting, model {selected}", app.package_info().version),
    );
    for note in &opened_notes {
        logs.info(app.handle(), "store", note.clone());
    }
    // A meeting left recording by a crash is closed as it stands.
    match tauri::async_runtime::block_on(meetings.lock()).close_abandoned() {
        Ok(0) | Err(_) => {}
        Ok(count) => logs.info(
            app.handle(),
            "meeting",
            format!("closed {count} meeting(s) left recording by a previous run"),
        ),
    }

    let handle = app.handle().clone();
    let recorder = logs.clone();
    let models = Arc::new(ModelServer::new(
        user_data,
        project_root(),
        app.path().resource_dir().ok(),
        selected.clone(),
        Box::new(move |event: ModelEvent| {
            // Every stage the engine reports, said once where it can be
            // read afterwards. Downloading is skipped: it arrives four
            // times a second and would bury everything else.
            if event.stage != "downloading" {
                recorder.push(
                    &handle,
                    if event.stage == "error" { "error" } else { "info" },
                    "engine",
                    format!("{} — {}", event.stage, event.message),
                );
            }
            let _ = handle.emit("model-event", event);
        }),
    ));

    let polish_handle = app.handle().clone();
    let polish_log = logs.clone();
    let polish_downloads = Arc::new(LocalDownloads::new(Box::new(move |event: ModelEvent| {
        // Downloading is skipped for the same reason as the speech
        // engine's: it arrives four times a second.
        if event.stage != "downloading" {
            polish_log.push(
                &polish_handle,
                if event.stage == "error" { "error" } else { "info" },
                "polish",
                format!("{} — {}", event.stage, event.message),
            );
        }
        // Its own event rather than the speech engine's: the AI page
        // draws these rows, and a progress message aimed at a model id
        // the Models page has never heard of would land nowhere.
        let _ = polish_handle.emit("polish-model-event", event);
    })));

    let rewriter = Rewriter::new(settings.clone());
    // A dictation that is always polished will want the local model
    // within seconds of the first phrase; loading it now costs nobody
    // a wait.
    let warming = rewriter.clone();
    tauri::async_runtime::spawn(async move { warming.warm_at_launch().await });

    let engine = Engine {
        app: app.handle().clone(),
        logs: logs.clone(),
        settings: settings.clone(),
        dictionary: dictionary.clone(),
        models: models.clone(),
    };
    let tap_helper = meeting::find_tap_helper(
        app.path().resource_dir().ok().as_deref(),
        &project_root(),
    );
    if tap_helper.is_none() {
        logs.info(
            app.handle(),
            "meeting",
            "no audio tap helper found; meetings will record the microphone only",
        );
    }
    let recorder = Arc::new(Recorder::new(
        app.handle().clone(),
        logs.clone(),
        meetings.clone(),
        engine.clone(),
        rewriter.clone(),
        tap_helper,
    ));
    let dictation = Dictation::new(
        app.handle().clone(),
        logs.clone(),
        settings.clone(),
        stats.clone(),
        history.clone(),
        rewriter.clone(),
        models.clone(),
    );

    app.manage(AppState {
        settings,
        logs,
        stats,
        history,
        dictionary,
        engine,
        recorder,
        models: models.clone(),
        dictation: dictation.clone(),
        rewriter,
        polish_downloads,
        drag_origin: Mutex::new(None),
        quitting_after_stop: AtomicBool::new(false),
        hide_dock_when_closed: AtomicBool::new(initial.hide_dock_when_closed),
        microphones: StdMutex::new(Vec::new()),
        overlay_hovered: AtomicBool::new(false),
        overlay_hit_region: StdMutex::new(None),
        capture: Arc::new(mic::NativeCapture::new()),
    });

    build_overlay_window(app.handle())?;
    watch_overlay_hover(app.handle().clone());

    set_launch_at_login(app.handle(), initial.launch_at_login);
    if initial.show_flow_bar_always {
        let dictation = dictation.clone();
        tauri::async_runtime::spawn(async move {
            dictation.apply_flow_bar_setting().await;
        });
    }

    let root = project_root();
    tauri::async_runtime::spawn(async move {
        dictation.initialize(root).await;
    });

    if initial.menu_bar_icon {
        build_tray(app.handle())?;
    }

    // Closing the window must not end the process: the whole point is
    // that the shortcut keeps working with no window on screen.
    if let Some(window) = app.get_webview_window(MAIN_LABEL) {
        let _ = window.set_title(&app_display_name());
        let handle = app.handle().clone();
        window.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if let Some(window) = handle.get_webview_window(MAIN_LABEL) {
                    let _ = window.hide();
                }
                let hide_dock = handle
                    .state::<AppState>()
                    .hide_dock_when_closed
                    .load(Ordering::Relaxed);
                if hide_dock {
                    let _ = handle.set_activation_policy(ActivationPolicy::Accessory);
                }
            }
        });
    }

    // The Exit event covers a normal quit, but a terminated or crashed
    // app would leave the engine running -- it is a separate process
    // and does not notice its parent going away.
    let engine = models.clone();
    tauri::async_runtime::spawn(async move {
        use tokio::signal::unix::{signal, SignalKind};
        let Ok(mut terminate) = signal(SignalKind::terminate()) else {
            return;
        };
        let Ok(mut interrupt) = signal(SignalKind::interrupt()) else {
            return;
        };
        tokio::select! {
            _ = terminate.recv() => {}
            _ = interrupt.recv() => {}
        }
        // Bounded, and then leave regardless. stop() takes the same
        // locks as a dictation in flight, so a phrase mid-transcription
        // can hold it long enough to look like a hang -- and an app
        // that ignores SIGTERM is one that pnpm app cannot replace,
        // which is how a rebuilt bundle ends up watching the old
        // process keep running.
        let _ = tokio::time::timeout(std::time::Duration::from_secs(3), engine.stop()).await;
        std::process::exit(0);
    });

    resources::spawn_monitor(app.handle().clone(), models.clone());
    updates::spawn_checks(app.handle().clone());

    // Load the engine at launch so the first dictation is not the thing
    // that waits for it.
    tauri::async_runtime::spawn(async move {
        let _ = models.select(&selected).await;
    });

    if !started_at_login {
        present_main_window(app.handle());
    } else if initial.hide_dock_when_closed && initial.menu_bar_icon {
        app.set_activation_policy(ActivationPolicy::Accessory);
    }

    Ok(())
}

pub(crate) fn on_run_event(app: &tauri::AppHandle, event: RunEvent) {
    match event {
        // Clicking the Dock icon of a running app with no open window.
        // Without this the icon appears inert.
        //
        // The HUD is an ordinary NSWindow -- tao's `focusable(false)` only
        // stops it becoming key, it does not stop a click activating the
        // application -- and AppKit reports that activation as a reopen
        // too. Pressing cancel or accept therefore raised the main window,
        // which is both wrong on its own terms and takes focus from the app
        // being dictated into. A reopen while the pointer is on the HUD came
        // from the HUD, not from the Dock, and is not a request for a window.
        RunEvent::Reopen { .. } => {
            if !app
                .state::<AppState>()
                .overlay_hovered
                .load(Ordering::Relaxed)
            {
                present_main_window(app);
            }
        }
        // The engine is a separate process of several hundred megabytes and
        // does not exit on its own, so it has to be shut down explicitly or
        // it outlives the app.
        //
        // Bounded, because this runs on the AppKit thread: waiting here is
        // waiting with the window still on screen, which is a quit that
        // looks like a freeze. stop() signals the child before it awaits
        // anything, so giving up on the wait still leaves it dying.
        // Quitting mid-meeting keeps the meeting: the recording is
        // stopped and saved first, then the quit goes ahead. Nothing is
        // ever marked interrupted by a deliberate quit.
        RunEvent::ExitRequested { api, .. } => {
            let state = app.state::<AppState>();
            if state.quitting_after_stop.swap(true, Ordering::SeqCst) {
                return;
            }
            let recorder = state.recorder.clone();
            if tauri::async_runtime::block_on(recorder.is_recording()) {
                api.prevent_exit();
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = recorder.stop().await;
                    handle.exit(0);
                });
            }
        }
        RunEvent::Exit => {
            let models = app.state::<AppState>().models.clone();
            let stopping = tauri::async_runtime::spawn(async move { models.stop().await });
            let _ = tauri::async_runtime::block_on(async {
                tokio::time::timeout(std::time::Duration::from_millis(1500), stopping).await
            });
        }
        _ => {}
    }
}
