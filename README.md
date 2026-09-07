# Waveform

Waveform is a small macOS app for private, local voice transcription. Choose between:

- [whisper.cpp](https://github.com/ggml-org/whisper.cpp) running Whisper
  `small`, linked into the app. The default.
- [`nvidia/parakeet-tdt-0.6b-v3`](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)
- [`Qwen/Qwen3-ASR-0.6B`](https://huggingface.co/Qwen/Qwen3-ASR-0.6B)
- [OpenAI Whisper](https://github.com/openai/whisper) `small`, through its own
  Python package

Hold a key anywhere in macOS, speak, and the text lands in whatever you were
typing into. Audio stays on this Mac.

## Requirements

- Apple Silicon Mac
- macOS 13 or newer
- Rust and Cargo
- CMake, which Cargo uses to build whisper.cpp (`brew install cmake`)
- Xcode Command Line Tools, for the native hotkey helper (`xcode-select --install`)
- Node.js 20 or newer
- Python 3.9 or newer for Qwen3-ASR and Whisper
- Internet access for initial runtime and model downloads

## Setup

```bash
pnpm install
pnpm app
```

Nothing else is needed to dictate. whisper.cpp is the default engine and the
only one already inside the app, so its weights are the only missing piece, and
**Settings -> Model** downloads them itself -- no terminal, which is what an
install from the disk image has to work with. The optional engines still need a
checkout:

```bash
pnpm setup:model        # optional: Parakeet
pnpm setup:qwen         # optional: Qwen3-ASR
pnpm setup:whisper      # optional: Whisper through Python
pnpm setup:whisper-cpp  # the same weights the app fetches, for a checkout
```

`setup:model` installs NVIDIA's `nemo-speech` Metal runtime and Parakeet model.
`setup:qwen` creates an isolated runtime in `~/Library/Application Support/Waveform/qwen`,
installs Qwen's official `qwen-asr` runtime, and downloads Qwen3-ASR 0.6B.
`setup:whisper` does the same for OpenAI's own `openai-whisper` package under
`~/Library/Application Support/Waveform/whisper`, and downloads the `small`
weights. Each engine keeps its own environment, because they pin different
torch versions and one failing to resolve should not take the others with it.
`setup:whisper-cpp` downloads GGML weights to
`~/Library/Application Support/Waveform/whisper.cpp` and installs nothing else:
whisper.cpp is linked into the app, so that engine has no interpreter, no
virtual environment and no separate process. It is the same Whisper model as
the Python entry -- about 490MB of weights against that engine's 2.5GB
environment -- and keeps its weights loaded between phrases. On an M1 Pro it
transcribes eleven seconds of speech in under half a second.
Model weights remain in local Hugging Face, NeMo and Whisper caches.

Install only the engines you intend to use. The Models page says what each one
is missing: a Download button where the app can fetch the weights, and the
command to run where it cannot.

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
and both permissions need granting again. `pnpm app` therefore signs with a real
certificate: the one belonging to the personal developer team `H6892VVKC5`. To
sign as a different team, or with one named certificate:

```bash
security find-identity -v -p codesigning
WAVEFORM_SIGN_TEAM=TEAMID pnpm app
WAVEFORM_SIGN_IDENTITY="Apple Development: Your Name (XXXXXXXXXX)" pnpm app
```

Pinning the team rather than the certificate survives renewal — the name in
parentheses is the certificate, not the team, and it changes when the
certificate is reissued.

## Dictate anywhere

Waveform watches a single modifier key across the whole system. Put the cursor in
any text field — Mail, a browser, a terminal — and:

| Gesture | What happens |
| --- | --- |
| Hold the key, speak, release | Transcribes what you said and pastes it |
| Double-tap the key | Keeps listening until you press the key again |
| Press the key again while locked | Stops listening and inserts what was said |
| `esc` | Cancels: the unfinished phrase is dropped, and an in-flight polish is abandoned |

Text arrives when you stop speaking, not while you are still going: nothing is
inserted until you release the key, so a sentence never lands half-written in
whatever you happened to click on. Long pauses still split the audio internally,
which is what keeps transcription accurate, but the pieces are joined and
delivered together.

The indicator carries cancel on the left and polish on the right, so a dictation
can be abandoned or rewritten without reaching for the keyboard. Pressing polish
rewrites that dictation even when **Clean up dictation** is switched off; while
it runs, the meter becomes a progress row and the button becomes a loader ring.
Polish is only offered when an OpenRouter key is saved.

A small monochrome indicator appears while it listens, so you always know the
microphone is open. It never takes focus from the app you are typing into, and
you can **drag it anywhere on screen** — the position is remembered. Settings has
**Show** to make it appear on demand and **Reset** to put it back.

The default trigger is **Fn**. Open **Settings → Shortcut** to pick a different
one — Right/Left ⌘, ⌥, ⌃ or Right ⇧. Finished dictation is automatically inserted
at the cursor in the focused app.

### Permissions

**Settings → Setup** lists everything dictation depends on, with its live state
and a button that opens the right pane. The list updates while you are still in
System Settings, so you do not have to restart to see a grant take effect. macOS gates each half, and neither can
be granted programmatically:

- **Input Monitoring** — lets Waveform see the trigger key while other apps are
  focused.
- **Accessibility** — lets Waveform paste into the focused app.

macOS ties these to the app's code signature, which is why a grant can appear
ticked in System Settings while the app is still refused: an ad-hoc signature
changes on every rebuild, so each build is a different app as far as the
permission system is concerned. `pnpm app` therefore signs with a real
certificate, which keeps the identity stable. If the
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

## Living in the menu bar

With **Start with login** enabled, Waveform starts in the background after you
log in, including after a restart. Its main window stays hidden; dictation
shortcuts remain available. Open it from the Dock or menu bar when needed.
Launching Waveform manually opens the main window.

Closing the window does not quit Waveform: the shortcut keeps working with
nothing on screen, and the Dock icon or the menu bar icon brings the window
back. **Settings → General** can drop the app out of the Dock entirely while
the window is closed, leaving only the menu bar icon.

The speech model is not loaded until your first dictation. It is the largest
thing the app runs, so an idle Waveform costs about 140 MB rather than several
hundred.

The status bar shows live CPU and memory for Waveform and the speech engine
combined, since the engine is the larger consumer of both.

## Updates

Waveform checks for a new version twenty seconds after launch, and once a day
after that. **Settings -> General** has the switch and a **Check now** button;
an update downloads with progress and restarts the app into itself.

The check is the only request Waveform makes that you did not ask for, so it can
be turned off -- **Check now** still works with it off. Everything else that
leaves this Mac happens because something was pressed.

Releases are cut with `pnpm release`, which builds, signs, notarises and
publishes both the disk image and what the updater needs. See `docs/updates.md`
for the two signatures involved and why losing the update key is unrecoverable.

## The Dictation list

Every dictation is kept, newest first, with when it was said and how long it
was. Each one can be copied or deleted, and the whole list cleared.

The list is the only thing Waveform writes down. It lives in
`~/Library/Application Support/Waveform/history.json`, readable only by you,
capped at the most recent 300 entries. Audio is never written to disk at all.

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

Pick the window up by the sidebar or by a view's heading. Buttons, inputs and
the transcript keep their own behaviour.

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

The speech engines are the least obvious part of this. `docs/models.md`
traces how a model id becomes a running engine and where each one's weights are
looked for. `docs/updates.md` covers how a release reaches an installed copy.

## Commands

```bash
pnpm app         # build and launch
pnpm test        # all tests, TypeScript and Rust
pnpm test:ui     # TypeScript only
pnpm test:rust   # Rust only
pnpm typecheck   # check TypeScript
pnpm build       # build the frontend and the native helper into dist/
pnpm setup:qwen  # install and download Qwen3-ASR 0.6B
pnpm setup:whisper  # install and download OpenAI Whisper small
pnpm setup:whisper-cpp  # download GGML weights for the whisper.cpp engine
pnpm icon        # regenerate the app icon and .icns
pnpm release     # build, sign, notarise and publish a release
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
