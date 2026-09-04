#!/bin/sh
set -eu

runtime="$HOME/.local/bin/nemo-speech"
runtime_version="0.1.0"

if [ ! -x "$runtime" ]; then
  installer="$(mktemp "${TMPDIR:-/tmp}/nemo-speech-install.XXXXXX")"
  trap 'rm -f "$installer"' EXIT HUP INT TERM
  curl -fsSL \
    "https://raw.githubusercontent.com/NVIDIA/NeMo-Speech.cpp/v${runtime_version}/scripts/install.sh" \
    -o "$installer"
  sh "$installer" --version "$runtime_version" --backend metal --no-modify-path
fi

"$runtime" doctor
"$runtime" pull nvidia/parakeet-tdt-0.6b-v3

printf '\nReady. Run: npm run dev\n'

