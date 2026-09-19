#!/usr/bin/env bash
# Builds and launches the Tauri host.
#
# The local development loop assembles a signed .app so WKWebView can grant
# microphone access. The installed Tauri CLI handles distribution bundles;
# see scripts/release.sh and docs/releasing.md.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/release/Waveform Dev.app"
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
#
# The identifier is not the released app's. TCC also keys those grants by
# bundle id, so a checkout build that shared `com.webtiara.waveform` with the
# copy in /Applications stole that copy's grants on every launch -- and giving
# them back meant removing the released app from the list first. `.dev` is a
# separate client. Settings and model weights still live under Application
# Support/Waveform; that path is the app name, not this id.
#
# Several certificates can be installed at once -- one per Apple developer team
# -- and the first one `security` happens to list is not necessarily the right
# one. Waveform is a personal app, so it is signed with the personal team. The
# team is what gets pinned rather than the certificate name: the name carries a
# per-certificate suffix that changes when the certificate is renewed, while the
# team stays put, and so does the identity macOS grants permissions to.
# Waveform's stable TCC identity. Override only for an intentional signing-team
# migration; changing it makes macOS treat the rebuilt app as a new client.
TEAM="${WAVEFORM_SIGN_TEAM:-H6892VVKC5}"
IDENTITY="${WAVEFORM_SIGN_IDENTITY:-}"
if [ -z "$IDENTITY" ]; then
  while read -r hash name; do
    [ -n "$hash" ] || continue
    subject="$(security find-certificate -c "$name" -p 2>/dev/null \
      | openssl x509 -noout -subject 2>/dev/null)"
    case "$subject" in
      *"OU=$TEAM"*) IDENTITY="$name"; break ;;
    esac
  done <<< "$(security find-identity -v -p codesigning 2>/dev/null \
    | sed -n 's/^ *[0-9]*) \([0-9A-F]*\) "\(.*\)"$/\1 \2/p')"
fi
if [ -z "$IDENTITY" ]; then
  echo "No code-signing identity found for team $TEAM." >&2
  echo "Unlock or install the Apple Development certificate for $TEAM before running pnpm app." >&2
  exit 1
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
#
# Ask it to quit the way a user would, then wait until it is actually gone.
# SIGTERM/SIGKILL of a Cocoa app is what produces "Waveform Dev quit
# unexpectedly" on the next launch -- which is what happened when this
# followed the Apple Event with pkill, then SIGKILL three seconds later
# while the engine was still shutting down.
dev_still_running() {
  pgrep -f "$APP/Contents/MacOS/Waveform" >/dev/null 2>&1 \
    || pgrep -f "$APP/Contents/Resources/waveform-hotkey" >/dev/null 2>&1
}

wait_for_dev_exit() {
  local tenths="$1"
  local n=0
  while dev_still_running; do
    n=$((n + 1))
    if [ "$n" -ge "$tenths" ]; then
      return 1
    fi
    sleep 0.1
  done
  return 0
}

if dev_still_running; then
  osascript >/dev/null 2>&1 <<'EOF' || true
if application id "com.webtiara.waveform.dev" is running then
  with timeout of 8 seconds
    tell application id "com.webtiara.waveform.dev" to quit
  end timeout
end if
EOF
  wait_for_dev_exit 80 || true
fi

if dev_still_running; then
  echo "run-tauri: Waveform Dev did not quit; quit it from the menu bar and run again." >&2
  exit 1
fi

# A previous rebuild that SIGKILL'd the app leaves a crash report, and the
# next `open` is what shows "Waveform Dev quit unexpectedly". Those reports
# are not from a real crash.
find "$HOME/Library/Logs/DiagnosticReports" -maxdepth 2 \
  \( -name 'Waveform Dev*' -o -name 'Waveform-Dev*' \) -delete 2>/dev/null || true

# Leftovers from earlier stacks, not the checkout app above.
pkill -f "$ROOT/dist/src/main/waveform-hotkey" 2>/dev/null || true
pkill -f "$ROOT/node_modules/.*electron/cli.js" 2>/dev/null || true

# Anything else answering to the name is a second writer for the same history
# file, so say so rather than launch beside it.
strays=$(pgrep -fl "[Ww]aveform" | grep -v -e "$$" -e "run-tauri" -e pgrep || true)
if [ -n "$strays" ]; then
  echo "warning: other Waveform processes are still running:" >&2
  echo "$strays" >&2
fi

# Earlier builds used other output directories. Leaving those behind means a
# second registered bundle for the same app, which is how a stale icon or an
# old binary gets launched by accident.
rm -rf "$ROOT/release/Waveform-tauri" "$ROOT/release/Waveform-darwin-arm64"
rm -rf "$ROOT/release/Waveform.app" "$APP"
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
  <key>CFBundleIdentifier</key><string>com.webtiara.waveform.dev</string>
  <key>CFBundleName</key><string>Waveform Dev</string>
  <key>CFBundleDisplayName</key><string>Waveform Dev</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.3.0</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSMicrophoneUsageDescription</key><string>Waveform uses your microphone to transcribe speech locally.</string>
</dict></plist>
PLIST

codesign --force --deep --sign "$IDENTITY" "$APP"

echo "Signed as: $IDENTITY"

# `open` deliberately does not forward the environment. To pass overrides such
# as NEMO_SPEECH_BIN, run the executable inside the bundle directly instead.
open "$APP"
echo "Launched $APP"
