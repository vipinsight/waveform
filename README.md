# Waveform

Waveform is a small macOS app for private, local voice transcription. Choose between:

- [`nvidia/parakeet-tdt-0.6b-v3`](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)
- [`Qwen/Qwen3-ASR-0.6B`](https://huggingface.co/Qwen/Qwen3-ASR-0.6B)

Hold a key anywhere in macOS, speak, and the text lands in whatever you were
typing into. Audio stays on this Mac.

## Requirements

- Apple Silicon Mac
- macOS 13 or newer
- Xcode Command Line Tools, for the native hotkey helper (`xcode-select --install`)
- Node.js 20 or newer
- Python 3.9 or newer for Qwen3-ASR
- Internet access for initial runtime and model downloads

## Setup

```bash
pnpm install
pnpm setup:model
pnpm setup:qwen
bun start
```

`setup:model` installs NVIDIA's `nemo-speech` Metal runtime and Parakeet model.
`setup:qwen` creates an isolated runtime in `~/Library/Application Support/Waveform/qwen`,
installs Qwen's official `qwen-asr` runtime, and downloads Qwen3-ASR 0.6B. Model
weights remain in local Hugging Face and NeMo caches.

Grant microphone permission when macOS asks.

## macOS app bundle

Build a native macOS app with bundle ID `com.webtiara.waveform`:

```bash
pnpm package:mac
open release/Waveform-darwin-arm64/Waveform.app
```

Use this packaged app for microphone permission. `pnpm dev` runs Electron's
development bundle, so macOS identifies it as `com.github.Electron` instead.
After upgrading, run `pnpm setup:qwen` once to install Qwen runtime for Waveform.

### Running your latest code

The bundle in `release/` is a snapshot: `package:mac` copies `dist/` into it, so
edits to `src/` do not reach the running app until you package again. One
command rebuilds, repackages and relaunches:

```bash
pnpm app
```

It quits any running copy **before** repackaging. Packaging over a running
bundle deletes the executable underneath it, which leaves a dead Dock tile and
makes `open` re-activate the dying instance instead of the new build.

Use `pnpm start` for quick UI work — it runs straight from `dist/` — but the
global shortcut will not work there, because macOS grants Input Monitoring and
Accessibility to `com.github.Electron` rather than to Waveform.

To check whether the running bundle matches your build:

```bash
shasum -a256 dist/src/main/main.js release/Waveform-darwin-arm64/Waveform.app/Contents/Resources/app/dist/src/main/main.js
```

### Keeping permissions across rebuilds

macOS keys Accessibility and Input Monitoring to the app's code signature. The
default ad-hoc signature is a hash of the bundle's contents, so every rebuild
looks like a different app and both permissions have to be granted again.
Signing with a stable certificate avoids that:

```bash
security find-identity -v -p codesigning
WAVEFORM_SIGN_IDENTITY="Apple Development: Your Name (TEAMID)" pnpm app
```

Grant the permissions once to that signed build and they survive later
rebuilds. Export the variable in your shell profile to make it the default.

## Dictate anywhere

Waveform watches a single modifier key across the whole system. Put the cursor in
any text field — Mail, a browser, a terminal — and:

| Gesture | What happens |
| --- | --- |
| Hold the key, speak, release | Transcribes what you said and pastes it |
| Double-tap the key | Keeps listening until you press the key again |
| `esc` while listening | Cancels; nothing is pasted |

A small monochrome indicator appears while it listens, so you always know the
microphone is open. It never takes focus from the app you are typing into, and
you can **drag it anywhere on screen** — the position is remembered. Settings has
**Show** to make it appear on demand and **Reset** to put it back.

The default trigger is **Fn**. Open **Settings** (gear icon) to pick a different
one — Right/Left ⌘, ⌥, ⌃ or Right ⇧ — or to turn insertion off and keep the text
in the app window only.

### Permissions

macOS gates both halves of this, and neither can be granted programmatically:

- **Input Monitoring** — lets Waveform see the trigger key while other apps are
  focused.
- **Accessibility** — lets Waveform paste into the focused app.

The Settings panel shows both and links straight to the right System Settings
pane. Grant them, then restart Waveform.

If you use **Fn**, also set **System Settings → Keyboard → Press 🌐 to** to
**Do Nothing**, otherwise tapping it switches input source at the same time.

Because the app is ad-hoc signed, macOS treats each rebuild as a new binary and
you will need to re-grant these permissions after `pnpm package:mac`.

The status bar shows live CPU and memory for Waveform and the speech engine
combined, since the engine is the larger consumer of both.

## Use in the app window

1. Choose a model from **Settings → Model**.
2. Wait for it to become ready.
3. Press **Start listening**, or just use the shortcut.
4. Speak naturally and pause briefly to transcribe.

Qwen3-ASR takes roughly 20-40 seconds to load on first start, and the button
reads **Loading model** until it is ready. Parakeet is quicker once its runtime
is warm.

The selected model is remembered and loaded at launch. Audio is segmented at
short pauses and transcribed locally while the model stays loaded.

## Commands

```bash
bun start       # build and open app
pnpm typecheck  # check TypeScript
pnpm test       # run unit tests
pnpm build      # build into dist/
pnpm setup:qwen # install and download Qwen3-ASR 0.6B
pnpm icon       # regenerate the app icon and .icns
```

The build also compiles `src/native/HotkeyHelper.swift` into
`dist/src/main/waveform-hotkey`. Without a Swift toolchain the build still
succeeds and the app runs, with the global shortcut disabled.

Override runtime paths when needed:

```bash
NEMO_SPEECH_BIN=/path/to/nemo-speech \
QWEN_ASR_PYTHON=/path/to/python3 \
WAVEFORM_PORT=8178 \
bun start
```
