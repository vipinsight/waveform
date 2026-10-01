//! Recording a meeting: two tracks to disk, phrases to the engine as they
//! are cut, and -- once the recording stops -- speakers tagged and a summary
//! written.
//!
//! Everything here runs in the host. A meeting is an hour long and must
//! outlive the window; nothing in it depends on a webview being open. The
//! window is told about every line and every change of state so it can show
//! them, and asks for the rest when it needs it.

use crate::audio::{self, Segmenter, SegmenterOptions, WavWriter};
use crate::diarize;
use crate::logs::Logs;
use crate::meetings::{Line, Meeting, MeetingsStore, State, Track, LOCAL_SPEAKER};
use crate::mic::{CaptureBlock, MeetingInput};
use crate::rewrite::Rewriter;
use crate::summary;
use crate::transcribe::Engine;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, SyncSender};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::sync::Mutex;

const MAIN_LABEL: &str = "main";
/// Blocks from the tap helper are read in this many samples at a time;
/// about 43 ms at 48 kHz, close to the microphone's block.
const TAP_BLOCK: usize = 2_048;
/// How long the tap helper gets to say it is ready before the meeting goes
/// on with the microphone alone.
const TAP_READY_TIMEOUT: Duration = Duration::from_secs(5);
/// Blocks waiting between a capture thread and its writer.
const QUEUE: usize = 64;

/// What the window asks before offering Record.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecorderStatus {
    /// The meeting being recorded now, if any.
    pub recording: Option<String>,
    /// `available`, `unsupported` (macOS before 14.2), or `missing` (no helper built).
    pub system_audio: String,
    pub diarizer_installed: bool,
    pub diarizer_bytes: u64,
    pub has_open_router_key: bool,
    /// The name the local speaker is given, from the macOS account.
    pub local_name: String,
}

/// The whole of one meeting, for the page that shows it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingDetail {
    pub meeting: Meeting,
    pub lines: Vec<Line>,
    /// The summary parsed into sections, when it parses.
    pub summary: Option<summary::Summary>,
}

/// One line arriving while a meeting records.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LineEvent {
    meeting_id: String,
    line: Line,
}

/// Install progress for the speaker tool.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallEvent {
    stage: String,
    message: String,
    progress: f32,
}

/// One track's capture, handed to `spawn_track`.
struct TrackJob {
    id: String,
    track: Track,
    sample_rate: u32,
    path: PathBuf,
    blocks: mpsc::Receiver<CaptureBlock>,
    /// When the meeting started, so a track opened late still lines up.
    started: Instant,
    stop: Arc<AtomicBool>,
    /// Counts the blocks that arrived, for the caller to judge the track by.
    delivered: Arc<std::sync::atomic::AtomicU64>,
}

struct Active {
    id: String,
    started: Instant,
    /// Dropped to stop the microphone stream.
    _mic: Option<MeetingInput>,
    /// The tap helper; stdin is closed to stop it.
    tap: Option<tokio::process::Child>,
    /// Raised to tell every capture thread to finish.
    stop: Arc<AtomicBool>,
    /// Blocks the system track delivered; zero means the tap heard nothing.
    system_blocks: Option<Arc<std::sync::atomic::AtomicU64>>,
    /// Writer and transcriber tasks, awaited on stop so the last phrases land.
    tasks: Vec<tauri::async_runtime::JoinHandle<()>>,
}

pub struct Recorder {
    app: AppHandle,
    logs: Arc<Logs>,
    meetings: Arc<Mutex<MeetingsStore>>,
    engine: Engine,
    rewriter: Arc<Rewriter>,
    tap_helper: Option<PathBuf>,
    active: Mutex<Option<Active>>,
    /// Cancellation flags for meetings being processed after they stopped.
    processing: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// Meetings whose tap ran but heard nothing, for the note after processing.
    silent_tap: Mutex<HashMap<String, bool>>,
    installing: AtomicBool,
    install_cancel: Arc<AtomicBool>,
}

