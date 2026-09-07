#!/bin/sh
# Installs OpenAI Whisper into its own virtual environment.
#
# Separate from the Qwen environment on purpose: the two pin different torch
# versions, and one dependency resolution failing should not take the other
# engine down with it.
set -eu

runtime_dir="${WAVEFORM_RUNTIME_DIR:-$HOME/Library/Application Support/Waveform}"
venv="$runtime_dir/whisper"
python="${WHISPER_SETUP_PYTHON:-python3}"
model="${WAVEFORM_WHISPER_MODEL:-small}"

if [ ! -x "$venv/bin/python3" ]; then
  mkdir -p "$runtime_dir"
  "$python" -m venv "$venv"
fi

"$venv/bin/python3" -m pip install --upgrade pip
# scipy is for resampling: the microphone runs at 48kHz and Whisper wants 16.
"$venv/bin/python3" -m pip install "openai-whisper" "scipy"
# Fetch the weights now rather than on the first phrase, which would otherwise
# stall behind a download with no way to say so.
"$venv/bin/python3" -c "import whisper; whisper.load_model('$model')"

printf '\nWhisper (%s) ready. Run: pnpm start\n' "$model"
