# Models: how one is chosen, and how it runs

Waveform ships sixteen speech models over three genuinely different execution
mechanisms. Fourteen of them are Whisper, because whisper.cpp is linked into the
binary and a Whisper model is therefore nothing but a weight file — so every
size and quantization of it costs one table entry and a download, while the
other two engines cost a Python runtime each.
[building.md](building.md) covers this from the outside — which `pnpm setup:*`
script installs what. This is the inside: how a model id becomes a running
engine, where each engine's weights are looked for, how the interface decides
what to recommend, and which parts of that story are still unfinished.

Line references drift. Treat them as a starting point, not a promise.

## Two registries, compared by a test

The catalogue exists twice. `SPEECH_MODELS` in
[src/shared/models.ts](../src/shared/models.ts) is what the interface knows;
`MODELS` in [src-tauri/src/model_server.rs:196](../src-tauri/src/model_server.rs)
is what actually runs. The Rust table carries everything the TypeScript one has
no use for: an `Engine`, a `Weights` variant, a `Download`, a `Group`, a line of
`detail`, and the memory each model wants.

`holds the same ids, in the same order, as the Rust table`
([tests/model-registry.test.ts](../tests/model-registry.test.ts)) reads the ids
straight out of the Rust source and compares them, which is the one thing that
was missing while the list was three entries long and became untenable at
sixteen. Adding a model still means editing both files; forgetting one now fails
in `pnpm test` rather than at runtime, where `model()` would have resolved the
unknown id to the default and quietly loaded something else.

The Rust table is a macro at the Whisper entries. `whisper!` takes an id, a
label, a file name, a length, a hash, a group, a memory figure and a line of
detail, and fills in the engine, the URL and the `Weights` wrapper — because
spelling those out fourteen times is fourteen chances to put a hash against the
wrong file. `bytes` and `sha256` are Hugging Face's own figures: the file size
and the LFS object id, which is its SHA-256.

The default is named rather than positional. It used to be `MODELS[0]` and
`SPEECH_MODELS[0].id`, which worked while the first entry was the only
self-downloading model; now the table is ordered lightest-first for the models
page to read, and the lightest Whisper is Tiny. `DEFAULT_MODEL_ID` and
`DEFAULT_SPEECH_MODEL_ID` both say `whisper-cpp-large-v3-turbo-q5`, the setup
wizard's recommendation (`DEFAULT_LADDER_MODEL_ID`) and one of the two models it
fetches on a first run, so a skipped wizard lands on weights that are likely
already on the disk. It used to be `whisper-cpp-small`, which the wizard neither
offers nor fetches. A test keeps the two TypeScript ids equal.

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
| `whisper-cpp-*` (14 of them) | `WhisperCpp` | `InProcess` — linked in | `…/Waveform/models/whisper/<remote_id>` |
| `parakeet-tdt-0.6b-v3` | `Nemo` | `Http` — subprocess serving HTTP | `…/Waveform/models/parakeet/<remote_id>` |
| `qwen3-asr-0.6b` | `Qwen` | `Worker` — Python over NDJSON | `…/Waveform/models/qwen/hub/models--Qwen--Qwen3-ASR-0.6B/` |

For a Whisper entry `remote_id` is the GGML file's own name, which is all that
engine needs, so it appears as both the weight path and the thing loaded.

Not every file in the whisper.cpp repository is listed. `large-v1` and
`large-v2` are superseded by `large-v3` at the same size; the `q8_0`
quantizations save little over the full weights; and quantized English-only
weights combine two compromises on a model already small enough to need
neither. `scripts/setup-whisper-cpp.sh` still fetches any of them into a
checkout by name — `WAVEFORM_WHISPER_CPP_MODEL=large-v2-q5_0`, say — but only
what the table names can be chosen in the app.

There used to be a fourth entry: OpenAI's own `openai-whisper` package, running
the same Whisper `small` as a Python worker. It was removed. GGML `.bin` and
`.pt` weights are not interchangeable, so it downloaded its own ~490 MB on top
of a 2.5 GB virtual environment, reloaded them per worker restart, and fell back
to the CPU whenever Metal was missing an operation — to be slower at the same
model the app already has linked in.

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

### Qwen, over a Python worker

Written for more than one of its kind, and Qwen is the only one left: a
`WorkerSpec` ([model_server.rs:139](../src-tauri/src/model_server.rs)) says which
virtual environment, which interpreter override, which script and which setup
command, and OpenAI's Whisper package was the other. The plumbing is kept as it
is rather than folded into Qwen, because the reason for the split still holds —
two Python engines would pin different torch versions, and one failing to
resolve should not take the other down.

The protocol is newline-delimited JSON. The worker prints `WAVEFORM:{json}`
lines of type `ready`, `result` or `error`; a reader task parses them and fans
results to a pending-job table keyed `"{venv}-{n}"`. The WAV is base64'd into
the request.