impl Recorder {
    pub fn new(
        app: AppHandle,
        logs: Arc<Logs>,
        meetings: Arc<Mutex<MeetingsStore>>,
        engine: Engine,
        rewriter: Arc<Rewriter>,
        tap_helper: Option<PathBuf>,
    ) -> Self {
        Self {
            app,
            logs,
            meetings,
            engine,
            rewriter,
            tap_helper,
            active: Mutex::new(None),
            processing: Mutex::new(HashMap::new()),
            silent_tap: Mutex::new(HashMap::new()),
            installing: AtomicBool::new(false),
            install_cancel: Arc::new(AtomicBool::new(false)),
        }
    }

    pub async fn status(&self) -> RecorderStatus {
        RecorderStatus {
            recording: self.active.lock().await.as_ref().map(|active| active.id.clone()),
            system_audio: match &self.tap_helper {
                None => "missing",
                Some(_) if system_audio_supported() => "available",
                Some(_) => "unsupported",
            }
            .to_string(),
            diarizer_installed: diarize::is_installed(),
            diarizer_bytes: diarize::INSTALL_BYTES,
            has_open_router_key: self.rewriter.open_router_key().await.is_some(),
            local_name: local_name(),
        }
    }

    pub async fn list(&self) -> Result<Vec<Meeting>, String> {
        self.meetings.lock().await.list()
    }

    pub async fn detail(&self, id: &str) -> Result<MeetingDetail, String> {
        let store = self.meetings.lock().await;
        let meeting = store.get(id)?.ok_or_else(|| "That meeting is gone.".to_string())?;
        let lines = store.lines(id)?;
        let summary = meeting
            .summary
            .as_deref()
            .and_then(|text| summary::parse(text).ok());
        Ok(MeetingDetail {
            meeting,
            lines,
            summary,
        })
    }

    /// Opens the microphone and, where it can, the system-audio tap, and
    /// starts a meeting. One at a time.
    pub async fn start(self: &Arc<Self>, title: &str) -> Result<Meeting, String> {
        let mut active = self.active.lock().await;
        if active.is_some() {
            return Err("A meeting is already being recorded.".into());
        }
        let settings = self.engine.settings.lock().await.value();
        let mut meeting = {
            let mut store = self.meetings.lock().await;
            let meeting = store.create(title, &settings.speech_language, &settings.model_id)?;
            // The microphone is this Mac's user, named from the start.
            store.rename_speaker(&meeting.id, LOCAL_SPEAKER, &local_name())?
        };
        let id = meeting.id.clone();
        let dir = self.meetings.lock().await.dir(&id);
        let started = Instant::now();
        let stop = Arc::new(AtomicBool::new(false));
        let mut tasks = Vec::new();

        // Microphone.
        let (mic_blocks, mic_rx) = mpsc::sync_channel::<CaptureBlock>(QUEUE);
        let (mic_name, mic_rate, mic) = match MeetingInput::open(&settings.microphone_device_name, mic_blocks) {
            Ok(opened) => opened,
            Err(error) => {
                let _ = self.meetings.lock().await.delete(&id);
                return Err(error);
            }
        };
        self.logs.info(&self.app, "meeting", format!("{id}: microphone {mic_name} at {mic_rate}Hz"));
        tasks.push(self.spawn_track(TrackJob {
            id: id.clone(),
            track: Track::Mic,
            sample_rate: mic_rate,
            path: dir.join("mic.wav"),
            blocks: mic_rx,
            started,
            stop: stop.clone(),
            delivered: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        }));

        // The other side of the call, when this Mac can hear it.
        let mut tap_child = None;
        let mut system_blocks = None;
        if system_audio_supported() {
            if let Some(helper) = &self.tap_helper {
                match start_tap(helper, self.logs.clone(), self.app.clone()).await {
                    Ok((child, rate, rx)) => {
                        self.logs.info(&self.app, "meeting", format!("{id}: system audio at {rate}Hz"));
                        let delivered = Arc::new(std::sync::atomic::AtomicU64::new(0));
                        system_blocks = Some(delivered.clone());
                        tasks.push(self.spawn_track(TrackJob {
                            id: id.clone(),
                            track: Track::System,
                            sample_rate: rate,
                            path: dir.join("system.wav"),
                            blocks: rx,
                            started,
                            stop: stop.clone(),
                            delivered,
                        }));
                        let _ = self.meetings.lock().await.set_has_system_audio(&id, true);
                        meeting.has_system_audio = true;
                        tap_child = Some(child);
                    }
                    Err(error) => {
                        self.logs.error(&self.app, "meeting", format!("{id}: system audio unavailable: {error}"));
                    }
                }
            }
        }

        *active = Some(Active {
            id: id.clone(),
            started,
            _mic: Some(mic),
            tap: tap_child,
            stop,
            system_blocks,
            tasks,
        });
        drop(active);
        self.emit_changed(&meeting).await;
        Ok(meeting)
    }

