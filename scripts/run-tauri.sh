#!/usr/bin/env bash
# Builds and launches the Tauri host.
#
# The Tauri CLI is not a dependency of this repo, so the bundle is assembled by
# hand. That is not merely convenience: WKWebView will not grant microphone
# access to a bare binary, so the executable has to sit inside a real .app with
# NSMicrophoneUsageDescription before dictation can work at all.
#
# Installing the CLI (`cargo install tauri-cli`) gets you `cargo tauri build`
# with proper dmg packaging, which is the route to take once the port lands.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/release/Waveform.app"
# Release by default: this is the build actually used day to day, and the audio
# meter and spring animation are noticeably smoother optimised. An incremental
# release build takes about twenty seconds. WAVEFORM_PROFILE=debug is there for
# quicker Rust iteration.
#
# The Dock icon does not depend on this. That is decided by the custom-protocol
# feature in src-tauri/Cargo.toml.
PROFILE="${WAVEFORM_PROFILE:-release}"

# macOS ties Accessibility and Input Monitoring to the code signature. An ad-hoc
# signature is a hash of the bundle, so every rebuild is a different app as far
# as TCC is concerned -- while System Settings still shows the old entry ticked,
# which looks exactly like a granted permission that stopped working. Preferring
# a real certificate keeps the identity, and the grants, stable across rebuilds.
IDENTITY="${WAVEFORM_SIGN_IDENTITY:-}"
if [ -z "$IDENTITY" ]; then
  IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null \
    | awk -F'"' '/"/ { print $2; exit }')"
fi
if [ -z "$IDENTITY" ]; then
  IDENTITY="-"
fi

cd "$ROOT"
pnpm build

cd src-tauri
if [ "$PROFILE" = "release" ]; then cargo build --release; else cargo build; fi
cd "$ROOT"

# Every Waveform belonging to this checkout has to go, not just the bundle
# about to be replaced.
#
# A `pnpm dev` Electron instance from before the Tauri port stayed alive for
# 21 hours, holding its own CGEventTap and writing to the same
# ~/Library/Application Support/Waveform/history.json. One Fn press reached
# both apps, and the stale one saved its own in-memory list over the other's
# ten dictations. The pattern here used to name Waveform-tauri/Waveform.app,
# a path no build has produced for a while, so it matched nothing.
osascript -e 'quit app "Waveform"' 2>/dev/null || true
pkill -f "$ROOT/release/Waveform.app" 2>/dev/null || true
pkill -f "$ROOT/dist/src/main/waveform-hotkey" 2>/dev/null || true
pkill -f "$ROOT/node_modules/.*electron/cli.js" 2>/dev/null || true
sleep 0.6

# Anything left is a second writer for the same history file, so say so rather
# than launch beside it.
strays=$(pgrep -fl "[Ww]aveform" | grep -v -e "$$" -e "run-tauri" -e pgrep || true)
if [ -n "$strays" ]; then
  echo "warning: other Waveform processes are still running:" >&2
  echo "$strays" >&2
fi

# Earlier builds used other output directories. Leaving those behind means a
# second registered bundle for the same app, which is how a stale icon or an
# old binary gets launched by accident.
rm -rf "$ROOT/release/Waveform-tauri" "$ROOT/release/Waveform-darwin-arm64"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "src-tauri/target/$PROFILE/waveform" "$APP/Contents/MacOS/Waveform"
cp icons/waveform.icns "$APP/Contents/Resources/icon.icns"

# The Swift hotkey helper is a sibling process, not a library. It must live
# inside the bundle so macOS attributes its event tap and synthetic keystrokes
# to Waveform rather than to whatever launched it.
if [ -x dist/native/waveform-hotkey ]; then
  cp dist/native/waveform-hotkey "$APP/Contents/Resources/waveform-hotkey"
fi

# The Qwen engine is a Python script, not a library. Bundling it keeps the app
# independent of the checkout it was built from.
cp scripts/qwen-worker.py "$APP/Contents/Resources/qwen-worker.py"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>Waveform</string>
  <key>CFBundleIdentifier</key><string>com.webtiara.waveform</string>
  <key>CFBundleName</key><string>Waveform</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.2.0</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSMicrophoneUsageDescription</key><string>Waveform uses your microphone to transcribe speech locally.</string>
</dict></plist>
PLIST

codesign --force --deep --sign "$IDENTITY" "$APP"

if [ "$IDENTITY" = "-" ]; then
  echo
  echo "Signed ad-hoc: no code-signing certificate was found. macOS will revoke"
  echo "Accessibility and Input Monitoring on every rebuild."
else
  echo "Signed as: $IDENTITY"
fi

# `open` deliberately does not forward the environment. To pass overrides such
# as NEMO_SPEECH_BIN, run the executable inside the bundle directly instead.
open "$APP"
echo "Launched $APP"
