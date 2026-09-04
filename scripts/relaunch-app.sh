#!/usr/bin/env bash
# Quits any running Waveform and opens the freshly packaged bundle, so what is
# on screen always matches what was just built.
set -euo pipefail

APP_DIR="release/Waveform-darwin-arm64/Waveform.app"

osascript -e 'quit app "Waveform"' 2>/dev/null || true
# Give the old instance a moment to release the microphone and the event tap.
for _ in $(seq 1 20); do
  pgrep -f "Waveform.app/Contents/MacOS/Waveform" >/dev/null || break
  sleep 0.2
done
pkill -f "Waveform.app/Contents/MacOS/Waveform" 2>/dev/null || true

open "$APP_DIR"
echo "Launched $APP_DIR"