    /// Stops the recording, waits for the last phrases to be transcribed,
    /// then tags speakers and writes the summary in the background.
    pub async fn stop(self: &Arc<Self>) -> Result<Meeting, String> {
        let Some(mut active) = self.active.lock().await.take() else {
            return Err("No meeting is being recorded.".into());
        };
        let id = active.id.clone();
        let duration_ms = active.started.elapsed().as_millis() as u64;
        {
            let mut store = self.meetings.lock().await;
            store.set_state(&id, State::Processing, Some("Finishing the last phrases…"))?;
            store.set_duration(&id, duration_ms)?;
        }
        if let Ok(Some(meeting)) = self.meetings.lock().await.get(&id) {
            self.emit_changed(&meeting).await;
        }

        // End the captures: the microphone by dropping its handle, the tap by
        // closing its stdin. Each writer sees its channel close, flushes the
        // segmenter, and the transcriber behind it drains.
        active.stop.store(true, Ordering::Relaxed);
        active._mic.take();
        if let Some(mut child) = active.tap.take() {
            drop(child.stdin.take());
            let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
            let _ = child.kill().await;
        }
        for task in active.tasks.drain(..) {
            let _ = task.await;
        }
        // A tap that ran but delivered nothing is a permission that was not
        // given, almost always. Say so where the user will read it.
        let heard_nothing = active
            .system_blocks
            .as_ref()
            .is_some_and(|count| count.load(Ordering::Relaxed) == 0);
        if heard_nothing {
            self.logs.error(&self.app, "meeting", format!("{id}: the system-audio tap delivered no audio"));
            let _ = self.meetings.lock().await.set_has_system_audio(&id, false);
            let _ = std::fs::remove_file(self.meetings.lock().await.dir(&id).join("system.wav"));
        }
        self.silent_tap.lock().await.insert(id.clone(), heard_nothing);

        let this = self.clone();
        let cancel = Arc::new(AtomicBool::new(false));
        self.processing.lock().await.insert(id.clone(), cancel.clone());
        tauri::async_runtime::spawn(async move {
            this.process(&id, cancel).await;
        });

        self.meetings
            .lock()
            .await
            .get(&active.id)?
            .ok_or_else(|| "That meeting is gone.".to_string())
    }

    /// Throws the recording away.
    pub async fn cancel(self: &Arc<Self>) -> Result<(), String> {
        let Some(mut active) = self.active.lock().await.take() else {
            return Ok(());
        };
        active.stop.store(true, Ordering::Relaxed);
        active._mic.take();
        if let Some(mut child) = active.tap.take() {
            let _ = child.kill().await;
        }
        for task in active.tasks.drain(..) {
            task.abort();
        }
        self.meetings.lock().await.delete(&active.id)?;
        let _ = self.app.emit_to(MAIN_LABEL, "meetings-changed", ());
        Ok(())
    }

