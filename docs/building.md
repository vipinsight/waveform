# Building

`README.md` covers Waveform from the outside. This is the checkout.

## Toolchain

- Apple Silicon Mac, macOS 13 or newer
- Rust and Cargo
- CMake, which Cargo uses to build whisper.cpp (`brew install cmake`)
- Xcode Command Line Tools, for the native hotkey helper (`xcode-select --install`)
- Node.js 22 LTS and pnpm 9.4.0 (pinned in `package.json`)
- Python 3 for version/release scripts; optional Qwen setup has its own runtime requirements
- An Apple developer team of your own — see [Signing](#signing)

## Running it

```bash
pnpm install --frozen-lockfile
WAVEFORM_SIGN_TEAM=YOURTEAMID pnpm app
```

`pnpm app` quits any running copy, rebuilds, assembles `release/Waveform.app`
and opens it. It is a release build by default; set `WAVEFORM_PROFILE=debug`
for a faster Rust iteration.

The bundle is put together by hand rather than by the Tauri CLI, and not just
for convenience: WKWebView refuses microphone access to a bare binary, so the
executable has to sit inside a real `.app` carrying `NSMicrophoneUsageDescription`.
The Tauri CLI is already a development dependency: `pnpm exec tauri build`
provides normal app/DMG bundling for distribution.

Nothing but this is needed to dictate. whisper.cpp is the default engine and the
only one already inside the app, so its weights are the one missing piece, and
**Settings → Models** downloads them itself — no terminal, which is what an
install from the disk image has to work with.

## Signing

macOS ties Accessibility and Input Monitoring to the code signature. An ad-hoc
signature is a hash of the bundle, so every rebuild looks like a new app and
both permissions need granting again. `pnpm app` therefore signs with a real
certificate.

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

whisper.cpp needs no setup. The other two do:

```bash
pnpm setup:model        # Parakeet
pnpm setup:qwen         # Qwen3-ASR
pnpm setup:whisper-cpp  # the same weights the app fetches, for a checkout
```

`setup:model` installs NVIDIA's `nemo-speech` Metal runtime and the Parakeet
model. `setup:qwen` creates an isolated runtime in
`~/Library/Application Support/Waveform/qwen`, installs Qwen's official
`qwen-asr` runtime, and downloads Qwen3-ASR 0.6B. `setup:whisper-cpp` downloads
GGML weights to `~/Library/Application Support/Waveform/whisper.cpp` and
installs nothing else.

Install only the engines you intend to use. Model weights stay in local Hugging
Face and NeMo caches. [models.md](models.md) traces how a model id becomes a
running engine and where each one's weights are looked for.

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
release/Waveform.app/Contents/MacOS/Waveform
```

## Releasing

Follow [Releasing](releasing.md) for version PRs, signing prerequisites, draft
review, publication, and recovery. [Updates](updates.md) explains the two
signatures and the installed app's update behavior.
