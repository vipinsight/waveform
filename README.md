# Waveform

Waveform is a small macOS app for private, local voice transcription. Choose between:

- [`nvidia/parakeet-tdt-0.6b-v3`](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)
- [`Qwen/Qwen3-ASR-0.6B`](https://huggingface.co/Qwen/Qwen3-ASR-0.6B)

Hold a key anywhere in macOS, speak, and the text lands in whatever you were
typing into. Audio stays on this Mac.

## Requirements

- Apple Silicon Mac
- macOS 13 or newer
- Rust and Cargo
- Xcode Command Line Tools, for the native hotkey helper (`xcode-select --install`)
- Node.js 20 or newer
- Python 3.9 or newer for Qwen3-ASR
- Internet access for initial runtime and model downloads

## Setup

```bash
pnpm install
pnpm setup:model
pnpm setup:qwen
pnpm app
```

`setup:model` installs NVIDIA's `nemo-speech` Metal runtime and Parakeet model.
`setup:qwen` creates an isolated runtime in `~/Library/Application Support/Waveform/qwen`,
installs Qwen's official `qwen-asr` runtime, and downloads Qwen3-ASR 0.6B. Model
weights remain in local Hugging Face and NeMo caches.

Grant microphone permission when macOS asks.

## Build and run

```bash
pnpm app            # build and launch
pnpm package:mac    # same, optimised release build
```

Both quit any running copy, rebuild, assemble `release/Waveform.app` and open
it. The bundle is put together by hand rather than by the Tauri CLI, which is
not just convenience: WKWebView refuses microphone access to a bare binary, so
the executable has to sit inside a real `.app` carrying
`NSMicrophoneUsageDescription`. Installing the CLI (`cargo install tauri-cli`)
gets you `cargo tauri build` and dmg packaging when you want to distribute it.

macOS ties Accessibility and Input Monitoring to the code signature. The default
ad-hoc signature is a hash of the bundle, so every rebuild looks like a new app
and both permissions need granting again. Sign with a stable certificate to
avoid that:

```bash
security find-identity -v -p codesigning
WAVEFORM_SIGN_IDENTITY="Apple Development: Your Name (TEAMID)" pnpm app
```

## Dictate anywhere

Waveform watches a single modifier key across the whole system. Put the cursor in
any text field — Mail, a browser, a terminal — and:

| Gesture | What happens |
| --- | --- |
| Hold the key, speak, release | Transcribes what you said and pastes it |
| Double-tap the key | Keeps listening until you press the key again |
| Press the key again while locked | Stops listening and transcribes the last phrase |
| `esc` | Cancels: the unfinished phrase is dropped, and an in-flight polish is abandoned |

A small monochrome indicator appears while it listens, so you always know the
microphone is open. It never takes focus from the app you are typing into, and
you can **drag it anywhere on screen** — the position is remembered. Settings has
**Show** to make it appear on demand and **Reset** to put it back.

The default trigger is **Fn**. Open **Settings** (gear icon) to pick a different
one — Right/Left ⌘, ⌥, ⌃ or Right ⇧ — or to turn insertion off and keep the text
in the app window only.

### Permissions

Both live under **Settings → Shortcut**. macOS gates each half, and neither can
be granted programmatically:

- **Input Monitoring** — lets Waveform see the trigger key while other apps are
  focused.
- **Accessibility** — lets Waveform paste into the focused app.

Settings shows both and links straight to the right System Settings pane.

macOS ties these to the app's code signature, which is why a grant can appear
ticked in System Settings while the app is still refused: an ad-hoc signature
changes on every rebuild, so each build is a different app as far as the
permission system is concerned. `pnpm app` therefore signs with the first
code-signing certificate it finds, which keeps the identity stable. If the
permissions were first granted to an ad-hoc build, remove Waveform from both
lists and add it again once.

If you use **Fn**, also set **System Settings → Keyboard → Press 🌐 to** to
**Do Nothing**, otherwise tapping it switches input source at the same time.

Because the app is ad-hoc signed, macOS treats each rebuild as a new binary and
you will need to re-grant these permissions after `pnpm package:mac`.

## AI Polish (OpenRouter)

Transcription always runs on this Mac. Optionally, text can be rewritten by a
model through [OpenRouter](https://openrouter.ai) — that step, and only that
step, sends text off the machine.

Open **Settings → AI Polish** and paste an OpenRouter API key. It is encrypted
with `safeStorage` into your login keychain, written to `secrets.json` as
ciphertext with `0600` permissions, and never handed back to the interface.

Two independent features use it:

| Feature | What it does |
| --- | --- |
| **Clean up dictation** | Every dictated phrase is rewritten before it is inserted. Removes filler and fixes grammar, at the cost of a round trip per phrase. |
| **Polish shortcut** (`⌥1`) | Rewrites whatever text is selected in the focused app, in place. |

Both are driven by system prompts you can edit, with **Reset** to restore the
defaults. Pick any OpenRouter model id; the field suggests a few fast ones.

Polishing has to copy the selection to read it, since no API exposes another
app's selection — so it needs **Accessibility**, and it only ever runs when you
press the shortcut. Your clipboard is restored afterwards.

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

## How it is put together

The window layer — interface, audio capture, segmentation, the overlay meter —
runs in a WebKit webview and talks to a Rust host through the `window.waveform`
surface in `src/renderer/host.ts`. `getUserMedia`, `AudioContext` and
`ScriptProcessorNode` all work there, so audio never has to cross into Rust;
only finished WAV segments do.

Rust owns everything the page cannot do for itself: the speech engines, the
dictation state machine, the overlay window, the global shortcuts, the
OpenRouter calls and the keychain.

One thing is neither: `src/native/HotkeyHelper.swift`. No API lets an app see Fn
pressed while another app is frontmost, or type into one — that needs a
`CGEventTap` and synthetic `CGEvent`s. It is a separate process speaking
newline-delimited JSON over stdio, which is why it survived the move from
Electron untouched.

## Commands

```bash
pnpm app         # build and launch
pnpm test        # all tests, TypeScript and Rust
pnpm test:ui     # TypeScript only
pnpm test:rust   # Rust only
pnpm typecheck   # check TypeScript
pnpm build       # build the frontend and the native helper into dist/
pnpm setup:qwen  # install and download Qwen3-ASR 0.6B
pnpm icon        # regenerate the app icon and .icns
```

`pnpm build` also compiles `src/native/HotkeyHelper.swift` into
`dist/native/waveform-hotkey`. Without a Swift toolchain the build still
succeeds and the app runs, with the global shortcut disabled.

Override runtime paths when needed:

`open` does not forward the environment, so run the executable inside the
bundle directly when you need to override a path:

```bash
NEMO_SPEECH_BIN=/path/to/nemo-speech \
QWEN_ASR_PYTHON=/path/to/python3 \
WAVEFORM_PORT=8178 \
release/Waveform.app/Contents/MacOS/Waveform
```