    /// Tags speakers, mixes the tracks down for playback, and writes the
    /// summary. Each step that cannot run says why and the rest goes on; a
    /// transcript is never lost to a missing tool or a missing key.
    async fn process(self: &Arc<Self>, id: &str, cancel: Arc<AtomicBool>) {
        let outcome = self.process_steps(id, &cancel).await;
        let mut store = self.meetings.lock().await;
        match outcome {
            Ok(note) => {
                let _ = store.set_state(id, State::Ready, note.as_deref());
            }
            Err(reason) if reason == crate::download::CANCELLED => {}
            Err(reason) => {
                self.logs.error(&self.app, "meeting", format!("{id}: {reason}"));
                let _ = store.set_state(id, State::Failed, Some(&reason));
            }
        }
        let meeting = store.get(id).ok().flatten();
        drop(store);
        self.processing.lock().await.remove(id);
        if let Some(meeting) = meeting {
            self.emit_changed(&meeting).await;
        }
    }

    /// Returns a note for the Ready state when a step was skipped.
    async fn process_steps(self: &Arc<Self>, id: &str, cancel: &AtomicBool) -> Result<Option<String>, String> {
        let dir = self.meetings.lock().await.dir(id);
        let meeting = self
            .meetings
            .lock()
            .await
            .get(id)?
            .ok_or_else(|| "That meeting is gone.".to_string())?;
        let mut notes: Vec<String> = Vec::new();
        if self.silent_tap.lock().await.remove(id).unwrap_or(false) {
            notes.push(
                "The other side of the call was not heard. Allow Waveform under System Settings → \
                 Privacy & Security → Screen & System Audio Recording, then record again."
                    .into(),
            );
        }

        if meeting.has_system_audio && dir.join("system.wav").is_file() {
            if diarize::is_installed() {
                self.set_stage(id, "Tagging speakers…").await;
                let turns = diarize::run(&dir.join("system.wav"), cancel).await?;
                let lines = self.meetings.lock().await.lines(id)?;
                let spans: Vec<diarize::Span> = lines
                    .iter()
                    .filter(|line| line.track == Track::System)
                    .map(|line| diarize::Span {
                        idx: line.idx,
                        start_ms: line.start_ms,
                        end_ms: line.end_ms,
                    })
                    .collect();
                let tags = diarize::assign(&spans, &turns);
                self.logs.info(
                    &self.app,
                    "meeting",
                    format!("{id}: {} turn(s), {} line(s) tagged", turns.len(), tags.len()),
                );
                self.meetings.lock().await.tag_lines(id, &tags)?;
            } else {
                notes.push("Speaker tagging is not installed, so remote lines are not told apart.".into());
            }
        }

        self.set_stage(id, "Preparing playback…").await;
        if let Err(error) = mixdown(&dir) {
            self.logs.error(&self.app, "meeting", format!("{id}: mixdown: {error}"));
        }

        match self.write_summary(id).await {
            Ok(()) => {}
            Err(reason) => notes.push(reason),
        }

        Ok((!notes.is_empty()).then(|| notes.join(" ")))
    }

    /// Writes (or rewrites) the summary. Needs an OpenRouter key.
    pub async fn write_summary(self: &Arc<Self>, id: &str) -> Result<(), String> {
        let key = self
            .rewriter
            .open_router_key()
            .await
            .ok_or("Add an OpenRouter API key in AI Polish to get a summary.")?;
        let model = self.rewriter.open_router_model().await;
        let (meeting, lines) = {
            let store = self.meetings.lock().await;
            let meeting = store.get(id)?.ok_or_else(|| "That meeting is gone.".to_string())?;
            (meeting, store.lines(id)?)
        };
        if lines.is_empty() {
            return Err("Nothing was said, so there is nothing to summarise.".into());
        }
        self.set_stage(id, "Writing the summary…").await;
        let transcript = summary::transcript_text(&lines, &meeting.speakers, &local_name());
        let (text, _) = summary::summarize(&key, &model, &transcript).await?;
        self.meetings.lock().await.set_summary(id, Some(&text), Some(&model))?;
        Ok(())
    }

