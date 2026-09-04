#!/bin/sh
set -eu

runtime_dir="${WAVEFORM_RUNTIME_DIR:-$HOME/Library/Application Support/Waveform}"
venv="$runtime_dir/qwen"
python="${QWEN_SETUP_PYTHON:-python3}"

if [ ! -x "$venv/bin/python3" ]; then
  mkdir -p "$runtime_dir"
  "$python" -m venv "$venv"
fi

"$venv/bin/python3" -m pip install --upgrade pip
"$venv/bin/python3" -m pip install "torch>=2.6" "qwen-asr==0.0.6"
"$venv/bin/python3" -c 'from huggingface_hub import snapshot_download; snapshot_download("Qwen/Qwen3-ASR-0.6B")'

printf '\nQwen3-ASR ready. Run: pnpm start\n'