There is exactly one worker slot, and `WorkerState` still records which engine
it is serving. With one worker engine left that check cannot currently fail, but
it is the thing that stopped a worker from being handed the wrong engine's
audio, and it costs nothing to keep.

`qwen-worker.py` re-encodes the WAV as a `data:audio/wav;base64,` URL, so that
audio is base64'd twice: once into the JSON request, once into the data URL.

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
drops the context, which for Whisper Small frees most of a gigabyte of this
process's own memory.

## How audio reaches an engine

`getUserMedia` asks for a plain input — no echo cancellation, no automatic
gain, no noise suppression. Asking for echo cancellation is what starts
WebKit's voice-processing unit, which took about a second to open the
microphone and made macOS duck other apps. Gain is applied on the samples
instead ([gain.ts](../src/renderer/audio/gain.ts)). The stream is tapped by an
AudioWorklet (a 2048-frame `ScriptProcessorNode` if that is missing) through a
muted gain node ([capture.ts](../src/renderer/audio/capture.ts)).

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

`ModelStatus` — `{ id, label, group, detail, selected, runtimeInstalled,
weightsInstalled, setupCommand, downloadBytes, memoryMb, fit }` —
reports the runtime and the weights separately on purpose: having a runtime is
not the same as having a model. Download installs both for Parakeet and Qwen;
`setupCommand` is empty for every catalogue row because the app does the work.

`ModelEvent` is `{ stage, message, modelId }`, with `ModelStage` declared as
`idle | starting | downloading | loading | ready | error`
([contracts.ts:5](../src/shared/contracts.ts)). `progress` is present only on
`downloading`. The renderer's handler drops events for any model that is not the
selected one, except downloads — those run for whichever row was pressed.

There used to be an inconsistency here: `ModelStatus.label` carries Rust's
`short_label`, so the Models page said "Parakeet 0.6B" while the Overview row
used a longer TypeScript `label` and said "NVIDIA Parakeet TDT 0.6B v3" — one
model named two ways in one app. The long field is gone. TypeScript now carries
one `label` per model, matching `short_label`, which is also fourteen fewer
strings to keep in step.

## Memory fit

`ModelStatus` carries two fields the interface does not compute for itself:
`memoryMb` and `fit`.

`memory_mb` is an estimate on each table row — the weight file plus the working
state around it — not a measurement. It exists to be compared against what the
Mac has, and to order the models by weight, so being a couple of hundred
megabytes out does not change what it is used for.

`installed_memory_mb()` shells out to `sysctl -n hw.memsize` once and keeps the
answer in a `OnceLock`: it cannot change while the app runs, and it is asked for
once per row. `fit()` then grades the model against it in thirds rather than
yes-or-no, because the interesting answer is usually neither:

| `Fit` | Model wants | Means |
| --- | --- | --- |
| `Comfortable` | ≤ ⅛ of memory | Leave it loaded and forget it |
| `Tight` | ≤ ¼ | It runs; it is also the largest thing on the machine |
| `TooLarge` | more than ¼ | Everything else starts moving towards swap |

Fractions rather than fixed sizes, because the question is not whether the model
loads — macOS will find the pages either way, by swapping something else out —
but whether leaving it resident between phrases is something the rest of the
machine notices.

`fit` is graded against installed memory, so a row can say comfortable, tight,
or too large. When `sysctl` cannot be read, `fit` is `None`.

Parakeet leads the catalogue (`parakeet_leads_the_catalogue` pins that). The
page used to mark it with a Recommended badge; list order is what remains.

`Group` decides which heading a row is listed under — `Whisper`, `Whisper,
English only`, or none. Parakeet and Qwen sit at the top unnamed: a heading
there used to say "Other engines", which made them sound like leftovers. The
renderer builds its groups from the order the catalogue arrives in, so the
interface holds no second opinion about which groups exist. Each heading gets
its own `role="radiogroup"`, so arrow keys move within a group instead of
sweeping from Parakeet through fourteen Whisper sizes.

`renderModels` lists all sixteen. It used to open folded, showing only the
first model, the one in use, anything downloaded and anything the app
could not fetch, with the rest behind a **Show every size** button — which meant
the page opened having already decided the question it exists to ask. What makes
the full list readable instead is that a row is four facts on one line: `wer`,
the download size, the memory, and an arrow beside the name carrying `card_url`
through `openUrl`.

The row is a `div`, not a button. The press target is a `.model-pick` layer
absolutely positioned over the whole row; everything visible sits above it with
`pointer-events: none`, so a click anywhere lands on the row, and the arrow
takes its own back with `pointer-events: auto`. A link inside a button is not
something a browser will render, which is what forced the split. The wrapper is
`role="presentation"` so the radio group still sees radios as its children.