    /// Regenerates the summary for a finished meeting, after renames.
    pub async fn resummarize(self: &Arc<Self>, id: &str) -> Result<MeetingDetail, String> {
        self.meetings.lock().await.set_state(id, State::Processing, Some("Writing the summary…"))?;
        if let Ok(Some(meeting)) = self.meetings.lock().await.get(id) {
            self.emit_changed(&meeting).await;
        }
        let outcome = self.write_summary(id).await;
        {
            let mut store = self.meetings.lock().await;
            match &outcome {
                Ok(()) => store.set_state(id, State::Ready, None)?,
                Err(reason) => store.set_state(id, State::Ready, Some(reason))?,
            }
        }
        let detail = self.detail(id).await?;
        self.emit_changed(&detail.meeting).await;
        outcome.map(|_| detail)
    }

    pub async fn rename(self: &Arc<Self>, id: &str, title: &str) -> Result<Meeting, String> {
        let meeting = self.meetings.lock().await.set_title(id, title)?;
        self.emit_changed(&meeting).await;
        Ok(meeting)
    }

    pub async fn rename_speaker(self: &Arc<Self>, id: &str, label: &str, name: &str) -> Result<Meeting, String> {
        let meeting = self.meetings.lock().await.rename_speaker(id, label, name)?;
        self.emit_changed(&meeting).await;
        Ok(meeting)
    }

    pub async fn delete(self: &Arc<Self>, id: &str) -> Result<(), String> {
        if let Some(cancel) = self.processing.lock().await.remove(id) {
            cancel.store(true, Ordering::Relaxed);
        }
        if self.active.lock().await.as_ref().is_some_and(|active| active.id == id) {
            return self.cancel().await;
        }
        self.meetings.lock().await.delete(id)?;
        let _ = self.app.emit_to(MAIN_LABEL, "meetings-changed", ());
        Ok(())
    }

    /// The recording for playback: both sides mixed, or whichever exists.
    pub async fn audio(&self, id: &str) -> Result<Vec<u8>, String> {
        let dir = self.meetings.lock().await.dir(id);
        for name in ["mixed.wav", "mic.wav", "system.wav"] {
            if let Ok(bytes) = std::fs::read(dir.join(name)) {
                if bytes.len() > 44 {
                    return Ok(bytes);
                }
            }
        }
        Err("This meeting has no recording.".into())
    }

    /// Downloads the speaker tool, reporting progress to the window.
    pub async fn install_diarizer(self: &Arc<Self>) -> Result<(), String> {
        if self.installing.swap(true, Ordering::SeqCst) {
            return Err("The speaker tool is already downloading.".into());
        }
        self.install_cancel.store(false, Ordering::SeqCst);
        let app = self.app.clone();
        let report = move |message: &str, progress: f32| {
            let _ = app.emit_to(
                MAIN_LABEL,
                "diarizer-install",
                InstallEvent {
                    stage: if progress >= 1.0 { "ready" } else { "downloading" }.to_string(),
                    message: message.to_string(),
                    progress,
                },
            );
        };
        let outcome = diarize::install(&self.install_cancel, &report).await;
        self.installing.store(false, Ordering::SeqCst);
        if let Err(error) = &outcome {
            let _ = self.app.emit_to(
                MAIN_LABEL,
                "diarizer-install",
                InstallEvent {
                    stage: "error".to_string(),
                    message: error.clone(),
                    progress: 0.0,
                },
            );
        }
        outcome
    }

    pub fn cancel_diarizer_install(&self) {
        self.install_cancel.store(true, Ordering::SeqCst);
    }

    pub async fn remove_diarizer(&self) -> Result<(), String> {
        diarize::remove().await
    }

    async fn set_stage(&self, id: &str, stage: &str) {
        let meeting = {
            let mut store = self.meetings.lock().await;
            let _ = store.set_state(id, State::Processing, Some(stage));
            store.get(id).ok().flatten()
        };
        if let Some(meeting) = meeting {
            self.emit_changed(&meeting).await;
        }
    }

    async fn emit_changed(&self, meeting: &Meeting) {
        let _ = self.app.emit_to(MAIN_LABEL, "meeting-changed", meeting);
    }

