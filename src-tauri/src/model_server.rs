//! Runs the local speech engine and turns WAV bytes into text.
//!
//! Three shapes sit behind one interface. Whisper is whisper.cpp, linked into
//! this process, and most of the catalogue is one size or quantization of it.
//! Parakeet serves an OpenAI-compatible HTTP endpoint. Qwen is a Python worker
//! spoken to over newline-delimited JSON on stdin/stdout.
//!
//! The worker plumbing is still written for more than one of its kind -- one
//! reader loop, one pending-job table, one readiness handshake, and a
//! `WorkerSpec` saying which interpreter and script to launch. Qwen is the only
//! engine using it today, and OpenAI's own Whisper package was the other.

use crate::download::Download;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
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
    /// Empty when there is nothing to type, because the app fetches this
    /// model's weights itself.
    pub setup_command: String,
    /// Size of the download, when the app can perform it. `None` means the
    /// weights arrive some other way -- an installer, or a virtual
    /// environment -- and only a terminal can bring them.
    pub download_bytes: Option<u64>,
    /// The heading this model is listed under.
    pub group: String,
    /// The one thing worth saying beyond the numbers, or empty when the name
    /// and the figures already say it.
    pub detail: String,
    /// The model's own page on Hugging Face.
    pub card_url: String,
    /// Word error rate on LibriSpeech test-clean, in percent, as Hugging Face
    /// publishes it. `None` where no such figure exists.
    pub wer: Option<f32>,
    /// Roughly what it adds to resident memory once loaded, in MB.
    pub memory_mb: u32,
    /// How that sits on this particular Mac. `None` when the installed memory
    /// could not be read, in which case nothing is claimed about it.
    pub fit: Option<Fit>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelEvent {
    pub stage: String,
    pub message: String,
    pub model_id: String,
    /// How much of a download is done, from 0.0 to 1.0. Absent for every
    /// other stage, which is why it is optional rather than zero.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<f32>,
}

pub struct ModelDefinition {
    pub id: &'static str,
    pub short_label: &'static str,
    pub remote_id: &'static str,
    pub engine: Engine,
    pub weights: Weights,
    pub group: Group,
    /// What this size or quantization is for, kept to the one thing the name
    /// and the numbers do not already say. Empty where they say all of it.
    pub detail: &'static str,
    /// The model's own page on Hugging Face: where the accuracy figure below
    /// comes from, and where someone goes to check it.
    ///
    /// A quantization points at the model it is a quantization of. The weight
    /// file is ggerganov's, but the model is OpenAI's, and the page someone
    /// wants is the one describing what they are about to run.
    pub card_url: &'static str,
    /// Word error rate on LibriSpeech test-clean, in percent, as published on
    /// that page. Lower is better.
    ///
    /// One benchmark across the whole table rather than the best figure each
    /// project quotes, because the column exists to be read down. It is read
    /// audiobook speech, so it flatters every model here in the same
    /// direction; what it is good for is ordering them.
    ///
    /// A quantization uses the figure from the model it is a quantization of:
    /// nobody publishes a separate LibriSpeech number for the q5 file, and the
    /// card this row already links is that model's. Inventing a slightly worse
    /// number would be a guess, not a measurement.
    pub wer: Option<f32>,
    /// Roughly what the model adds to resident memory once loaded, in MB.
    ///
    /// An estimate, not a measurement: the weight file plus the working state
    /// whisper.cpp allocates around it. It exists to be compared against the
    /// memory this Mac has, and to order the models by weight, so being a few
    /// hundred megabytes out does not change what it is used for.
    pub memory_mb: u32,
}

/// Which heading a model is listed under.
///
/// Whisper's English-only weights are kept apart rather than mixed in by size:
/// they are more accurate than their multilingual counterparts and completely
/// useless for anything but English, which is a choice to make deliberately
/// rather than one to stumble into while looking for a size.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Group {
    Whisper,
    WhisperEnglish,
    Other,
}

impl Group {
    pub fn heading(self) -> &'static str {
        match self {
            Group::Whisper => "Whisper",
            Group::WhisperEnglish => "Whisper, English only",
            // Named in the rows themselves. A heading here used to say "Other
            // engines", which made them sound like leftovers.
            Group::Other => "",
        }
    }
}

/// How a model's memory sits against what this Mac has.
///
/// Three tiers rather than a yes or no, because the interesting answer is
/// usually neither: a model can load and still be the wrong choice if it means
/// the rest of the machine starts swapping while dictation is idle.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Fit {
    /// An eighth of installed memory or less. Leave it loaded and forget it.
    Comfortable,
    /// Up to a quarter. It runs; it is also the largest thing on the machine.
    Tight,
    /// More than a quarter of the whole machine.
    TooLarge,
}

