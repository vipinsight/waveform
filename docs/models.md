# Models: how one is chosen, and how it runs

Waveform ships four speech models over three genuinely different execution
mechanisms. `README.md` covers this from the outside — which `pnpm setup:*`
script installs what. This is the inside: how a model id becomes a running
engine, where each engine's weights are looked for, and which parts of that
story are still unfinished.

Line references drift. Treat them as a starting point, not a promise.

## Two registries, kept in step by hand

The catalogue exists twice. `SPEECH_MODELS` in
[src/shared/models.ts](../src/shared/models.ts) is what the interface knows;
`MODELS` in [src-tauri/src/model_server.rs:101](../src-tauri/src/model_server.rs)
is what actually runs. The Rust table carries two things the TypeScript one does
not — an `Engine` and a `Weights` variant — and the TypeScript table carries a
long `label` the Rust one has no use for.

Nothing checks that the two agree. `tests/model-registry.test.ts` pins the
TypeScript list, and `every_engine_model_survives_load` in
[src-tauri/src/settings.rs:281](../src-tauri/src/settings.rs) iterates the Rust
one, but no test compares them. Adding a model means editing both.

The default is positional in both places:
`DEFAULT_SPEECH_MODEL_ID = SPEECH_MODELS[0].id`, and `default_model_id()`
reading `MODELS[0].id` ([settings.rs:36](../src-tauri/src/settings.rs)). Nothing
names a default; `whisper-cpp-small` is one because it is first, which is
deliberate — it is the only model a fresh install can get on its own.

There used to be a third copy of the id list, in the settings validator, and the
comment it left behind is worth reading before adding a fourth
([settings.rs:21](../src-tauri/src/settings.rs)):

> Read from the engine's own table rather than repeated here: a hand-kept copy
> that fell behind is what silently reverted every attempt to choose Whisper,
> because `normalize` treated a real model id as corrupt input.

`is_known_model` now reads `MODELS` directly, and `rejects_an_unknown_speech_model`
guards the other side of it. The TypeScript equivalent is `isSpeechModelId`.

## From a click to a running engine

1. `#model-list` is an empty `role="radiogroup"`
   ([index.html:374](../src/renderer/index.html)); the rows are built at runtime.
2. `renderModels()` ([renderer.ts:621](../src/renderer/renderer.ts)) asks for
   `getModelCatalog()` and emits one `<button role="radio" data-model=…>` per
   entry. A model that cannot run is listed rather than hidden — the page's job
   is to say what is available and what it would take to have it — so it gets
   `aria-disabled="true"` and a line naming the setup command.
3. A delegated click handler ([renderer.ts:209](../src/renderer/renderer.ts))
   validates the id with `isSpeechModelId`, ignores disabled rows, and calls
   `host().selectModel(id)`.
4. `select_model` ([lib.rs:300](../src-tauri/src/lib.rs)) **persists before
   starting**: otherwise the choice is lost on relaunch, and the next
   `settings-changed` broadcast snaps the picker back to the stored value.
5. `ModelServer::select()` stops the previous engine only if the id actually
   changed, then `start()`.

Two things about this are easy to miss:

- `model(id)` ([model_server.rs:178](../src-tauri/src/model_server.rs)) resolves
  an unknown id to `MODELS[0]` — whichever model is first — rather than failing.
- `select_model` is not the only entry point. Changing `modelId` through
  `update_settings` reselects too ([lib.rs:211](../src-tauri/src/lib.rs)).

At launch the stored model is selected eagerly
([lib.rs:695](../src-tauri/src/lib.rs)) so the first dictation is not the thing
that waits for it.

## Three mechanisms

`Engine` says which model it is; `Runtime` says how it is reached. They are
deliberately separate types ([model_server.rs:86](../src-tauri/src/model_server.rs)):

> Kept apart from `Engine` so adding an engine cannot quietly land in the wrong
> branch: this used to be `Option<&WorkerSpec>`, where `None` silently meant
> Parakeet.

`runtime(engine)` is the whole routing table, and the same four-way match then
appears in `runtime_installed`, `catalog`, `start` and `transcribe`.

| id | engine | runtime | weights |
| --- | --- | --- | --- |
| `whisper-cpp-small` | `WhisperCpp` | `InProcess` — linked in | `~/Library/Application Support/Waveform/whisper.cpp/ggml-small.bin` |
| `parakeet-tdt-0.6b-v3` | `Nemo` | `Http` — subprocess serving HTTP | `~/Library/Caches/NeMoSpeech/models/<remote_id>` |
| `qwen3-asr-0.6b` | `Qwen` | `Worker` — Python over NDJSON | `~/.cache/huggingface/hub/models--Qwen--Qwen3-ASR-0.6B/snapshots` |
| `whisper-small` | `Whisper` | `Worker` — Python over NDJSON | `~/.cache/whisper/small.pt` |

