#!/bin/sh
# Downloads GGML weights for the in-process whisper.cpp engine.
#
# No virtual environment and no interpreter: whisper.cpp is linked into the
# app, so a model is nothing but its weight file. Building the app does need
# cmake, which Cargo's build script uses to compile whisper.cpp itself.
set -eu

dir="${WAVEFORM_WHISPER_CPP_DIR:-$HOME/Library/Application Support/Waveform/whisper.cpp}"
model="${WAVEFORM_WHISPER_CPP_MODEL:-small}"
file="ggml-$model.bin"
url="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$file"

if [ -f "$dir/$file" ]; then
  printf 'Already downloaded: %s\n' "$dir/$file"
  exit 0
fi

mkdir -p "$dir"
# Downloaded beside the target and moved into place, so an interrupted
# download cannot leave a truncated file that looks installed.
printf 'Downloading %s…\n' "$file"
curl -fL --progress-bar -o "$dir/$file.partial" "$url"
mv "$dir/$file.partial" "$dir/$file"

printf '\nWhisper (%s, whisper.cpp) ready. Run: pnpm start\n' "$model"
