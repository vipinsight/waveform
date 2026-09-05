//! Runs the local speech engine and turns WAV bytes into text.
//!
//! Two engines with very different shapes sit behind one interface: Parakeet
//! serves an OpenAI-compatible HTTP endpoint, while Qwen is a Python worker
//! spoken to over newline-delimited JSON on stdin/stdout.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{oneshot, Mutex};
use tokio::time::{sleep, Duration, Instant};

const DEFAULT_PORT: u16 = 8178;
const START_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const TRANSCRIBE_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelEvent {
    pub stage: String,
    pub message: String,
    pub model_id: String,
}

pub struct ModelDefinition {
    pub id: &'static str,
    pub short_label: &'static str,
    pub remote_id: &'static str,
    pub engine: Engine,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Engine {
    Nemo,
    Qwen,
}

pub const MODELS: [ModelDefinition; 2] = [
    ModelDefinition {
        id: "parakeet-tdt-0.6b-v3",
        short_label: "Parakeet 0.6B",
        remote_id: "nvidia/parakeet-tdt-0.6b-v3",
        engine: Engine::Nemo,
    },
    ModelDefinition {
        id: "qwen3-asr-0.6b",
        short_label: "Qwen3-ASR 0.6B",
        remote_id: "Qwen/Qwen3-ASR-0.6B",
        engine: Engine::Qwen,
    },
];

pub fn model(id: &str) -> &'static ModelDefinition {
    MODELS.iter().find(|m| m.id == id).unwrap_or(&MODELS[0])
}

struct QwenState {
    child: Child,
    ready: bool,
    next_job: u64,
}

pub struct ModelServer {
    selected: Mutex<String>,
    /// Where bundled scripts live, when running from a real .app.
    resource_dir: Option<PathBuf>,
    /// Pid of the running engine, for resource reporting.
    engine_pid: Mutex<Option<u32>>,
    /// Most recent stage change, so a window that loads late can pull it.
    /// With a warm engine "ready" fires before any window exists.
    last_event: Mutex<ModelEvent>,
    qwen: Mutex<Option<QwenState>>,
    /// Held so the engine can be shut down. Parakeet serves over HTTP and does
    /// not exit on its own, so dropping this handle would leave a process of
    /// several hundred megabytes running after the app quits.
    parakeet: Mutex<Option<Child>>,
    pending: Arc<Mutex<Vec<(String, oneshot::Sender<Result<String, String>>)>>>,
    transcribe_lock: Mutex<()>,
    user_data: PathBuf,
    project_root: PathBuf,
    emit: Box<dyn Fn(ModelEvent) + Send + Sync>,
}

impl ModelServer {
    pub fn new(
        user_data: PathBuf,
        project_root: PathBuf,
        resource_dir: Option<PathBuf>,
        selected: String,
        emit: Box<dyn Fn(ModelEvent) + Send + Sync>,
    ) -> Self {
        let initial = ModelEvent {
            stage: "idle".into(),
            message: "Loads when you start listening".into(),
            model_id: selected.clone(),
        };
        Self {
            selected: Mutex::new(selected),
            resource_dir,
            engine_pid: Mutex::new(None),
            last_event: Mutex::new(initial),
            qwen: Mutex::new(None),
            parakeet: Mutex::new(None),
            pending: Arc::new(Mutex::new(Vec::new())),
            transcribe_lock: Mutex::new(()),
            user_data,
            project_root,
            emit,
        }
    }

    pub fn port(&self) -> u16 {
        std::env::var("WAVEFORM_PORT")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(DEFAULT_PORT)
    }

    pub async fn engine_pid(&self) -> Option<u32> {
        *self.engine_pid.lock().await
    }

    pub async fn state(&self) -> ModelEvent {
        self.last_event.lock().await.clone()
    }

    pub async fn select(&self, id: &str) -> Result<(), String> {
        {
            let mut selected = self.selected.lock().await;
            if *selected != id {
                self.stop().await;
                *selected = id.to_string();
            }
        }
        self.start().await
    }

    pub async fn start(&self) -> Result<(), String> {
        let id = self.selected.lock().await.clone();
        let definition = model(&id);

        let ready = match definition.engine {
            Engine::Nemo => self.parakeet_ready().await,
            Engine::Qwen => self
                .qwen
                .lock()
                .await
                .as_ref()
                .map(|state| state.ready)
                .unwrap_or(false),
        };
        if ready {
            self.emit_stage("ready", &format!("{} ready", definition.short_label), &id)
                .await;
            return Ok(());
        }

        self.emit_stage(
            "starting",
            &format!("Starting {}…", definition.short_label),
            &id,
        )
        .await;

        match definition.engine {
            Engine::Nemo => self.start_parakeet(definition, &id).await?,
            Engine::Qwen => self.start_qwen(definition, &id).await?,
        }

        self.emit_stage("ready", &format!("{} ready", definition.short_label), &id)
            .await;
        Ok(())
    }

