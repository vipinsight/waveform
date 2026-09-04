# Parakeet Flow

Small macOS desktop app for local voice transcription with
[`nvidia/parakeet-tdt-0.6b-v3`](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3).

Press one button, speak, pause, see text. Audio stays on this Mac.

## Requirements

- Apple Silicon Mac
- macOS 13 or newer
- Node.js 20 or newer
- Internet access for initial runtime and model download
- About 1 GB free disk space

## Setup

```bash
pnpm install
pnpm setup:model
pnpm dev
```

First setup installs NVIDIA's official `nemo-speech` Metal runtime under
`~/Library/Application Support/NeMoSpeech`, then downloads the quantized model
to `~/Library/Caches/NeMoSpeech/models`. The model download is about 714 MB.

Grant microphone permission when macOS asks.

## Use

1. Press **Load model & start**.
2. Speak naturally.
3. Pause briefly. Finished phrases appear in the transcript.
4. Press **Stop listening** when done.

Parakeet TDT 0.6B v3 is an offline-only recognizer. This app approximates live
dictation by detecting short pauses and transcribing each phrase independently
while keeping the model loaded.

## Commands

```bash
pnpm dev        # build and open app
pnpm typecheck  # check TypeScript
pnpm test       # run unit tests
pnpm build      # build into dist/
```

Override runtime path or local server port when needed:

```bash
NEMO_SPEECH_BIN=/path/to/nemo-speech PARAKEET_FLOW_PORT=8178 pnpm dev
```