    /// Writes one track to disk and cuts it into phrases, which a second task
    /// transcribes in order, each primed with the track's text so far.
    fn spawn_track(self: &Arc<Self>, job: TrackJob) -> tauri::async_runtime::JoinHandle<()> {
        let TrackJob {
            id,
            track,
            sample_rate,
            path,
            blocks,
            started,
            stop,
            delivered,
        } = job;
        let this = self.clone();
        let (phrases_tx, mut phrases_rx) = tokio::sync::mpsc::unbounded_channel::<audio::Phrase>();

        // Capture → disk and segmenter, on a plain thread: the blocks arrive
        // from a realtime callback and nothing here may wait on the engine.
        let writer_id = id.clone();
        let writer_logs = this.logs.clone();
        let writer_app = this.app.clone();
        let offset_ms = started.elapsed().as_millis() as u64;
        std::thread::Builder::new()
            .name(format!("waveform-meeting-{}", track.as_str()))
            .spawn(move || {
                let mut writer = match WavWriter::create(&path, sample_rate) {
                    Ok(writer) => writer,
                    Err(error) => {
                        writer_logs.error(&writer_app, "meeting", format!("{writer_id}: could not write {}: {error}", path.display()));
                        return;
                    }
                };
                let mut segmenter = Segmenter::new(SegmenterOptions::meeting(sample_rate));
                // Polled with a timeout rather than waiting for the channel to
                // close: the sender lives in the audio callback, and cpal does
                // not drop that callback when the stream is dropped, so a
                // plain `recv` would wait forever after the stream had gone.
                loop {
                    match blocks.recv_timeout(Duration::from_millis(250)) {
                        Ok(block) => {
                            delivered.fetch_add(1, Ordering::Relaxed);
                            if let Err(error) = writer.write(&block.samples) {
                                writer_logs.error(&writer_app, "meeting", format!("{writer_id}: write failed: {error}"));
                                break;
                            }
                            if let Some(mut phrase) = segmenter.push(&block.samples) {
                                phrase.start_ms += offset_ms;
                                phrase.end_ms += offset_ms;
                                let _ = phrases_tx.send(phrase);
                            }
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => {
                            if stop.load(Ordering::Relaxed) {
                                break;
                            }
                        }
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                }
                if let Some(mut phrase) = segmenter.flush() {
                    phrase.start_ms += offset_ms;
                    phrase.end_ms += offset_ms;
                    let _ = phrases_tx.send(phrase);
                }
                if let Err(error) = writer.finish() {
                    writer_logs.error(&writer_app, "meeting", format!("{writer_id}: could not finish {}: {error}", path.display()));
                }
            })
            .expect("meeting track thread");

        // Phrases → engine → lines, in order, with the track's own context.
        tauri::async_runtime::spawn(async move {
            let mut prior = String::new();
            while let Some(phrase) = phrases_rx.recv().await {
                let samples = audio::normalize_phrase(&phrase.samples);
                let wav = audio::encode_wav(&samples, sample_rate);
                let text = match this.engine.transcribe(wav, &prior, "meeting").await {
                    Ok(text) => text,
                    Err(error) => {
                        this.logs.error(&this.app, "meeting", format!("{id}: phrase failed: {error}"));
                        continue;
                    }
                };
                if text.trim().is_empty() {
                    continue;
                }
                prior = format!("{prior} {text}").trim().chars().rev().take(2_000).collect::<Vec<_>>().into_iter().rev().collect();
                let line = match this.meetings.lock().await.add_line(&id, track, phrase.start_ms, phrase.end_ms, &text) {
                    Ok(line) => line,
                    Err(error) => {
                        this.logs.error(&this.app, "meeting", format!("{id}: {error}"));
                        continue;
                    }
                };
                let _ = this.app.emit_to(
                    MAIN_LABEL,
                    "meeting-line",
                    LineEvent {
                        meeting_id: id.clone(),
                        line,
                    },
                );
            }
        })
    }
}

/// Starts the tap helper and waits for its ready line. Returns the child,
/// the sample rate it announced, and the channel its blocks arrive on.
async fn start_tap(
    helper: &Path,
    logs: Arc<Logs>,
    app: AppHandle,
) -> Result<(tokio::process::Child, u32, mpsc::Receiver<CaptureBlock>), String> {
    let mut child = tokio::process::Command::new(helper)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("could not start the audio tap: {error}"))?;
    let stderr = child.stderr.take().ok_or("the audio tap has no stderr")?;
    let stdout = child.stdout.take().ok_or("the audio tap has no stdout")?;

    let mut lines = BufReader::new(stderr).lines();
    let ready = tokio::time::timeout(TAP_READY_TIMEOUT, async {
        while let Ok(Some(line)) = lines.next_line().await {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
                match value.get("type").and_then(|t| t.as_str()) {
                    Some("ready") => {
                        return Ok(value.get("sampleRate").and_then(|r| r.as_f64()).unwrap_or(48_000.0) as u32)
                    }
                    Some("error") => {
                        return Err(value
                            .get("reason")
                            .and_then(|r| r.as_str())
                            .unwrap_or("unknown")
                            .to_string())
                    }
                    _ => {}
                }
            }
        }
        Err("the audio tap stopped before it was ready".to_string())
    })
    .await
    .map_err(|_| "the audio tap did not become ready".to_string())??;