Note that the two Whisper entries are not interchangeable. whisper.cpp takes
GGML `.bin` weights and the Python package takes `.pt`; neither can read the
other's, so they download separately and both can be absent independently.

### Parakeet, over HTTP

`nemo-speech serve --asr-model <remote_id> --device metal` on `127.0.0.1:8178`
(`WAVEFORM_PORT` overrides the port). Readiness is a poll of `GET /ready` every
600 ms up to a 15-minute `START_TIMEOUT`. Transcription is a multipart POST of
the WAV to `/v1/audio/transcriptions`, reading `.text` back, with a 120-second
`TRANSCRIBE_TIMEOUT`. The `language` field is omitted rather than sent empty:
its absence is what asks for detection.

The binary is looked for as `NEMO_SPEECH_BIN`, then `~/.local/bin/nemo-speech`,
then along `PATH` — the explicit candidate matters more than `PATH` does,
because a bundle launched from Finder gets a minimal one.

### Qwen and Whisper, over one Python worker

One implementation serves both. They differ only by `WorkerSpec` — venv name,
the environment variable that overrides the interpreter, the script, and the
setup command ([model_server.rs:139](../src-tauri/src/model_server.rs)). Each
engine keeps its own virtual environment on purpose: they pin different torch
versions, and one failing to resolve should not take the other down.

The protocol is newline-delimited JSON. The worker prints `WAVEFORM:{json}`
lines of type `ready`, `result` or `error`; a reader task parses them and fans
results to a pending-job table keyed `"{venv}-{n}"`. The WAV is base64'd into
the request.

There is exactly one worker slot, which is why `WorkerState` records which
engine it is serving — "is a worker ready?" is not a useful question on its own,
since a Qwen worker left running would otherwise be handed Whisper's audio.
Switching engines kills the incumbent and fails its pending jobs with
"Speech model changed."

Decoding differs on the Python side. `whisper-worker.py` decodes the WAV with
`wave` and numpy and resamples with `scipy.signal.resample_poly` — deliberately
not `whisper.load_audio`, which shells out to ffmpeg — and validates itself
against 0.1 s of silence before reporting ready. `qwen-worker.py` re-encodes the
WAV as a `data:audio/wav;base64,` URL, so that audio is base64'd twice: once
into the JSON request, once into the data URL.

### whisper.cpp, in this process

No subprocess. `start_whisper_cpp` kills any Python worker still holding a
gigabyte of memory, then loads the `WhisperContext` on
`tokio::task::spawn_blocking` — the load is slow and holds a lock, and doing it
on the async runtime would stall the HUD's animation and the hotkey listener for
as long as it took. `transcribe_whisper_cpp` runs `decode_wav` and `transcribe`
on a blocking thread too.

Because it is in-process, `runtime_installed` is unconditionally true, there is
no readiness poll and no `START_TIMEOUT` race, and `engine_pid` is cleared —
there is no separate engine for the resource monitor to report on. `stop()`
drops the context, which for Whisper Small frees most a gigabyte of this
process's own memory.

## How audio reaches an engine

`getUserMedia` runs with automatic gain control on and echo cancellation and
noise suppression off — the latter two make macOS duck other apps' output — and
is tapped by a 2048-frame `ScriptProcessorNode` through a muted gain node
([capture.ts:54](../src/renderer/audio/capture.ts)).

Samples go into `SpeechSegmenter`, which returns a completed phrase at each
pause; `stop()` flushes the tail. Each phrase is WAV-encoded at the **hardware**
sample rate — usually 48 kHz, with no resampling in the renderer — into a fixed
44-byte-header mono PCM16 buffer ([wav.ts](../src/renderer/audio/wav.ts)). Every
engine resamples to 16 kHz itself, which is why there are three separate
resamplers in the tree.

The bytes cross as a JSON number array, because Tauri IPC is JSON
([tauri-bridge.ts:79](../src/renderer/tauri-bridge.ts)). `transcribe`
([lib.rs:324](../src-tauri/src/lib.rs)) reads the language from settings **per
phrase** rather than fixing it when the engine starts, so changing it takes
effect on the next phrase instead of after a reload.

`ModelServer::transcribe` takes `transcribe_lock` before anything else. The
renderer issues phrases concurrently; Rust serializes them, because every engine
is single-threaded and overlapping calls would only queue anyway.