    /// Shuts the engine down. Called when the app exits.
    pub async fn stop(&self) {
        if let Some(mut state) = self.qwen.lock().await.take() {
            let _ = state.child.kill().await;
        }
        if let Some(mut child) = self.parakeet.lock().await.take() {
            let _ = child.kill().await;
        }
        *self.engine_pid.lock().await = None;
        for (_, sender) in self.pending.lock().await.drain(..) {
            let _ = sender.send(Err("Speech model changed.".into()));
        }
    }

    pub async fn transcribe(&self, wav: Vec<u8>) -> Result<String, String> {
        // One request at a time: both engines are single-threaded, and
        // overlapping calls only queue behind each other anyway.
        let _guard = self.transcribe_lock.lock().await;
        self.start().await?;

        let id = self.selected.lock().await.clone();
        match model(&id).engine {
            Engine::Nemo => self.transcribe_parakeet(wav).await,
            Engine::Qwen => self.transcribe_qwen(wav).await,
        }
    }

    async fn start_parakeet(&self, definition: &ModelDefinition, id: &str) -> Result<(), String> {
        let binary = find_nemo_runtime()
            .ok_or("nemo-speech is not installed. Run `pnpm setup:model`, then try again.")?;

        self.emit_stage("loading", "Loading Parakeet on Metal…", id).await;
        let device = if cfg!(target_arch = "aarch64") { "metal" } else { "cpu" };
        let child = Command::new(binary)
            .args([
                "serve",
                "--asr-model",
                definition.remote_id,
                "--device",
                device,
                "--host",
                "127.0.0.1",
                "--port",
                &self.port().to_string(),
                "--no-ui",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| format!("Could not start nemo-speech: {error}"))?;
        *self.engine_pid.lock().await = child.id();

        // Replace any server this app started earlier. The lock is released
        // before the readiness loop below, which would otherwise hold it for
        // minutes and block a concurrent stop().
        let previous = self.parakeet.lock().await.replace(child);
        if let Some(mut previous) = previous {
            let _ = previous.kill().await;
        }

        let deadline = Instant::now() + START_TIMEOUT;
        while Instant::now() < deadline {
            if self.parakeet_ready().await {
                return Ok(());
            }
            sleep(Duration::from_millis(600)).await;
        }
        Err("Timed out while loading Parakeet model.".into())
    }

    async fn start_qwen(&self, definition: &ModelDefinition, id: &str) -> Result<(), String> {
        let python = find_qwen_runtime(&self.user_data, &self.project_root)
            .ok_or("Qwen3-ASR is not installed. Run `pnpm setup:qwen`, then try again.")?;

        self.emit_stage("loading", "Loading Qwen3-ASR on Apple Silicon…", id)
            .await;

        let mut child = Command::new(python)
            .arg(self.qwen_worker_script())
            .args(["--model", definition.remote_id])
            .env("PYTHONUNBUFFERED", "1")
            .env("PYTORCH_ENABLE_MPS_FALLBACK", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("Could not start Qwen worker: {error}"))?;

        let stdout = child.stdout.take().ok_or("Qwen worker has no stdout.")?;
        *self.engine_pid.lock().await = child.id();
        *self.qwen.lock().await = Some(QwenState {
            child,
            ready: false,
            next_job: 0,
        });

        // The worker speaks one JSON object per line; a reader task fans
        // results out to whichever transcription is waiting on that id.
        let pending = self.pending.clone();
        let ready_flag = Arc::new(tokio::sync::Notify::new());
        let notify = ready_flag.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Some(payload) = line.strip_prefix("WAVEFORM:") else {
                    continue;
                };
                let Ok(message) = serde_json::from_str::<serde_json::Value>(payload) else {
                    continue;
                };

                match message.get("type").and_then(|v| v.as_str()) {
                    Some("ready") => notify.notify_waiters(),
                    Some("result") | Some("error") => {
                        let id = message.get("id").and_then(|v| v.as_str()).unwrap_or("");
                        let mut queue = pending.lock().await;
                        if let Some(index) = queue.iter().position(|(job, _)| job == id) {
                            let (_, sender) = queue.remove(index);
                            let outcome = match message.get("text").and_then(|v| v.as_str()) {
                                Some(text) => Ok(text.trim().to_string()),
                                None => Err(message
                                    .get("message")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("Qwen3-ASR failed.")
                                    .to_string()),
                            };
                            let _ = sender.send(outcome);
                        }
                    }
                    _ => {}
                }
            }
        });

        tokio::select! {
            _ = ready_flag.notified() => {}
            _ = sleep(START_TIMEOUT) => return Err("Timed out while loading Qwen3-ASR model.".into()),
        }

        if let Some(state) = self.qwen.lock().await.as_mut() {
            state.ready = true;
        }
        Ok(())
    }

    /// Prefers the copy inside the bundle, so a distributed app does not depend
    /// on the machine it was built on still having the repository.
    fn qwen_worker_script(&self) -> PathBuf {
        if let Some(dir) = &self.resource_dir {
            let bundled = dir.join("qwen-worker.py");
            if bundled.is_file() {
                return bundled;
            }
        }
        self.project_root.join("scripts/qwen-worker.py")
    }

    async fn parakeet_ready(&self) -> bool {
        let url = format!("http://127.0.0.1:{}/ready", self.port());
        match reqwest::Client::new()
            .get(url)
            .timeout(Duration::from_millis(700))
            .send()
            .await
        {
            Ok(response) => response.status().is_success(),
            Err(_) => false,
        }
    }

    async fn transcribe_parakeet(&self, wav: Vec<u8>) -> Result<String, String> {
        let part = reqwest::multipart::Part::bytes(wav)
            .file_name("speech.wav")
            .mime_str("audio/wav")
            .map_err(|error| error.to_string())?;
        let form = reqwest::multipart::Form::new()
            .part("file", part)
            .text("model", "default")
            .text("response_format", "json");

        let response = reqwest::Client::new()
            .post(format!(
                "http://127.0.0.1:{}/v1/audio/transcriptions",
                self.port()
            ))
            .multipart(form)
            .timeout(TRANSCRIBE_TIMEOUT)
            .send()
            .await
            .map_err(|error| format!("Transcription request failed: {error}"))?;

        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(format!("Transcription failed ({status}): {body}"));
        }

        serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|value| {
                value
                    .get("text")
                    .and_then(|t| t.as_str())
                    .map(|t| t.trim().to_string())
            })
            .ok_or_else(|| "Transcription response did not contain text.".to_string())
    }

    async fn transcribe_qwen(&self, wav: Vec<u8>) -> Result<String, String> {
        let job_id;
        let request;
        {
            let mut guard = self.qwen.lock().await;
            let state = guard.as_mut().ok_or("Qwen3-ASR is not ready.")?;
            if !state.ready {
                return Err("Qwen3-ASR is not ready.".into());
            }
            state.next_job += 1;
            job_id = format!("qwen-{}", state.next_job);

            use base64::Engine as _;
            request = serde_json::json!({
                "id": job_id,
                "audio": base64::engine::general_purpose::STANDARD.encode(&wav),
            })
            .to_string();

            let stdin = state.child.stdin.as_mut().ok_or("Qwen worker has no stdin.")?;
            stdin
                .write_all(format!("{request}\n").as_bytes())
                .await
                .map_err(|error| format!("Could not reach Qwen worker: {error}"))?;
            stdin.flush().await.ok();
        }

        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.push((job_id.clone(), sender));

        tokio::select! {
            outcome = receiver => outcome.unwrap_or_else(|_| Err("Qwen worker stopped.".into())),
            _ = sleep(TRANSCRIBE_TIMEOUT) => {
                self.pending.lock().await.retain(|(id, _)| id != &job_id);
                Err("Qwen3-ASR transcription timed out.".into())
            }
        }
    }

    async fn emit_stage(&self, stage: &str, message: &str, id: &str) {
        let event = ModelEvent {
            stage: stage.to_string(),
            message: message.to_string(),
            model_id: id.to_string(),
        };
        *self.last_event.lock().await = event.clone();
        (self.emit)(event);
    }
}

fn find_nemo_runtime() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(configured) = std::env::var("NEMO_SPEECH_BIN") {
        candidates.push(PathBuf::from(configured));
    }
    if let Some(home) = std::env::var_os("HOME") {
        candidates.push(Path::new(&home).join(".local/bin/nemo-speech"));
    }
    // A bundle launched from Finder gets a minimal PATH, so the explicit
    // candidate above matters more than this does.
    if let Ok(path) = std::env::var("PATH") {
        candidates.extend(path.split(':').map(|dir| Path::new(dir).join("nemo-speech")));
    }
    candidates.into_iter().find(|path| is_executable(path))
}

fn find_qwen_runtime(user_data: &Path, project_root: &Path) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(configured) = std::env::var("QWEN_ASR_PYTHON") {
        candidates.push(PathBuf::from(configured));
    }
    candidates.push(user_data.join("qwen/bin/python3"));
    candidates.push(project_root.join(".venv-qwen/bin/python3"));
    candidates.into_iter().find(|path| is_executable(path))
}

fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}
