# Waveform

Waveform is a small macOS app for private, local voice transcription. Choose between:

- [`nvidia/parakeet-tdt-0.6b-v3`](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)
- [`Qwen/Qwen3-ASR-0.6B`](https://huggingface.co/Qwen/Qwen3-ASR-0.6B)

Press one button, speak, pause, see text. Audio stays on this Mac.

## Requirements

- Apple Silicon Mac
- macOS 13 or newer
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
`setup:qwen` creates an isolated `.venv-qwen`, installs Qwen's official
`qwen-asr` runtime, and downloads Qwen3-ASR 0.6B. Model weights remain in local
Hugging Face and NeMo caches.

Grant microphone permission when macOS asks.

## Use

1. Choose a model from the **Model** dropdown.
2. Wait for the selected model to become ready.
3. Press **Start listening**.
4. Speak naturally and pause briefly to transcribe.
5. Press **Stop listening** when done.

The selected model is remembered and loaded automatically next time. Audio is
segmented at short pauses and transcribed locally while the model stays loaded.

## Commands

```bash
bun start       # build and open app
pnpm typecheck  # check TypeScript
pnpm test       # run unit tests
pnpm build      # build into dist/
pnpm setup:qwen # install and download Qwen3-ASR 0.6B
```

Override runtime paths when needed:

```bash
NEMO_SPEECH_BIN=/path/to/nemo-speech \
QWEN_ASR_PYTHON=/path/to/python3 \
WAVEFORM_PORT=8178 \
bun start
```