## Status and events

`ModelStatus` — `{ id, label, selected, runtimeInstalled, weightsInstalled,
setupCommand }` — reports the runtime and the weights separately on purpose:
having a runtime is not the same as having a model, `setup:model` installs
nemo-speech and pulls Parakeet in two steps, and either can be done without the
other. Saying only "not ready" would not tell anyone what to do.

`ModelEvent` is `{ stage, message, modelId }`, with `ModelStage` declared as
`idle | starting | downloading | loading | ready | error`
([contracts.ts:5](../src/shared/contracts.ts)). `progress` is present only on
`downloading`. The renderer's handler drops events for any model that is not the
selected one, except downloads — those run for whichever row was pressed.

One inconsistency worth knowing: `ModelStatus.label` carries Rust's
`short_label`, so the Models page says "Parakeet 0.6B", while the Overview row
uses the TypeScript `label` and says "NVIDIA Parakeet TDT 0.6B v3". The same
model is named two ways in one app.

## How weights arrive

Two ways, and every model uses exactly one of them. `setup_command(definition)`
and `downloadable(definition)` are the pair that decides which, and
`every_model_says_exactly_one_way_to_get_its_weights` holds them to it — a model
in neither state would render as a row with nothing to say.

Detection is `weights_present()`
([model_server.rs:730](../src-tauri/src/model_server.rs)), one arm per `Weights`
variant. For the two cache-directory layouts, a directory that exists but is
empty counts as absent (`has_contents`) — that is a download that did not
finish.

### The app fetches them

Only `whisper-cpp-small`. `Weights::GgmlFile` carries a `Download` — file name,
URL, byte length and SHA-256 — because whisper.cpp is linked into the binary, so
a model there is nothing but one file. Every other engine needs an installer or
a virtual environment wrapped around its weights, which is not something to run
on a user's behalf.

`download_weights` refuses a second concurrent download, streams the body in
chunks with `Response::chunk()`, hashes as it writes, and writes to
`<file>.partial` — renaming into place only once the length and the hash both
match. A rename within one directory is atomic, so the file is either absent or
complete, and `weights_present` looks for the final name, so an interrupted
transfer reads as absent.

Progress rides on the `downloading` stage, throttled by `PROGRESS_INTERVAL` to
one event every 250 ms: an event per chunk would be tens of thousands of
messages across the IPC bridge for one file. `ModelEvent.progress` carries the
fraction. On success the stage is `idle`, not `ready` — downloaded is not
loaded, and the engine still waits for a first session.

The row is the button. A model whose weights the app can fetch is not
`aria-disabled`; pressing it starts the download and the row reports the
percentage in place, rather than the list rebuilding four times a second and
replacing the button under the pointer.

### A terminal fetches them

Everything else, with `catalog()` naming the command:

| runtime | setup command |
| --- | --- |
| `Http` | `pnpm setup:model` |
| `Worker` | `pnpm setup:qwen` / `pnpm setup:whisper` |

- `setup-model.sh` curls NVIDIA's `install.sh` for a pinned version, then
  `nemo-speech pull nvidia/parakeet-tdt-0.6b-v3`.
- `setup-qwen.sh` and `setup-whisper.sh` build separate virtual environments,
  pip install, and pre-fetch the weights — "rather than on the first phrase,
  which would otherwise stall behind a download with no way to say so".
- `setup-whisper-cpp.sh` still exists, and still works. It is how a checkout
  fetches other sizes through `WAVEFORM_WHISPER_CPP_MODEL`, and it documents the
  URL the Rust side hard-codes. The app no longer tells anyone to run it.

## Known gaps

### Parakeet and Qwen still need a checkout

`resources` in [tauri.conf.json](../src-tauri/tauri.conf.json) bundles
`waveform-hotkey`, `qwen-worker.py` and `whisper-worker.py`. It does not bundle
the `setup-*.sh` scripts, and it could not usefully do so: a user who installed
from the disk image has no checkout and no pnpm, so `pnpm setup:model` and
`pnpm setup:qwen` name commands that cannot exist on their machine.

That install can now reach a working model — `whisper-cpp-small` downloads
itself — so this is no longer a dead end. It is a limit on choice rather than on
use. Closing it properly would mean running NVIDIA's installer and building a
2.5 GB virtual environment from inside the app, neither of which reduces to a
download.

### Nothing checks that the two registries agree

`SPEECH_MODELS` and `MODELS` are still hand-kept duplicates. The TypeScript side
now also carries `downloadBytes` through `ModelStatus`, which comes from the Rust
table — so a model added to one and not the other fails at runtime rather than
at build time.
