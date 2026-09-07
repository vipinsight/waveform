# A Whisper that installs itself

Status: proposed, not started. Written 2026-09-07.

## Why

A user who installs Waveform from the disk image cannot install any model. The
Models page names a `pnpm setup:*` command, but they have no checkout, no pnpm,
and possibly no `python3`. Every path to working weights currently runs through
a shell script that only exists in the repository. See the "Known gaps" section
of [models.md](../models.md).

Three of the four models cannot reasonably be fixed: Parakeet needs NVIDIA's
installer, and each Python engine needs a virtual environment of roughly two and
a half gigabytes. Neither reduces to a download.

`whisper-cpp-small` does. whisper.cpp is linked into the binary, so
`runtime_installed` is already unconditionally true and the only missing piece is
one file. `scripts/setup-whisper-cpp.sh` is twenty lines: build a URL, `curl` to
`<file>.partial`, `mv` into place. All of that belongs in Rust, where it can
report progress and needs no terminal.

Outcome: a fresh install picks Whisper, watches a progress bar, and dictates.

## Decisions

**Download, do not build.** The alternative — bundling the GGML file into the
`.app` — would add most of half a gigabyte to every download, including for the
users who chose Parakeet. Fetch on demand.

**`downloading` becomes real.** The stage is declared in `ModelStage` and has
never been emitted. This is what it is for.

**Progress is a number, not prose.** `ModelEvent` is `{ stage, message, modelId }`.
Add `progress: Option<f32>` (0.0 to 1.0), serialized as an optional field so
every existing emit site is unaffected. Reuse the progress-row treatment the HUD
already has for AI Polish rather than inventing a second progress style.

**Downloads stay atomic, for the same reason the shell script does.** Stream to
`<name>.partial`, rename only on success. A rename within one directory is
atomic, so the file is either absent or complete. `weights_present` checks
`is_file()` on the final path, so a partial file already reads as absent — but
delete it on failure anyway, rather than leaving half a gigabyte behind.

**Verify what was downloaded.** The file is loaded and executed as model
weights. Check `Content-Length` against the bytes written, and check a pinned
SHA-256 before the rename. Obtain both by downloading the file once during
implementation; do not carry a number over from this document.

**Selecting a model does not start a download.** A half-gigabyte transfer should
be something the user pressed a button for. Keep `select_model` and
`download_model` separate.

## Changes

### `src-tauri/src/model_server.rs`

- `ModelEvent` gains `progress: Option<f32>`; `emit_stage` keeps its signature
  and a new `emit_progress` carries the fraction, so the five existing stages are
  untouched.
- `Weights::GgmlFile` currently carries only a file name. It needs the URL, the
  expected length and the hash. Keep them on the variant rather than on
  `ModelDefinition`, so nothing that cannot be downloaded grows an unused URL.
  The URL is `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/<file>`,
  as in the shell script.
- `ModelStatus` needs to distinguish "press Download" from "run this command".
  An explicit `downloadable: bool` reads better at the call site than an empty
  `setup_command`. `catalog()` sets it from the `Weights` variant, not from
  `Runtime` — it is a property of how the weights arrive, not of how the engine
  runs.
- A `download_weights` method: `reqwest` is already a dependency but needs its
  `stream` feature adding in [Cargo.toml:36](../../src-tauri/Cargo.toml) so the
  body can be consumed in chunks. Read `Content-Length`, write chunks to
  `<name>.partial`, hash as you write, verify, rename. Emit `downloading` with
  progress throttled to roughly every 250 ms or every percent — an event per
  chunk would flood the IPC bridge with tens of thousands of messages.
- On failure: delete the partial file, emit `error` with something a user can
  act on. A disk-full error and a 404 should not read the same.

### `src-tauri/src/whisper_cpp.rs`

`load()`'s error text names `pnpm setup:whisper-cpp`
([whisper_cpp.rs:38](../../src-tauri/src/whisper_cpp.rs)). It should say the
weights are missing and point at the Models page, which is true for both kinds of
user.

### `src-tauri/src/lib.rs`

- A `download_model(model_id)` command beside `select_model` and `model_catalog`
  ([lib.rs:300](../../src-tauri/src/lib.rs)), registered in the invoke handler.
  It returns as soon as the download starts and reports through `model-event`, so
  the webview is never blocked for ten minutes.
- Refuse a second concurrent download of the same model. Two writers at one
  `.partial` path would interleave and produce a file that fails its hash — which
  is caught, but wastes the whole transfer.

### TypeScript

- [contracts.ts](../../src/shared/contracts.ts): `ModelEvent.progress?: number`
  and `ModelStatus.downloadable: boolean`.
- [tauri-bridge.ts](../../src/renderer/tauri-bridge.ts) and `host.ts`: a
  `downloadModel` method mirroring `selectModel`.
- [renderer.ts](../../src/renderer/renderer.ts): `renderModels()` gains a third
  case beside its two "run `<command>`" hints — a Download button showing the
  size, so nobody starts a half-gigabyte transfer unknowingly. The delegated
  click handler at [renderer.ts:209](../../src/renderer/renderer.ts) returns
  early on `aria-disabled` rows, so the button needs its own branch ahead of
  that check.
- The `model-event` handler drops events whose `modelId` is not the selected
  model. A download can run for a model the user has not selected, so that
  filter has to widen or the progress will be silently discarded. This is the
  single most likely thing to be missed.
- The registry lists are hand-kept duplicates, so any field added to one table
  goes into the other in the same commit.

### Elsewhere

- `scripts/setup-whisper-cpp.sh` stays. It is still the right thing for a
  checkout, it documents the URL, and it is how `WAVEFORM_WHISPER_CPP_MODEL`
  fetches a size other than `small`.
- `README.md`: the Setup block currently implies a terminal is mandatory. Say
  that the whisper.cpp engine downloads itself from **Settings → Model** and
  that the `pnpm setup:*` scripts are for the other engines.
- `docs/models.md`: gaps one and two shrink to "Parakeet and Qwen still require
  a checkout"; gap three closes.

## Verification

1. `pnpm test`. `every_engine_model_survives_load` iterates `MODELS`, so it
   needs no edit. Add unit tests for the download in isolation: a correct body
   renames into place; a truncated body and a wrong hash each leave **no** file
   at the final path and `weights_present` still reports absent; a stray
   `.partial` alone reports absent.
2. `pnpm app` with `WAVEFORM_WHISPER_CPP_DIR` pointed at an empty directory to
   force the missing state. The row should offer Download with a size, advance,
   and turn Ready without a restart. `open` does not forward the environment, so
   run `release/Waveform.app/Contents/MacOS/Waveform` directly.
3. Dictate with it, then dictate the same phrase with `whisper-small`. Same
   model, different backend, so the transcripts should be close. A large
   divergence means `decode_wav`'s resampling is wrong for the rate the renderer
   actually captures at — usually 48 kHz, never resampled in the renderer.
4. Quit mid-download, relaunch: the row still reads not installed, and Download
   starts cleanly over the leftover partial file.
5. Pull the network cable mid-download and confirm the message says so.
6. The real test: `pnpm dmg`, install from the disk image on a Mac with no
   checkout and ideally no `python3` on `PATH`, and get from first launch to
   working dictation without opening a terminal.