    // Keep reading stderr: it is where the helper reports what it heard, and
    // a full pipe would block it.
    tauri::async_runtime::spawn(async move {
        while let Ok(Some(line)) = lines.next_line().await {
            if !line.trim().is_empty() {
                logs.info(&app, "audiotap", line);
            }
        }
    });

    let (sender, receiver) = mpsc::sync_channel::<CaptureBlock>(QUEUE);
    tauri::async_runtime::spawn(read_tap(stdout, sender, ready));
    Ok((child, ready, receiver))
}

/// Turns the helper's raw float stream into blocks.
async fn read_tap(mut stdout: tokio::process::ChildStdout, sender: SyncSender<CaptureBlock>, sample_rate: u32) {
    let mut buffer = vec![0u8; TAP_BLOCK * 4];
    let mut filled = 0;
    loop {
        match stdout.read(&mut buffer[filled..]).await {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                filled += read;
                if filled == buffer.len() {
                    let samples: Vec<f32> = buffer
                        .chunks_exact(4)
                        .map(|bytes| f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
                        .collect();
                    filled = 0;
                    // Dropped if the writer is behind rather than stalling the
                    // read: a lost block is a gap, a stalled pipe is a frozen helper.
                    if sender.try_send(CaptureBlock { samples, sample_rate }).is_err() {
                        continue;
                    }
                }
            }
        }
    }
    // Whatever is left is under a block; it is not worth a phrase.
}

/// Sums the two tracks into `mixed.wav` for playback, at the microphone's
/// rate. The tracks are mono PCM16 as `WavWriter` wrote them.
fn mixdown(dir: &Path) -> Result<(), String> {
    let mic = read_pcm16(&dir.join("mic.wav"));
    let system = read_pcm16(&dir.join("system.wav"));
    let (mic, system) = match (mic, system) {
        (Some(mic), Some(system)) => (mic, system),
        // One track: playback reads it directly.
        _ => return Ok(()),
    };
    let rate = mic.1;
    let system_samples = if system.1 == rate {
        system.0
    } else {
        resample_linear(&system.0, system.1, rate)
    };
    let length = mic.0.len().max(system_samples.len());
    let mut mixed = Vec::with_capacity(length);
    for index in 0..length {
        let a = mic.0.get(index).copied().unwrap_or(0.0);
        let b = system_samples.get(index).copied().unwrap_or(0.0);
        mixed.push((a + b).clamp(-1.0, 1.0));
    }
    let mut writer = WavWriter::create(&dir.join("mixed.wav"), rate).map_err(|e| e.to_string())?;
    writer.write(&mixed).map_err(|e| e.to_string())?;
    writer.finish().map_err(|e| e.to_string())
}

/// Reads one of our own WAVs: a 44-byte header, then mono PCM16.
fn read_pcm16(path: &Path) -> Option<(Vec<f32>, u32)> {
    let bytes = std::fs::read(path).ok()?;
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" {
        return None;
    }
    let rate = u32::from_le_bytes([bytes[24], bytes[25], bytes[26], bytes[27]]);
    let samples = bytes[44..]
        .chunks_exact(2)
        .map(|pair| i16::from_le_bytes([pair[0], pair[1]]) as f32 / 32_768.0)
        .collect();
    Some((samples, rate))
}

