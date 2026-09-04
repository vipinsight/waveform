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
APP="$ROOT/release/Waveform-tauri/Waveform.app"
PROFILE="${WAVEFORM_PROFILE:-debug}"

cd "$ROOT"
pnpm build

cd src-tauri
if [ "$PROFILE" = "release" ]; then cargo build --release; else cargo build; fi
cd "$ROOT"

osascript -e 'quit app "Waveform"' 2>/dev/null || true
pkill -f "Waveform-tauri/Waveform.app" 2>/dev/null || true
sleep 0.4

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "src-tauri/target/$PROFILE/waveform" "$APP/Contents/MacOS/Waveform"
cp icons/waveform.icns "$APP/Contents/Resources/icon.icns"

# The Swift hotkey helper is a sibling process, not a library. It must live
# inside the bundle so macOS attributes its event tap and synthetic keystrokes
# to Waveform rather than to whatever launched it.
if [ -x dist/src/main/waveform-hotkey ]; then
  cp dist/src/main/waveform-hotkey "$APP/Contents/Resources/waveform-hotkey"
fi

# A distinct bundle id while the port is in progress: macOS ties microphone and
# accessibility grants to the identity, and sharing one with the Electron build
# would make it unclear which app a permission belongs to.
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>Waveform</string>
  <key>CFBundleIdentifier</key><string>com.webtiara.waveform.tauri</string>
  <key>CFBundleName</key><string>Waveform</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.2.0</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSMicrophoneUsageDescription</key><string>Waveform uses your microphone to transcribe speech locally.</string>
</dict></plist>
PLIST

codesign --force --deep --sign "${WAVEFORM_SIGN_IDENTITY:--}" "$APP"

# scripts/ and the model runtimes live beside the repo, not inside the bundle.
WAVEFORM_PROJECT_ROOT="$ROOT" open "$APP"
echo "Launched $APP"