/// Where an engine leaves the weights it has downloaded.
///
/// Having a runtime installed is not the same as having a model: `setup:model`
/// installs nemo-speech and pulls Parakeet in two separate steps, and either
/// can be done without the other. Reporting them apart is the only way to say
/// something useful about a model that is not ready.
#[derive(Clone, Copy)]
pub enum Weights {
    /// A GGML `.bin` under Application Support/models/whisper.
    GgmlFile(&'static Download),
    /// nemo-speech caches by repository under models/parakeet.
    NemoCache,
    /// The Hugging Face hub layout under models/qwen.
    HuggingFace,
}

/// One Whisper entry.
///
/// whisper.cpp is linked into the app, so a Whisper model here is nothing but
/// its weight file: a name, a length and a hash. Written as a macro because
/// spelling out the engine, the URL and the `Weights` wrapper fourteen times is
/// fourteen chances to put a hash against the wrong file.
///
/// `bytes` and `sha256` are Hugging Face's own figures for the file -- the size
/// and the LFS object id, which is its SHA-256.
macro_rules! whisper {
    (
        id: $id:literal,
        label: $label:literal,
        file: $file:literal,
        bytes: $bytes:literal,
        sha256: $sha256:literal,
        group: $group:expr,
        memory_mb: $memory_mb:literal,
        card: $card:literal,
        wer: $wer:expr,
        detail: $detail:literal $(,)?
    ) => {
        ModelDefinition {
            id: $id,
            short_label: $label,
            // The weight file's own name, which is all this engine needs.
            remote_id: $file,
            engine: Engine::WhisperCpp,
            weights: Weights::GgmlFile(&Download {
                file: $file,
                url: concat!("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/", $file),
                bytes: $bytes,
                sha256: $sha256,
            }),
            group: $group,
            memory_mb: $memory_mb,
            card_url: concat!("https://huggingface.co/", $card),
            wer: $wer,
            detail: $detail,
        }
    };
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Engine {
    Nemo,
    Qwen,
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

/// Every model the app knows about, in the order the interface lists them:
/// Parakeet and Qwen first, then Whisper lightest-first within each group.
///
/// Whisper still fills most of the table because whisper.cpp is the only engine
/// that needs nothing installed alongside the app -- no interpreter, no virtual
/// environment, no second process -- so every size of it is a model a new Mac
/// can have by pressing a row.
///
/// Not every file in the whisper.cpp repository is listed. `large-v1` and
/// `large-v2` are superseded by `large-v3` at the same size, the `q8_0`
/// quantizations save little over the full weights, and quantized English-only
/// weights combine two compromises for a model already small enough not to
/// need either. `scripts/setup-whisper-cpp.sh` can still fetch any of them into
/// a checkout by name.
pub const MODELS: &[ModelDefinition] = &[
    ModelDefinition {
        id: "parakeet-tdt-0.6b-v3",
        short_label: "Parakeet 0.6B",
        remote_id: "nvidia/parakeet-tdt-0.6b-v3",
        engine: Engine::Nemo,
        weights: Weights::NemoCache,
        group: Group::Other,
        memory_mb: 2_600,
        card_url: "https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3",
        wer: Some(1.93),
        detail: "25 European languages.",
    },
    ModelDefinition {
        id: "qwen3-asr-0.6b",
        short_label: "Qwen3-ASR 0.6B",
        remote_id: "Qwen/Qwen3-ASR-0.6B",
        engine: Engine::Qwen,
        weights: Weights::HuggingFace,
        group: Group::Other,
        memory_mb: 2_800,
        card_url: "https://huggingface.co/Qwen/Qwen3-ASR-0.6B",
        wer: Some(2.11),
        detail: "52 languages, strongest on Chinese.",
    },
    whisper! {
        id: "whisper-cpp-tiny",
        label: "Whisper Tiny",
        file: "ggml-tiny.bin",
        bytes: 77_691_713,
        sha256: "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21",
        group: Group::Whisper,
        memory_mb: 250,
        card: "openai/whisper-tiny",
        wer: Some(7.54),
        detail: "",
    },
    whisper! {
        id: "whisper-cpp-base",
        label: "Whisper Base",
        file: "ggml-base.bin",
        bytes: 147_951_465,
        sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
        group: Group::Whisper,
        memory_mb: 350,
        card: "openai/whisper-base",
        wer: Some(5.01),
        detail: "",
    },
    whisper! {
        id: "whisper-cpp-small",
        label: "Whisper Small",
        file: "ggml-small.bin",
        bytes: 487_601_967,
        sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
        group: Group::Whisper,
        memory_mb: 800,
        card: "openai/whisper-small",
        wer: Some(3.43),
        detail: "",
    },
    whisper! {
        id: "whisper-cpp-small-q5",
        label: "Whisper Small · Q5",
        file: "ggml-small-q5_1.bin",
        bytes: 190_085_487,
        sha256: "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
        group: Group::Whisper,
        memory_mb: 440,
        card: "openai/whisper-small",
        wer: Some(3.43),
        detail: "Whisper Small at 5 bits a weight.",
    },
    whisper! {
        id: "whisper-cpp-medium",
        label: "Whisper Medium",
        file: "ggml-medium.bin",
        bytes: 1_533_763_059,
        sha256: "6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208",
        group: Group::Whisper,
        memory_mb: 2_100,
        card: "openai/whisper-medium",
        wer: Some(2.90),
        detail: "",
    },
    whisper! {
        id: "whisper-cpp-medium-q5",
        label: "Whisper Medium · Q5",
        file: "ggml-medium-q5_0.bin",
        bytes: 539_212_467,
        sha256: "19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f",
        group: Group::Whisper,
        memory_mb: 1_050,
        card: "openai/whisper-medium",
        wer: Some(2.90),
        detail: "Whisper Medium at 5 bits a weight.",
    },
    whisper! {
        id: "whisper-cpp-large-v3-turbo",
        label: "Whisper Large v3 Turbo",
        file: "ggml-large-v3-turbo.bin",
        bytes: 1_624_555_275,
        sha256: "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69",
        group: Group::Whisper,
        memory_mb: 2_200,
        card: "openai/whisper-large-v3-turbo",
        wer: Some(2.10),
        detail: "",
    },
    whisper! {
        id: "whisper-cpp-large-v3-turbo-q5",
        label: "Whisper Large v3 Turbo · Q5",
        file: "ggml-large-v3-turbo-q5_0.bin",
        bytes: 574_041_195,
        sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
        group: Group::Whisper,
        memory_mb: 1_150,
        card: "openai/whisper-large-v3-turbo",
        wer: Some(2.10),
        detail: "Large v3 Turbo at 5 bits a weight.",
    },
    whisper! {
        id: "whisper-cpp-large-v3-q5",
        label: "Whisper Large v3 · Q5",
        file: "ggml-large-v3-q5_0.bin",
        bytes: 1_081_140_203,
        sha256: "d75795ecff3f83b5faa89d1900604ad8c780abd5739fae406de19f23ecd98ad1",
        group: Group::Whisper,
        memory_mb: 1_800,
        card: "openai/whisper-large-v3",
        wer: Some(2.01),
        detail: "Large v3 at 5 bits a weight.",
    },
    whisper! {
        id: "whisper-cpp-large-v3",
        label: "Whisper Large v3",
        file: "ggml-large-v3.bin",
        bytes: 3_095_033_483,
        sha256: "64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2",
        group: Group::Whisper,
        memory_mb: 3_800,
        card: "openai/whisper-large-v3",
        wer: Some(2.01),
        detail: "",
    },
    whisper! {
        id: "whisper-cpp-tiny-en",
        label: "Whisper Tiny · English",
        file: "ggml-tiny.en.bin",
        bytes: 77_704_715,
        sha256: "921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f",
        group: Group::WhisperEnglish,
        memory_mb: 250,
        card: "openai/whisper-tiny.en",
        wer: Some(5.66),
        detail: "",
    },
    whisper! {
        id: "whisper-cpp-base-en",
        label: "Whisper Base · English",
        file: "ggml-base.en.bin",
        bytes: 147_964_211,
        sha256: "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002",
        group: Group::WhisperEnglish,
        memory_mb: 350,
        card: "openai/whisper-base.en",
        wer: Some(4.27),
        detail: "",
    },
    whisper! {
        id: "whisper-cpp-small-en",
        label: "Whisper Small · English",
        file: "ggml-small.en.bin",
        bytes: 487_614_201,
        sha256: "c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d",
        group: Group::WhisperEnglish,
        memory_mb: 800,
        card: "openai/whisper-small.en",
        wer: Some(3.05),
        detail: "",
    },
    whisper! {
        id: "whisper-cpp-medium-en",
        label: "Whisper Medium · English",
        file: "ggml-medium.en.bin",
        bytes: 1_533_774_781,
        sha256: "cc37e93478338ec7700281a7ac30a10128929eb8f427dda2e865faa8f6da4356",
        group: Group::WhisperEnglish,
        memory_mb: 2_100,
        card: "openai/whisper-medium.en",
        wer: Some(3.02),
        detail: "",
    },
];

/// The model a fresh install starts on, and the fallback for a stored id that
/// no longer names anything.
///
/// Named rather than positional -- the table is ordered for the interface to
/// read, Parakeet first, and that is not a model a fresh install can run
/// without a terminal. Small is: it runs on every Apple Silicon Mac, and it is
/// accurate enough that a first dictation is not a bad first impression.
pub const DEFAULT_MODEL_ID: &str = "whisper-cpp-small";

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
}

const QWEN_WORKER: WorkerSpec = WorkerSpec {
    label: "Qwen3-ASR",
    venv: "qwen",
    project_venv: ".venv-qwen",
    env_var: "QWEN_ASR_PYTHON",
    script: "qwen-worker.py",
};

fn runtime(engine: Engine) -> Runtime {
    match engine {
        Engine::Nemo => Runtime::Http,
        Engine::Qwen => Runtime::Worker(&QWEN_WORKER),
        Engine::WhisperCpp => Runtime::InProcess,
    }
}

/// The download a model's weights come from, if they are a single checked file.
///
/// Parakeet and Qwen install through a multi-step pipeline instead; see
/// [`install_bytes`]. Kept for the unit tests that pin which engines use the
/// single-file path.
#[cfg_attr(not(test), allow(dead_code))]
fn downloadable(definition: &ModelDefinition) -> Option<&'static Download> {
    match definition.weights {
        Weights::GgmlFile(spec) => Some(spec),
        Weights::NemoCache | Weights::HuggingFace => None,
    }
}

/// Approximate bytes the Models page shows for Download, including runtime
/// where the engine needs one.
fn install_bytes(definition: &ModelDefinition) -> Option<u64> {
    match definition.weights {
        Weights::GgmlFile(spec) => Some(spec.bytes),
        Weights::NemoCache => Some(crate::install::PARAKEET_INSTALL_BYTES),
        Weights::HuggingFace => Some(crate::install::QWEN_INSTALL_BYTES),
    }
}

/// What the user would have to run to get a model's weights.
///
/// Empty for every catalogue model: the app installs them itself. Kept as a
/// field so an engine that truly cannot be fetched can still name a command.
fn setup_command(_definition: &ModelDefinition) -> &'static str {
    ""
}