/// Good enough for playback; the engine never hears this.
fn resample_linear(input: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to || input.is_empty() {
        return input.to_vec();
    }
    let ratio = from as f64 / to as f64;
    let length = (input.len() as f64 / ratio) as usize;
    (0..length)
        .map(|index| {
            let position = index as f64 * ratio;
            let left = position.floor() as usize;
            let right = (left + 1).min(input.len() - 1);
            let fraction = (position - left as f64) as f32;
            input[left] * (1.0 - fraction) + input[right] * fraction
        })
        .collect()
}

/// macOS 14.2 brought the process tap. Read from the system, not the SDK:
/// the binary runs on 13.
fn system_audio_supported() -> bool {
    let Ok(output) = std::process::Command::new("sw_vers").arg("-productVersion").output() else {
        return false;
    };
    let version = String::from_utf8_lossy(&output.stdout);
    let mut parts = version.trim().split('.').map(|part| part.parse::<u32>().unwrap_or(0));
    let major = parts.next().unwrap_or(0);
    let minor = parts.next().unwrap_or(0);
    major > 14 || (major == 14 && minor >= 2)
}

/// The account's full name, for the local speaker; the short name failing that.
fn local_name() -> String {
    let full = std::process::Command::new("id")
        .arg("-F")
        .output()
        .ok()
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|name| !name.is_empty());
    full.or_else(|| std::env::var("USER").ok())
        .unwrap_or_else(|| "Me".to_string())
}

/// Finds the tap helper: bundled beside the app, or built into dist/ in dev.
pub fn find_tap_helper(resource_dir: Option<&Path>, project_root: &Path) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(configured) = std::env::var("WAVEFORM_AUDIOTAP_BIN") {
        candidates.push(PathBuf::from(configured));
    }
    if let Some(dir) = resource_dir {
        candidates.push(dir.join("waveform-audiotap"));
    }
    candidates.push(project_root.join("dist/native/waveform-audiotap"));
    candidates.into_iter().find(|path| crate::paths::is_executable(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mixdown_sums_both_tracks_and_resamples_the_second() {
        let dir = crate::store::temp_dir("mixdown");
        let mut mic = WavWriter::create(&dir.join("mic.wav"), 8_000).unwrap();
        mic.write(&[0.5; 800]).unwrap();
        mic.finish().unwrap();
        let mut system = WavWriter::create(&dir.join("system.wav"), 4_000).unwrap();
        system.write(&[0.25; 400]).unwrap();
        system.finish().unwrap();

        mixdown(&dir).unwrap();

        let (mixed, rate) = read_pcm16(&dir.join("mixed.wav")).unwrap();
        assert_eq!(rate, 8_000);
        assert_eq!(mixed.len(), 800);
        assert!((mixed[100] - 0.75).abs() < 0.01, "{}", mixed[100]);
    }

    #[test]
    fn mixdown_with_one_track_leaves_playback_to_that_track() {
        let dir = crate::store::temp_dir("mixdown-one");
        let mut mic = WavWriter::create(&dir.join("mic.wav"), 8_000).unwrap();
        mic.write(&[0.1; 80]).unwrap();
        mic.finish().unwrap();
        mixdown(&dir).unwrap();
        assert!(!dir.join("mixed.wav").exists());
    }

    #[test]
    fn linear_resampling_keeps_the_length_in_proportion() {
        let out = resample_linear(&[0.0, 1.0, 0.0, 1.0], 4, 8);
        assert_eq!(out.len(), 8);
        assert!((out[1] - 0.5).abs() < 1e-6);
        assert_eq!(resample_linear(&[0.3, 0.4], 8, 8), vec![0.3, 0.4]);
    }

    #[test]
    fn the_local_name_is_never_empty() {
        assert!(!local_name().is_empty());
    }
}
