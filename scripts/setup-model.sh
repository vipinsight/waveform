#!/bin/sh
set -eu

# Same layout the app uses: nemo-speech under runtimes/bin, models under models/parakeet.
runtime_dir="${WAVEFORM_RUNTIME_DIR:-$HOME/Library/Application Support/Waveform}"
bin_dir="$runtime_dir/runtimes/bin"
models="${NEMO_SPEECH_MODEL_DIR:-$runtime_dir/models/parakeet}"
runtime_version="0.1.0"
runtime="${NEMO_SPEECH_BIN:-$bin_dir/nemo-speech}"

mkdir -p "$bin_dir" "$models"

if [ ! -x "$runtime" ]; then
  if [ -x "$HOME/.local/bin/nemo-speech" ] && [ "$runtime" != "$HOME/.local/bin/nemo-speech" ]; then
    cp "$HOME/.local/bin/nemo-speech" "$runtime"
    chmod 755 "$runtime"
  else
    installer="$(mktemp "${TMPDIR:-/tmp}/nemo-speech-install.XXXXXX")"
    trap 'rm -f "$installer"' EXIT HUP INT TERM
    curl -fsSL \
      "https://raw.githubusercontent.com/NVIDIA/NeMo-Speech.cpp/v${runtime_version}/scripts/install.sh" \
      -o "$installer"
    # Prefer our prefix; fall back to the installer's default ~/.local/bin.
    if ! sh "$installer" --version "$runtime_version" --backend metal --no-modify-path \
        --prefix "$runtime_dir/runtimes"; then
      sh "$installer" --version "$runtime_version" --backend metal --no-modify-path
      if [ -x "$HOME/.local/bin/nemo-speech" ] && [ ! -x "$runtime" ]; then
        cp "$HOME/.local/bin/nemo-speech" "$runtime"
        chmod 755 "$runtime"
      fi
    fi
  fi
fi

if [ ! -x "$runtime" ]; then
  runtime="$HOME/.local/bin/nemo-speech"
fi

"$runtime" doctor
NEMO_SPEECH_MODEL_DIR="$models" "$runtime" pull nvidia/parakeet-tdt-0.6b-v3

printf '\nParakeet ready under\n  runtime: %s\n  weights: %s\nRun: pnpm app\n' "$runtime" "$models"