pub fn model(id: &str) -> &'static ModelDefinition {
    MODELS.iter().find(|m| m.id == id).unwrap_or_else(default_model)
}

/// `the_default_names_a_real_model` is what stops this falling back at all.
fn default_model() -> &'static ModelDefinition {
    MODELS
        .iter()
        .find(|m| m.id == DEFAULT_MODEL_ID)
        .unwrap_or(&MODELS[0])
}

/// How much memory this Mac has, in MB.
///
/// Read once from the kernel and kept: it cannot change while the app is
/// running, and it is asked for once per row of the models page.
pub fn installed_memory_mb() -> Option<u32> {
    static INSTALLED: std::sync::OnceLock<Option<u32>> = std::sync::OnceLock::new();
    *INSTALLED.get_or_init(|| {
        let output = std::process::Command::new("/usr/sbin/sysctl")
            .args(["-n", "hw.memsize"])
            .stderr(Stdio::null())
            .output()
            .ok()?;
        let bytes: u64 = String::from_utf8_lossy(&output.stdout).trim().parse().ok()?;
        Some((bytes / (1024 * 1024)) as u32)
    })
}

/// Where a model's memory puts it on this machine.
///
/// The thresholds are fractions of installed memory rather than fixed sizes,
/// because the question is not whether the model loads -- macOS will find the
/// pages either way, by swapping something else out -- but whether leaving it
/// loaded is something the rest of the machine notices.
pub fn fit(memory_mb: u32, installed_mb: u32) -> Fit {
    if memory_mb.saturating_mul(8) <= installed_mb {
        Fit::Comfortable
    } else if memory_mb.saturating_mul(4) <= installed_mb {
        Fit::Tight
    } else {
        Fit::TooLarge
    }
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
    /// Which model's weights are being fetched, if any. One at a time: two
    /// writers at one partial file would interleave into something that only
    /// fails its checksum after the whole transfer.
    downloading: Mutex<Option<String>>,
    /// Raised by `cancel_download` and polled by the stream. Cleared when a
    /// fetch starts so a previous cancel cannot kill the next one.
    cancel_download: AtomicBool,
    pending: Arc<Mutex<Vec<(String, oneshot::Sender<Result<String, String>>)>>>,
    transcribe_lock: Mutex<()>,
    project_root: PathBuf,
    emit: Box<dyn Fn(ModelEvent) + Send + Sync>,
}

