# Building

`README.md` covers Waveform from the outside. This is the checkout.

## Toolchain

- Apple Silicon Mac, macOS 13 or newer
- Rust and Cargo
- CMake, which Cargo uses to build whisper.cpp and llama.cpp (`brew install cmake`)
- Xcode Command Line Tools, for the native hotkey helper (`xcode-select --install`)
- Node.js 22 LTS and pnpm 9.4.0 (pinned in `package.json`)
- Python 3 for version/release scripts; optional Qwen setup has its own runtime requirements
- An Apple developer team of your own — see [Signing](#signing)

## Running it

```bash
pnpm install --frozen-lockfile
WAVEFORM_SIGN_TEAM=YOURTEAMID pnpm app
```

`pnpm app` quits any running checkout copy, rebuilds, assembles
`release/Waveform Dev.app` and opens it. It is a release build by default; set
`WAVEFORM_PROFILE=debug` for a faster Rust iteration.

That bundle is **Waveform Dev** (`com.webtiara.waveform.dev`), not the released
app: a different name and identifier so the two can keep their own Accessibility,
Input Monitoring and microphone grants.

The bundle is put together by hand rather than by the Tauri CLI, and not just
for convenience: WKWebView refuses microphone access to a bare binary, so the
executable has to sit inside a real `.app` carrying `NSMicrophoneUsageDescription`.
The Tauri CLI is already a development dependency: `pnpm exec tauri build`
provides normal app/DMG bundling for distribution.

Anything actually published goes through `scripts/release.sh` rather than that
command directly. It builds with the `dist` feature and with path-remapping
flags set, which together keep the build machine's absolute paths -- and so the
builder's username -- out of the shipped binary. A disk image built any other
way carries them; check with
`strings Waveform.app/Contents/MacOS/waveform | grep /Users/` before handing it
to anyone.

Nothing but this is needed to dictate. whisper.cpp is the default engine and the
only one already inside the app, so its weights are the one missing piece, and
The **Models** section downloads them itself — no terminal, which is what an
install from the disk image has to work with.

## Signing

macOS ties Accessibility and Input Monitoring to the code signature. An ad-hoc
signature is a hash of the bundle, so every rebuild looks like a new app and
both permissions need granting again. `pnpm app` therefore signs with a real
certificate.

It also uses a different bundle identifier (`com.webtiara.waveform.dev`) from
the released app. TCC keys those grants by identifier as well as signature, so
a checkout build that shared `com.webtiara.waveform` with the copy in
`/Applications` stole that copy's grants on every launch — and giving them
back meant removing the released app from Accessibility and Input Monitoring
first. The two appear as **Waveform** and **Waveform Dev** in System Settings.
Settings, history and model weights still live under
`~/Library/Application Support/Waveform`; that path is the app name, not the
bundle id.

The team is pinned rather than the certificate name. The name carries a
per-certificate suffix that changes when the certificate is renewed, while the
team stays put — and so does the identity macOS grants permissions to.

```bash
security find-identity -v -p codesigning
WAVEFORM_SIGN_TEAM=TEAMID pnpm app
WAVEFORM_SIGN_IDENTITY="Apple Development: Your Name (XXXXXXXXXX)" pnpm app
```

The default team is this project's, which you will not have a certificate for.
The build then stops with an error naming the team rather than falling back to
an ad-hoc signature, because a silent fallback is what quietly resets both
permissions on every rebuild.

If the permissions were first granted to an ad-hoc build, remove Waveform from
both lists in System Settings and add it again once.

## The optional engines

Every speech model installs from the Models page Download button — Whisper as a
single weight file, Parakeet via NVIDIA’s `nemo-speech`, Qwen via a Python venv
plus Hugging Face weights. Developers can still run the same steps from a
checkout:

```bash
pnpm setup:model        # Parakeet (same as in-app install)
pnpm setup:qwen         # Qwen3-ASR (needs system Python 3)
pnpm setup:whisper-cpp  # Whisper weights for a checkout
```

Everything lands under Application Support:

| What | Path |
| --- | --- |
| Whisper weights | `~/Library/Application Support/Waveform/models/whisper/` |
| Parakeet weights | `~/Library/Application Support/Waveform/models/parakeet/` |
| Qwen weights | `~/Library/Application Support/Waveform/models/qwen/` |
| Qwen venv | `~/Library/Application Support/Waveform/runtimes/qwen/` |
| nemo-speech binary | `~/Library/Application Support/Waveform/runtimes/bin/nemo-speech` |

Qwen’s install needs a system `python3` (Xcode CLT or python.org). Older
installs may still have weights in `whisper.cpp/`, NeMo’s platform cache, or
`~/.cache/huggingface` — the app reads those too. [models.md](models.md) traces
how a model id becomes a running engine.

OpenAI's own `openai-whisper` package used to be a fourth entry, running the
same Whisper `small`. It wanted a 2.5 GB virtual environment to be slower at it,
so it was removed. If you installed it, the environment it left behind is
`~/Library/Application Support/Waveform/whisper` and nothing needs it now.

## Commands

```bash
pnpm app         # build and launch
pnpm test        # TypeScript, Rust, and release-script tests
pnpm test:ui     # TypeScript only
pnpm test:rust   # Rust only
pnpm test:release # release script tests with mocked tools
pnpm typecheck   # check TypeScript
pnpm build       # build the frontend and the native helper into dist/
pnpm icon        # regenerate the app icon and .icns
pnpm release     # build, sign, notarise and upload a release draft
```

`pnpm build` also compiles `src/native/HotkeyHelper.swift` into
`dist/native/waveform-hotkey`. Without a Swift toolchain the build still
succeeds and the app runs, with the global shortcut disabled.

## Overriding runtime paths

`open` does not forward the environment, so run the executable inside the bundle
directly when you need to override a path:

```bash
NEMO_SPEECH_BIN=/path/to/nemo-speech \
QWEN_ASR_PYTHON=/path/to/python3 \
WAVEFORM_PORT=8178 \
release/"Waveform Dev.app"/Contents/MacOS/Waveform
```

## Releasing

Follow [Releasing](releasing.md) for version PRs, signing prerequisites, draft
review, publication, and recovery. [Updates](updates.md) explains the two
signatures and the installed app's update behavior.
