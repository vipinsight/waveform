#!/bin/sh
set -eu

# Same layout the app uses: weights under models/, runtime under runtimes/.
runtime_dir="${WAVEFORM_RUNTIME_DIR:-$HOME/Library/Application Support/Waveform}"
venv="${WAVEFORM_QWEN_VENV:-$runtime_dir/runtimes/qwen}"
hf_home="${HF_HOME:-$runtime_dir/models/qwen}"
python="${QWEN_SETUP_PYTHON:-python3}"

if [ ! -x "$venv/bin/python3" ]; then
  mkdir -p "$(dirname "$venv")"
  "$python" -m venv "$venv"
fi

"$venv/bin/python3" -m pip install --upgrade pip
"$venv/bin/python3" -m pip install "torch>=2.6" "qwen-asr==0.0.6"
mkdir -p "$hf_home"
HF_HOME="$hf_home" "$venv/bin/python3" -c \
  'from huggingface_hub import snapshot_download; snapshot_download("Qwen/Qwen3-ASR-0.6B")'

printf '\nQwen3-ASR ready under\n  runtime: %s\n  weights: %s\nRun: pnpm app\n' "$venv" "$hf_home"
