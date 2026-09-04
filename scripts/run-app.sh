#!/usr/bin/env bash
# Rebuilds, repackages and relaunches Waveform.
#
# Order matters. electron-packager replaces the whole .app directory, so any
# instance still running has its executable deleted underneath it. macOS then
# keeps the dying process's Dock tile, and `open` activates that instance
# instead of launching the new bundle -- which looks like the icon appearing
# and then vanishing, while the window you are left with is the stale one.
# Quitting first avoids all of that.
set -euo pipefail

APP_DIR="release/Waveform-darwin-arm64/Waveform.app"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

quit_waveform() {
  osascript -e 'quit app "Waveform"' 2>/dev/null || true
  for _ in $(seq 1 25); do
    pgrep -f "Waveform.app/Contents/MacOS/Waveform" >/dev/null || return 0
    sleep 0.2
  done
  pkill -f "Waveform.app/Contents/MacOS/Waveform" 2>/dev/null || true
  sleep 0.5
}

quit_waveform
pnpm package:mac

# LaunchServices caches the bundle it saw before, including its icon. Without
# this the Dock can show a stale or missing icon for the replaced bundle.
[ -x "$LSREGISTER" ] && "$LSREGISTER" -f "$APP_DIR" || true

open "$APP_DIR"
echo "Launched $APP_DIR"
