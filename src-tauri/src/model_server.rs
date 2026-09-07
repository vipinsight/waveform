//! Runs the local speech engine and turns WAV bytes into text.
//!
//! Two shapes sit behind one interface. Parakeet serves an OpenAI-compatible
//! HTTP endpoint. Qwen and Whisper are Python workers spoken to over
//! newline-delimited JSON on stdin/stdout -- the same protocol, so they share
//! one reader loop, one pending-job table and one readiness handshake, and
//! differ only in which interpreter and script are launched.

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

/// What the interface needs to say whether a model can be used, and what to run
/// if it cannot.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    pub id: String,
    pub label: String,
    pub selected: bool,
    pub runtime_installed: bool,
    pub weights_installed: bool,
    pub setup_command: String,
}

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
    pub weights: Weights,
}

/// Where an engine leaves the weights it has downloaded.
///
/// Having a runtime installed is not the same as having a model: `setup:model`
/// installs nemo-speech and pulls Parakeet in two separate steps, and either
/// can be done without the other. Reporting them apart is the only way to say
/// something useful about a model that is not ready.
#[derive(Clone, Copy)]
pub enum Weights {
    /// A GGML `.bin` beside the app's own data, downloaded by
    /// `setup:whisper-cpp`. Unrelated to the Python package's `.pt` files.
    GgmlFile(&'static str),
    /// nemo-speech caches by repository under the platform cache directory.
    NemoCache,
    /// The Hugging Face hub layout, `models--<org>--<name>`.
    HuggingFace,
    /// Whisper names its own file under `~/.cache/whisper`; the name is not
    /// the model id, so it is spelled out.
    WhisperFile(&'static str),
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Engine {
    Nemo,
    Qwen,
    Whisper,
    /// whisper.cpp, linked into this process rather than run beside it.
    WhisperCpp,
}

/// How an engine is reached, which is what every "is it installed?" and "how
/// do I talk to it?" question actually turns on.
///
/// Kept apart from `Engine` so adding an engine cannot quietly land in the
/// wrong branch: this used to be `Option<&WorkerSpec>`, where `None` silently
/// meant Parakeet.
enum Runtime {
    /// Serves an OpenAI-compatible endpoint over HTTP.
    Http,
    /// A Python process spoken to over stdin/stdout.
    Worker(&'static WorkerSpec),
    /// Compiled in. Nothing to install, nothing to launch.
    InProcess,
}

/// The first entry is the default for a fresh install, and the fallback for a
/// stored id that no longer names anything.
///
/// whisper.cpp leads because it is the only engine that needs nothing
/// installed alongside the app: no interpreter, no virtual environment, no
/// second process. A new Mac can dictate as soon as the weights land.
pub const MODELS: [ModelDefinition; 4] = [
    ModelDefinition {
        id: "whisper-cpp-small",
        short_label: "Whisper Small (whisper.cpp)",
        // The GGML weight file's own name, which is all this engine needs.
        remote_id: "ggml-small.bin",
        engine: Engine::WhisperCpp,
        weights: Weights::GgmlFile("ggml-small.bin"),
    },
    ModelDefinition {
        id: "parakeet-tdt-0.6b-v3",
        short_label: "Parakeet 0.6B",
        remote_id: "nvidia/parakeet-tdt-0.6b-v3",
        engine: Engine::Nemo,
        weights: Weights::NemoCache,
    },
    ModelDefinition {
        id: "qwen3-asr-0.6b",
        short_label: "Qwen3-ASR 0.6B",
        remote_id: "Qwen/Qwen3-ASR-0.6B",
        engine: Engine::Qwen,
        weights: Weights::HuggingFace,
    },
    ModelDefinition {
        id: "whisper-small",
        short_label: "Whisper Small",
        // What `whisper.load_model` takes, not a Hugging Face path: the
        // official package names its own weights.
        remote_id: "small",
        engine: Engine::Whisper,
        weights: Weights::WhisperFile("small.pt"),
    },
];

/// Everything that differs between the two Python engines.
///
/// Each keeps its own virtual environment: they pin different torch versions,
/// and one failing to resolve should not take the other down with it.
struct WorkerSpec {
    /// How the engine is named in anything the user reads.
    label: &'static str,
    /// Virtual environment under Application Support, and beside the checkout.
    venv: &'static str,
    project_venv: &'static str,
    /// Overrides the interpreter, for running against another install.
    env_var: &'static str,
    script: &'static str,
    setup_command: &'static str,
}

const QWEN_WORKER: WorkerSpec = WorkerSpec {
    label: "Qwen3-ASR",
    venv: "qwen",
    project_venv: ".venv-qwen",
    env_var: "QWEN_ASR_PYTHON",
    script: "qwen-worker.py",
    setup_command: "pnpm setup:qwen",
};

const WHISPER_WORKER: WorkerSpec = WorkerSpec {
    label: "Whisper",
    venv: "whisper",
    project_venv: ".venv-whisper",
    env_var: "WAVEFORM_WHISPER_PYTHON",
    script: "whisper-worker.py",
    setup_command: "pnpm setup:whisper",
};

fn runtime(engine: Engine) -> Runtime {
    match engine {
        Engine::Nemo => Runtime::Http,
        Engine::Qwen => Runtime::Worker(&QWEN_WORKER),
        Engine::Whisper => Runtime::Worker(&WHISPER_WORKER),
        Engine::WhisperCpp => Runtime::InProcess,
    }
}

pub fn model(id: &str) -> &'static ModelDefinition {
    MODELS.iter().find(|m| m.id == id).unwrap_or(&MODELS[0])
}

struct WorkerState {
    child: Child,
    /// Which engine this worker serves. Qwen and Whisper share the one slot, so
    /// "is a worker ready?" is not a useful question on its own -- a Qwen
    /// worker left running would otherwise be handed Whisper's audio.
    engine: Engine,
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
    worker: Mutex<Option<WorkerState>>,
    /// Held so the engine can be shut down. Parakeet serves over HTTP and does
    /// not exit on its own, so dropping this handle would leave a process of
    /// several hundred megabytes running after the app quits.
    parakeet: Mutex<Option<Child>>,
    /// Loaded whisper.cpp weights, shared with whichever blocking thread is
    /// transcribing. Held behind an `Arc` so a phrase in flight keeps the
    /// model alive even if the selection changes underneath it.
    whisper_cpp: Mutex<Option<Arc<whisper_rs::WhisperContext>>>,
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
            worker: Mutex::new(None),
            parakeet: Mutex::new(None),
            whisper_cpp: Mutex::new(None),
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

    /// Whether the selected engine's runtime exists on this machine.
    ///
    /// Reported up front so setup can say what is missing, rather than the
    /// user discovering it when their first phrase fails.
    pub async fn is_installed(&self) -> bool {
        let id = self.selected.lock().await.clone();
        self.runtime_installed(model(&id))
    }

    /// Whether a model's engine could run at all, weights aside.
    fn runtime_installed(&self, definition: &ModelDefinition) -> bool {
        match runtime(definition.engine) {
            Runtime::Http => find_nemo_runtime().is_some(),
            Runtime::Worker(spec) => {
                self.find_worker_runtime(spec).is_some() && self.worker_script(spec).is_file()
            }
            // Linked into this binary, so it is installed wherever the app is.
            Runtime::InProcess => true,
        }
    }

    /// Every model, and what is on this machine for each of them.
    pub async fn catalog(&self) -> Vec<ModelStatus> {
        let selected = self.selected.lock().await.clone();
        MODELS
            .iter()
            .map(|definition| ModelStatus {
                id: definition.id.into(),
                label: definition.short_label.into(),
                selected: definition.id == selected,
                runtime_installed: self.runtime_installed(definition),
                weights_installed: weights_present(definition),
                setup_command: match runtime(definition.engine) {
                    Runtime::Http => "pnpm setup:model".into(),
                    Runtime::Worker(spec) => spec.setup_command.into(),
                    Runtime::InProcess => "pnpm setup:whisper-cpp".into(),
                },
            })
            .collect()
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

        let ready = match runtime(definition.engine) {
            Runtime::Http => self.parakeet_ready().await,
            Runtime::Worker(_) => self
                .worker
                .lock()
                .await
                .as_ref()
                .map(|state| state.ready && state.engine == definition.engine)
                .unwrap_or(false),
            Runtime::InProcess => self.whisper_cpp.lock().await.is_some(),
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

        match runtime(definition.engine) {
            Runtime::Http => self.start_parakeet(definition, &id).await?,
            Runtime::Worker(spec) => {
                // Whichever engine was running, it is not this one, and both
                // are hundreds of megabytes of Python.
                if let Some(mut previous) = self.worker.lock().await.take() {
                    let _ = previous.child.kill().await;
                }
                self.start_worker(spec, definition, &id).await?
            }
            Runtime::InProcess => self.start_whisper_cpp(definition, &id).await?,
        }

        self.emit_stage("ready", &format!("{} ready", definition.short_label), &id)
            .await;
        Ok(())
    }

    /// Shuts the engine down. Called when the app exits.
    pub async fn stop(&self) {
        if let Some(mut state) = self.worker.lock().await.take() {
            let _ = state.child.kill().await;
        }
        if let Some(mut child) = self.parakeet.lock().await.take() {
            let _ = child.kill().await;
        }
        // Dropping the last handle frees the weights, which for Whisper Small
        // is most of a gigabyte of this process's own memory.
        self.whisper_cpp.lock().await.take();
        *self.engine_pid.lock().await = None;
        for (_, sender) in self.pending.lock().await.drain(..) {
            let _ = sender.send(Err("Speech model changed.".into()));
        }
    }

    /// `language` is an ISO 639-1 code, or empty to let the engine detect one.
    ///
    /// Passed per phrase rather than fixed when the engine starts, so changing
    /// it takes effect on the next phrase instead of after a reload.
    pub async fn transcribe(&self, wav: Vec<u8>, language: &str) -> Result<String, String> {
        // One request at a time: both engines are single-threaded, and
        // overlapping calls only queue behind each other anyway.
        let _guard = self.transcribe_lock.lock().await;
        self.start().await?;

        let id = self.selected.lock().await.clone();
        match runtime(model(&id).engine) {
            Runtime::Http => self.transcribe_parakeet(wav, language).await,
            Runtime::Worker(spec) => self.transcribe_worker(spec, wav, language).await,
            Runtime::InProcess => self.transcribe_whisper_cpp(wav, language).await,
        }
    }

    /// Loads whisper.cpp's weights into this process.
    ///
    /// The load is the slow part and it holds a lock, so it runs on a blocking
    /// thread: doing it on the async runtime would stall the HUD's animation
    /// and the hotkey listener for as long as it took.
    async fn start_whisper_cpp(
        &self,
        definition: &ModelDefinition,
        id: &str,
    ) -> Result<(), String> {
        // A Python worker left running would otherwise sit on a gigabyte of
        // memory that nothing is going to ask for again.
        if let Some(mut previous) = self.worker.lock().await.take() {
            let _ = previous.child.kill().await;
        }
        self.emit_stage("loading", "Loading Whisper on Metal…", id).await;

        let file = definition.remote_id;
        let context = tokio::task::spawn_blocking(move || crate::whisper_cpp::load(file))
            .await
            .map_err(|error| format!("Loading Whisper panicked: {error}"))??;
        *self.whisper_cpp.lock().await = Some(Arc::new(context));
        // In this process, so there is no separate engine to report on.
        *self.engine_pid.lock().await = None;
        Ok(())
    }

    async fn transcribe_whisper_cpp(
        &self,
        wav: Vec<u8>,
        language: &str,
    ) -> Result<String, String> {
        let context = self
            .whisper_cpp
            .lock()
            .await
            .clone()
            .ok_or("Whisper is not loaded.")?;
        let language = language.to_string();
        tokio::task::spawn_blocking(move || {
            let audio = crate::whisper_cpp::decode_wav(&wav)?;
            crate::whisper_cpp::transcribe(&context, &audio, &language)
        })
        .await
        .map_err(|error| format!("Transcription panicked: {error}"))?
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

    /// Starts a Python worker and waits for it to say it is ready.
    async fn start_worker(
        &self,
        spec: &'static WorkerSpec,
        definition: &ModelDefinition,
        id: &str,
    ) -> Result<(), String> {
        let python = self.find_worker_runtime(spec).ok_or_else(|| {
            format!(
                "{} is not installed. Run `{}`, then try again.",
                spec.label, spec.setup_command
            )
        })?;

        self.emit_stage(
            "loading",
            &format!("Loading {} on Apple Silicon…", spec.label),
            id,
        )
        .await;

        let mut child = Command::new(python)
            .arg(self.worker_script(spec))
            .args(["--model", definition.remote_id])
            .env("PYTHONUNBUFFERED", "1")
            .env("PYTORCH_ENABLE_MPS_FALLBACK", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("Could not start the {} worker: {error}", spec.label))?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| format!("The {} worker has no stdout.", spec.label))?;
        *self.engine_pid.lock().await = child.id();
        *self.worker.lock().await = Some(WorkerState {
            child,
            engine: definition.engine,
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
                                    .unwrap_or(spec.label)
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
            _ = sleep(START_TIMEOUT) => {
                return Err(format!("Timed out while loading the {} model.", spec.label))
            }
        }

        if let Some(state) = self.worker.lock().await.as_mut() {
            state.ready = true;
        }
        Ok(())
    }

    /// Prefers the copy inside the bundle, so a distributed app does not depend
    /// on the machine it was built on still having the repository.
    fn worker_script(&self, spec: &WorkerSpec) -> PathBuf {
        if let Some(dir) = &self.resource_dir {
            let bundled = dir.join(spec.script);
            if bundled.is_file() {
                return bundled;
            }
        }
        self.project_root.join("scripts").join(spec.script)
    }

    /// The interpreter for an engine: an override, the environment the setup
    /// script builds, or one beside the checkout.
    fn find_worker_runtime(&self, spec: &WorkerSpec) -> Option<PathBuf> {
        let mut candidates: Vec<PathBuf> = Vec::new();
        if let Ok(configured) = std::env::var(spec.env_var) {
            candidates.push(PathBuf::from(configured));
        }
        candidates.push(self.user_data.join(spec.venv).join("bin/python3"));
        candidates.push(self.project_root.join(spec.project_venv).join("bin/python3"));
        candidates.into_iter().find(|path| is_executable(path))
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

    async fn transcribe_parakeet(&self, wav: Vec<u8>, language: &str) -> Result<String, String> {
        let part = reqwest::multipart::Part::bytes(wav)
            .file_name("speech.wav")
            .mime_str("audio/wav")
            .map_err(|error| error.to_string())?;
        let mut form = reqwest::multipart::Form::new()
            .part("file", part)
            .text("model", "default")
            .text("response_format", "json");
        // Omitted rather than sent empty: the field's absence is what asks for
        // detection, and an empty string is not a language.
        if !language.is_empty() {
            form = form.text("language", language.to_string());
        }

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

    async fn transcribe_worker(
        &self,
        spec: &WorkerSpec,
        wav: Vec<u8>,
        language: &str,
    ) -> Result<String, String> {
        let job_id;
        let request;
        {
            let mut guard = self.worker.lock().await;
            let not_ready = || format!("{} is not ready.", spec.label);
            let state = guard.as_mut().ok_or_else(not_ready)?;
            if !state.ready || !matches!(runtime(state.engine), Runtime::Worker(s) if s.script == spec.script)
            {
                return Err(not_ready());
            }
            state.next_job += 1;
            job_id = format!("{}-{}", spec.venv, state.next_job);

            use base64::Engine as _;
            request = serde_json::json!({
                "id": job_id,
                "audio": base64::engine::general_purpose::STANDARD.encode(&wav),
                // Null, not "", so the worker can pass it straight through to
                // an engine that reads null as "detect".
                "language": (!language.is_empty()).then(|| language.to_string()),
            })
            .to_string();

            let stdin = state
                .child
                .stdin
                .as_mut()
                .ok_or_else(|| format!("The {} worker has no stdin.", spec.label))?;
            stdin
                .write_all(format!("{request}\n").as_bytes())
                .await
                .map_err(|error| format!("Could not reach the {} worker: {error}", spec.label))?;
            stdin.flush().await.ok();
        }

        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.push((job_id.clone(), sender));

        tokio::select! {
            outcome = receiver => {
                outcome.unwrap_or_else(|_| Err(format!("The {} worker stopped.", spec.label)))
            }
            _ = sleep(TRANSCRIBE_TIMEOUT) => {
                self.pending.lock().await.retain(|(id, _)| id != &job_id);
                Err(format!("{} transcription timed out.", spec.label))
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

/// Whether a model's weights are already on this machine.
///
/// Each engine keeps them somewhere of its own choosing, so this asks each in
/// its own terms rather than pretending there is one cache.
fn weights_present(definition: &ModelDefinition) -> bool {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return false;
    };
    match definition.weights {
        Weights::NemoCache => {
            let root = std::env::var_os("NEMO_SPEECH_MODEL_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join("Library/Caches/NeMoSpeech/models"));
            has_contents(&root.join(definition.remote_id))
        }
        Weights::HuggingFace => {
            let cache = std::env::var_os("HF_HOME")
                .map(|value| PathBuf::from(value).join("hub"))
                .unwrap_or_else(|| home.join(".cache/huggingface/hub"));
            let folder = format!("models--{}", definition.remote_id.replace('/', "--"));
            has_contents(&cache.join(folder).join("snapshots"))
        }
        Weights::WhisperFile(name) => home.join(".cache/whisper").join(name).is_file(),
        Weights::GgmlFile(name) => crate::whisper_cpp::weights_path(name)
            .map(|path| path.is_file())
            .unwrap_or(false),
    }
}

/// A directory that exists but is empty is a download that did not finish.
fn has_contents(path: &Path) -> bool {
    std::fs::read_dir(path)
        .map(|mut entries| entries.next().is_some())
        .unwrap_or(false)
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

fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}