What that press does depends on `weightsInstalled`, and the row says which:
a model that is here is filled, carries an `In use` tag when selected, and its
press target is a `role="radio"`; one the app can fetch carries a **Download**
button of its own — pressing the row itself does not start the transfer — and
while that runs the button becomes **Cancel**. Calling an undownloaded row a
radio was the interface saying a thing that is not true: you cannot select what
you do not have. The two engines the app cannot fetch get `terminal` and the
command instead. `data-state` on the row (`here`, `download`, `busy`,
`terminal`) is what the stylesheet reads for all of it.

`wer` is word error rate on LibriSpeech test-clean, in percent, as published on
each model's own Hugging Face page. One benchmark down the whole column rather
than the best figure each project quotes — it is read audiobook speech, so it
flatters everything here in the same direction, and what it is good for is
ordering. A quantized build uses the figure from the model it is a quantization
of: nobody publishes a separate LibriSpeech number for the q5 file, and the
card that row already links is the parent model's.

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

### The app installs them

Every catalogue row has a Download button. Whisper is still one checked GGML
file via `download::fetch`. Parakeet and Qwen run multi-step installers in
[`install.rs`](../src-tauri/src/install.rs) (nemo-speech + pull; venv + pip +
HF snapshot), writing under `Application Support/Waveform/models/` and
`runtimes/`. `only_the_ggml_weights_download_themselves` still means only Whisper
uses the single-file `Download` struct; `every_model_installs_from_the_app`
requires every row to expose `downloadBytes` and an empty `setupCommand`.

`every_download_describes_the_file_it_names` checks each Whisper row against the
URL prefix, its own `remote_id`, and the hashes of the other thirteen.

`download_weights` refuses a second concurrent install and dispatches by weight
kind. Whisper streams through `download::fetch` as before. Parakeet/Qwen report
coarse progress messages on the `downloading` stage and honour Cancel by
killing the child process.

Developer scripts (`pnpm setup:model`, `setup:qwen`, `setup:whisper-cpp`) write
to the same directories so a checkout and the app stay congruent. Qwen still
needs system Python 3.

The Download control is its own button on the row (not the row press), so a
press never starts a multi-gigabyte transfer by accident.

## The other catalogue: local polish models

[local_llm.rs](../src-tauri/src/local_llm.rs) holds a second, much smaller table
— three Qwen3 builds, mirrored in
[src/shared/polish-models.ts](../src/shared/polish-models.ts) and compared by
[tests/polish-model-registry.test.ts](../tests/polish-model-registry.test.ts) in
the same way, for the same reason. They are rewriting models rather than speech
ones, run through llama.cpp linked in beside whisper.cpp, and reached from
the AI Polish section rather than the models page.

The parts they share with the speech catalogue are the download (`Download`,
checked by length and SHA-256, moved into place only when both match), the
progress events (`ModelEvent`, on `polish-model-event` rather than `model-event`),
the `Fit` figures, and the row that is a download button until the weights are
here and a radio afterwards. The parts they do not share: there is no runtime to
install, so no `setup_command`; no word error rate, because none of these
transcribe anything; and their weights live in
`~/Library/Application Support/Waveform/llm`, apart from Whisper's.

Each URL names the commit it was checked against rather than `main`. A file on a
branch is whatever the repository holds today, and the recorded hash is not.

Everything else about them — which is to say, the prompt, the fence, and the
check that the reply is a rewrite of what went in — is
[rewrite.rs](../src-tauri/src/rewrite.rs), shared with OpenRouter. The engine
setting decides which of the two answers; nothing else in the path differs.

## Known gaps

### Qwen needs system Python 3

Parakeet and Qwen install from the Models page like Whisper. Qwen’s runtime is
still a venv created with the Mac’s `python3` — Waveform does not bundle
CPython. If Python is missing, Download fails with a clear error pointing at
python.org (or Xcode CLT).

### The memory figures are estimates

`memory_mb` is a hand-written number per row, and everything the interface says
about fit rests on it. It is close enough to order the models and to tell an
8 GB Mac apart from a 32 GB one, which is all it is used for, but nothing
measures it: a model whose real resident size drifted from its table entry would
be graded against the wrong figure and nothing would notice. Measuring it
properly means loading each model and reading the process back, which is 12 GB
of downloads to answer a question a rounded estimate already answers.

### Quality is not described anywhere

The `detail` line on each row is prose about relative accuracy, written from
what Whisper's own model card and the whisper.cpp benchmarks say. There is no
word-error-rate figure in the table and no test on a fixed sample, so "hears
accents Small guesses at" is a claim the code cannot check. A recorded sample
and a transcript to diff against would turn every one of those lines into
something falsifiable.