impl ModelServer {
    pub fn new(
        _user_data: PathBuf,
        project_root: PathBuf,
        resource_dir: Option<PathBuf>,
        selected: String,
        emit: Box<dyn Fn(ModelEvent) + Send + Sync>,
    ) -> Self {
        let initial = ModelEvent {
            stage: "idle".into(),
            message: "Loads when you start listening".into(),
            model_id: selected.clone(),
            progress: None,
        };
        Self {
            selected: Mutex::new(selected),
            resource_dir,
            engine_pid: Mutex::new(None),
            last_event: Mutex::new(initial),
            worker: Mutex::new(None),
            parakeet: Mutex::new(None),
            whisper_cpp: Mutex::new(None),
            downloading: Mutex::new(None),
            cancel_download: AtomicBool::new(false),
            pending: Arc::new(Mutex::new(Vec::new())),
            transcribe_lock: Mutex::new(()),
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

    /// Whether a model could be switched to right now, with no download and
    /// no terminal.
    ///
    /// Synchronous, and deliberately so: the menu bar is built on the main
    /// thread while the async settings lock may be held elsewhere, and it has
    /// nowhere to put a download anyway. A model this says no to is listed
    /// there greyed out rather than hidden, so the menu and the models page
    /// agree about what exists.
    pub fn is_ready(&self, definition: &ModelDefinition) -> bool {
        self.runtime_installed(definition) && weights_present(definition)
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
        let installed = installed_memory_mb();
        MODELS
            .iter()
            .map(|definition| ModelStatus {
                id: definition.id.into(),
                label: definition.short_label.into(),
                selected: definition.id == selected,
                runtime_installed: self.runtime_installed(definition),
                weights_installed: weights_present(definition),
                download_bytes: install_bytes(definition),
                setup_command: setup_command(definition).into(),
                group: definition.group.heading().into(),
                detail: definition.detail.into(),
                card_url: definition.card_url.into(),
                wer: definition.wer,
                memory_mb: definition.memory_mb,
                fit: installed.map(|total| fit(definition.memory_mb, total)),
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
    /// Stops the engine and waits for it to be gone.
    ///
    /// The signal is sent before anything is awaited, so a caller that gives
    /// up waiting has still killed the child. That matters at shutdown: the
    /// alternative is an orphaned engine of several hundred megabytes.
    pub async fn stop(&self) {
        if let Some(mut state) = self.worker.lock().await.take() {
            let _ = state.child.start_kill();
            let _ = state.child.wait().await;
        }
        if let Some(mut child) = self.parakeet.lock().await.take() {
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
        // Dropping the last handle frees the weights, which is anything from a
        // couple of hundred megabytes to four gigabytes of this process's own
        // memory, depending on which size is loaded.
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
            .ok_or("nemo-speech is not installed. Download Parakeet from Models, then try again.")?;

        self.emit_stage("loading", "Loading Parakeet on Metal…", id).await;
        let device = if cfg!(target_arch = "aarch64") { "metal" } else { "cpu" };
        let mut command = Command::new(binary);
        command.args([
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
        ]);
        if let Some(models) = crate::paths::parakeet_models_root() {
            command.env("NEMO_SPEECH_MODEL_DIR", models);
        }
        let child = command
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
                "{} is not installed. Download it from Models, then try again.",
                spec.label
            )
        })?;

        self.emit_stage(
            "loading",
            &format!("Loading {} on Apple Silicon…", spec.label),
            id,
        )
        .await;

        let mut command = Command::new(&python);
        command
            .arg(self.worker_script(spec))
            .args(["--model", definition.remote_id])
            .env("PYTHONUNBUFFERED", "1")
            .env("PYTORCH_ENABLE_MPS_FALLBACK", "1");
        if let Some(hf_home) = crate::paths::qwen_hf_home() {
            command.env("HF_HOME", hf_home);
        }
        let mut child = command
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

    /// The interpreter for an engine: an override, the Application Support
    /// venv, or one beside the checkout.
    fn find_worker_runtime(&self, spec: &WorkerSpec) -> Option<PathBuf> {
        if let Ok(configured) = std::env::var(spec.env_var) {
            let path = PathBuf::from(configured);
            if crate::paths::is_executable(&path) {
                return Some(path);
            }
        }
        if spec.venv == "qwen" {
            if let Some(python) = crate::paths::qwen_python() {
                return Some(python);
            }
        }
        let beside_checkout = self.project_root.join(spec.project_venv).join("bin/python3");
        if crate::paths::is_executable(&beside_checkout) {
            return Some(beside_checkout);
        }
        None
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

    /// Fetches or installs a model so a disk-image user never needs a terminal.
    ///
    /// Whisper is one checked file. Parakeet and Qwen run the same steps the
    /// old `pnpm setup:*` scripts did, writing into Application Support.
    pub async fn download_weights(&self, id: &str) -> Result<(), String> {
        let definition = model(id);
        if install_bytes(definition).is_none() {
            return Err(format!(
                "{} does not download on its own.",
                definition.short_label
            ));
        }

        {
            let mut running = self.downloading.lock().await;
            if running.is_some() {
                return Err("A download is already running.".into());
            }
            *running = Some(id.to_string());
        }
        self.cancel_download.store(false, Ordering::SeqCst);

        let outcome = match definition.weights {
            Weights::GgmlFile(spec) => self.fetch(spec, definition, id).await,
            Weights::NemoCache => self.install_parakeet(definition, id).await,
            Weights::HuggingFace => self.install_qwen(definition, id).await,
        };
        *self.downloading.lock().await = None;

        match &outcome {
            Ok(()) => {
                self.emit_stage(
                    // Downloaded is not loaded: the engine still waits for a
                    // first session, so this must not read as ready.
                    "idle",
                    &format!("{} downloaded", definition.short_label),
                    id,
                )
                .await
            }
            // Cancelled is not a failure: the row goes back to Download, and
            // painting "error" would look like something broke.
            Err(error) if error == crate::download::CANCELLED => {
                self.emit_stage("idle", "Loads when you start listening", id)
                    .await
            }
            Err(error) => self.emit_stage("error", error, id).await,
        }
        outcome
    }

    async fn install_parakeet(
        &self,
        definition: &ModelDefinition,
        id: &str,
    ) -> Result<(), String> {
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel::<(String, f32)>();
        let report = move |message: &str, fraction: f32| {
            let _ = sender.send((message.to_string(), fraction));
        };
        let install = crate::install::install_parakeet(
            definition.remote_id,
            &self.cancel_download,
            &report,
        );
        tokio::pin!(install);
        loop {
            tokio::select! {
                outcome = &mut install => return outcome,
                Some((message, fraction)) = receiver.recv() => {
                    self.emit_event("downloading", &message, id, Some(fraction)).await;
                }
            }
        }
    }

    async fn install_qwen(&self, definition: &ModelDefinition, id: &str) -> Result<(), String> {
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel::<(String, f32)>();
        let report = move |message: &str, fraction: f32| {
            let _ = sender.send((message.to_string(), fraction));
        };
        let install =
            crate::install::install_qwen(definition.remote_id, &self.cancel_download, &report);
        tokio::pin!(install);
        loop {
            tokio::select! {
                outcome = &mut install => return outcome,
                Some((message, fraction)) = receiver.recv() => {
                    self.emit_event("downloading", &message, id, Some(fraction)).await;
                }
            }
        }
    }

    /// Stops the in-flight Whisper download, if any.
    pub fn cancel_download(&self) {
        self.cancel_download.store(true, Ordering::SeqCst);
    }

    /// Deletes a model's weights from disk so they stop occupying space.
    ///
    /// Whisper files live under Application Support; Parakeet and Qwen live in
    /// their own caches. Each path is named by the model id, so this is not
    /// guessing which bytes belong to Waveform. If this is the model currently
    /// loaded, it is unloaded first so the mapping is gone before the file is.
    pub async fn delete_weights(&self, id: &str) -> Result<(), String> {
        if self.downloading.lock().await.as_deref() == Some(id) {
            return Err("That model is still downloading.".into());
        }
        if *self.selected.lock().await == id {
            self.stop().await;
        }
        remove_downloaded_weights(id)
    }

    /// Streams a weight file down, with the interface told how far it has got.
    ///
    /// The fetching itself is shared with the local polish models; what belongs
    /// here is only where Whisper keeps its weights and who hears about the
    /// progress. Progress arrives on a channel because reporting it is an async
    /// act and a download reports from inside a synchronous callback.
    async fn fetch(
        &self,
        spec: &Download,
        definition: &ModelDefinition,
        id: &str,
    ) -> Result<(), String> {
        let dir = crate::whisper_cpp::weights_dir()
            .ok_or("Could not work out where Whisper's weights live.")?;

        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let report = move |fraction: f32| {
            let _ = sender.send(fraction);
        };
        let download = crate::download::fetch(spec, &dir, &report, &self.cancel_download);
        tokio::pin!(download);

        loop {
            tokio::select! {
                outcome = &mut download => return outcome,
                Some(fraction) = receiver.recv() => {
                    // Nothing has arrived yet at zero, and "0%" reads as a
                    // download that is stuck rather than one just starting.
                    let message = if fraction <= 0.0 {
                        format!("Downloading {}…", definition.short_label)
                    } else {
                        format!(
                            "Downloading {} — {}%",
                            definition.short_label,
                            (fraction * 100.0).round() as u32
                        )
                    };
                    self.emit_event("downloading", &message, id, Some(fraction)).await;
                }
            }
        }
    }

    async fn emit_stage(&self, stage: &str, message: &str, id: &str) {
        self.emit_event(stage, message, id, None).await;
    }

    async fn emit_event(&self, stage: &str, message: &str, id: &str, progress: Option<f32>) {
        let event = ModelEvent {
            stage: stage.to_string(),
            message: message.to_string(),
            model_id: id.to_string(),
            progress,
        };
        *self.last_event.lock().await = event.clone();
        (self.emit)(event);
    }
}

/// Removes a model's weights from the place that engine keeps them.
///
/// Named by id rather than by a resolved `ModelDefinition`: `model()` falls
/// back to the default, and deleting Small because someone typed a typo is
/// the wrong kind of helpful.
fn remove_downloaded_weights(id: &str) -> Result<(), String> {
    let definition = MODELS
        .iter()
        .find(|candidate| candidate.id == id)
        .ok_or_else(|| format!("{id} is not a model Waveform knows about."))?;
    match definition.weights {
        Weights::GgmlFile(spec) => {
            // Clear both new and legacy Whisper locations so Remove never
            // leaves a file that a later launch would treat as installed.
            for dir in [
                crate::paths::whisper_dir(),
                crate::paths::waveform_home().map(|home| home.join("whisper.cpp")),
            ]
            .into_iter()
            .flatten()
            {
                let path = dir.join(spec.file);
                if path.is_file() {
                    std::fs::remove_file(&path).map_err(|error| {
                        format!("Could not delete {}: {error}", definition.short_label)
                    })?;
                }
            }
        }
        Weights::NemoCache => {
            remove_dir_if_present_all(
                &[
                    crate::paths::parakeet_models_root()
                        .map(|root| root.join(definition.remote_id)),
                    std::env::var_os("HOME").map(|home| {
                        Path::new(&home)
                            .join("Library/Caches/NeMoSpeech/models")
                            .join(definition.remote_id)
                    }),
                ],
                definition.short_label,
            )?;
        }
        Weights::HuggingFace => {
            let folder = format!("models--{}", definition.remote_id.replace('/', "--"));
            remove_dir_if_present_all(
                &[
                    crate::paths::qwen_hf_home().map(|home| home.join("hub").join(&folder)),
                    std::env::var_os("HOME").map(|home| {
                        Path::new(&home)
                            .join(".cache/huggingface/hub")
                            .join(&folder)
                    }),
                ],
                definition.short_label,
            )?;
        }
    }
    Ok(())
}

fn remove_dir_if_present_all(paths: &[Option<PathBuf>], label: &str) -> Result<(), String> {
    for path in paths.iter().flatten() {
        remove_dir_if_present(path, label)?;
    }
    Ok(())
}

fn remove_dir_if_present(path: &Path, label: &str) -> Result<(), String> {
    if path.exists() {
        std::fs::remove_dir_all(path)
            .map_err(|error| format!("Could not delete {label}: {error}"))?;
    }
    Ok(())
}

/// Whether a model's weights are already on this machine.
///
/// Each engine keeps them somewhere of its own choosing, so this asks each in
/// its own terms rather than pretending there is one cache.
fn weights_present(definition: &ModelDefinition) -> bool {
    match definition.weights {
        Weights::NemoCache => crate::paths::parakeet_model_dir(definition.remote_id)
            .map(|path| crate::paths::dir_has_contents(&path))
            .unwrap_or(false),
        Weights::HuggingFace => crate::paths::qwen_model_dir(definition.remote_id)
            .map(|path| crate::paths::dir_has_contents(&path.join("snapshots")))
            .unwrap_or(false),
        // The partial file a download writes to is a different name, so an
        // interrupted transfer reads as absent rather than as installed.
        Weights::GgmlFile(spec) => crate::whisper_cpp::weights_path(spec.file)
            .map(|path| path.is_file())
            .unwrap_or(false),
    }
}

fn find_nemo_runtime() -> Option<PathBuf> {
    crate::paths::find_nemo_speech()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Where every weight file comes from, spelled out once here so that the
    /// copy inside `whisper!` is checked rather than trusted. The file name is
    /// the only part that differs between models.
    ///
    /// Kept in step with scripts/setup-whisper-cpp.sh, which fetches the same
    /// files for a checkout.
    const GGML_HOST: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/";

    /// The point of the whole download path: a model can be had without a
    /// terminal exactly when its weights are a single file, which is every
    /// whisper.cpp model and nothing else.
    #[test]
    fn only_the_ggml_weights_download_themselves() {
        for definition in MODELS.iter() {
            let expected = definition.engine == Engine::WhisperCpp;
            assert_eq!(
                downloadable(definition).is_some(),
                expected,
                "{} downloads itself: {expected} expected",
                definition.id
            );
        }
    }

    /// A download is a URL, a length and a hash that all describe one file. A
    /// URL pointing at something else would only be found out by a user, and
    /// the same hash against two files is the mistake a table of fourteen of
    /// them invites.
    #[test]
    fn every_download_describes_the_file_it_names() {
        let mut seen: Vec<&str> = Vec::new();
        for definition in MODELS.iter() {
            let Some(spec) = downloadable(definition) else {
                continue;
            };
            assert_eq!(spec.url, format!("{GGML_HOST}{}", spec.file));
            assert_eq!(spec.file, definition.remote_id);
            assert_eq!(spec.sha256.len(), 64, "{}", definition.id);
            assert!(spec.sha256.chars().all(|c| c.is_ascii_hexdigit()));
            assert!(spec.bytes > 0);
            assert!(
                !seen.contains(&spec.sha256),
                "{} repeats a hash from another model",
                definition.id
            );
            seen.push(spec.sha256);
        }
        assert_eq!(seen.len(), 14, "every Whisper size should be downloadable");
    }

    /// Ids reach this table from disk and from the interface, and both resolve
    /// through `model()`, which cannot report a miss.
    #[test]
    fn ids_are_unique_and_the_default_names_a_real_model() {
        for definition in MODELS.iter() {
            let matches = MODELS.iter().filter(|other| other.id == definition.id).count();
            assert_eq!(matches, 1, "{} is listed more than once", definition.id);
        }
        assert_eq!(default_model().id, DEFAULT_MODEL_ID);
        assert_eq!(model("no-such-model").id, DEFAULT_MODEL_ID);
    }

    /// Parakeet leads the catalogue. The page used to mark it recommended; the
    /// list order is what remains of that preference.
    #[test]
    fn parakeet_leads_the_catalogue() {
        assert_eq!(MODELS[0].id, "parakeet-tdt-0.6b-v3");
        assert_eq!(MODELS[0].group, Group::Other);
        assert_eq!(MODELS[0].group.heading(), "");
    }

    /// Every catalogue entry has a place its weights live, so Remove can clear
    /// that place rather than only Whisper's Application Support files.
    #[test]
    fn every_model_has_removable_weights() {
        for definition in MODELS {
            match definition.weights {
                Weights::GgmlFile(_) => assert!(
                    downloadable(definition).is_some(),
                    "{} should be a file the app can fetch",
                    definition.id
                ),
                Weights::NemoCache => assert!(
                    crate::paths::parakeet_model_dir(definition.remote_id).is_some(),
                    "{} should resolve a NeMo cache path",
                    definition.id
                ),
                Weights::HuggingFace => assert!(
                    crate::paths::qwen_model_dir(definition.remote_id).is_some(),
                    "{} should resolve a Hugging Face cache path",
                    definition.id
                ),
            }
        }
        let error = remove_downloaded_weights("no-such-model").expect_err("unknown");
        assert!(error.contains("not a model"), "{error}");
    }

    /// The file is what occupies the disk, so deleting it has to leave nothing
    /// a later launch would treat as installed.
    #[test]
    fn deleting_whisper_weights_removes_the_file() {
        let dir = std::env::temp_dir().join(format!(
            "waveform-delete-whisper-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let file = "ggml-tiny.bin";
        std::fs::write(dir.join(file), b"not-weights").expect("plant a file");

        let previous = std::env::var_os("WAVEFORM_WHISPER_CPP_DIR");
        std::env::set_var("WAVEFORM_WHISPER_CPP_DIR", &dir);
        let outcome = remove_downloaded_weights("whisper-cpp-tiny");
        match previous {
            Some(value) => std::env::set_var("WAVEFORM_WHISPER_CPP_DIR", value),
            None => std::env::remove_var("WAVEFORM_WHISPER_CPP_DIR"),
        }

        outcome.expect("tiny should delete");
        assert!(!dir.join(file).exists(), "the weight file should be gone");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn memory_is_judged_as_a_fraction_of_the_machine() {
        assert_eq!(fit(800, 16 * 1024), Fit::Comfortable);
        assert_eq!(fit(2_200, 16 * 1024), Fit::Tight);
        assert_eq!(fit(3_800, 8 * 1024), Fit::TooLarge);
        // Every model claims some memory, or the fit of it would be meaningless.
        for definition in MODELS.iter() {
            assert!(definition.memory_mb > 0, "{}", definition.id);
        }
    }

    /// The models page reads down a column of these, so a missing card link is
    /// a row with nothing to check the number against, and a wild figure is one
    /// that silently reorders the list.
    ///
    /// Quantized builds reuse the parent model's published figure: inventing a
    /// worse number would look measured. This names the pairs so a future row
    /// cannot quietly pick a different one.
    #[test]
    fn every_model_links_a_card_and_has_a_published_figure() {
        for definition in MODELS.iter() {
            assert!(
                definition.card_url.starts_with("https://huggingface.co/"),
                "{} does not link a Hugging Face page",
                definition.id
            );
            let wer = definition
                .wer
                .unwrap_or_else(|| panic!("{} has no word error rate", definition.id));
            // Nothing here is under 1% on LibriSpeech test-clean, and
            // nothing usable is over 20%.
            assert!((1.0..20.0).contains(&wer), "{} claims {wer}%", definition.id);
        }

        let wer_of = |id: &str| {
            MODELS
                .iter()
                .find(|definition| definition.id == id)
                .unwrap_or_else(|| panic!("{id} is not listed"))
                .wer
        };
        assert_eq!(wer_of("whisper-cpp-small-q5"), wer_of("whisper-cpp-small"));
        assert_eq!(wer_of("whisper-cpp-medium-q5"), wer_of("whisper-cpp-medium"));
        assert_eq!(
            wer_of("whisper-cpp-large-v3-turbo-q5"),
            wer_of("whisper-cpp-large-v3-turbo")
        );
        assert_eq!(wer_of("whisper-cpp-large-v3-q5"), wer_of("whisper-cpp-large-v3"));
    }

    /// Every catalogue model installs from the app. Setup commands are gone:
    /// a disk-image user has no checkout to run them in.
    #[test]
    fn every_model_installs_from_the_app() {
        for definition in MODELS.iter() {
            assert!(
                install_bytes(definition).is_some(),
                "{} should expose an install size",
                definition.id
            );
            assert!(
                setup_command(definition).is_empty(),
                "{} should not name a terminal setup command",
                definition.id
            );
        }
    }
}
