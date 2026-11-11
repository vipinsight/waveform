#!/usr/bin/env bash
# Builds and launches the Tauri host.
#
# The local development loop assembles a signed .app so WKWebView can grant
# microphone access. The installed Tauri CLI handles distribution bundles;
# see scripts/release.sh and docs/releasing.md.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# The checkout build is the installed app: same bundle, same identifier, same
# Application Support/Waveform. There is no separate dev copy any more -- two
# apps meant two histories, two sets of weights and two sets of permissions.
APP="${WAVEFORM_APP:-/Applications/Waveform.app}"
BUNDLE_ID="com.webtiara.waveform"
VERSION="$(node -p "require('$ROOT/package.json').version")"
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
# TCC also checks the bundle against the released app's designated
# requirement, which names a Developer ID certificate. So the Developer ID
# identity for the team is preferred: a build signed with it replaces the
# released bundle in place and keeps its Accessibility, Input Monitoring and
# microphone grants. An Apple Development certificate still works, but macOS
# then treats the app as a new client and asks for the grants again.
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
      *"OU=$TEAM"*)
        case "$name" in
          "Developer ID Application:"*) IDENTITY="$name"; break ;;
          *) IDENTITY="${IDENTITY:-$name}" ;;
        esac
        ;;
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
# Other worktrees' build output, once they go a week without a build.
"$ROOT/scripts/clean-builds.sh" --quiet || true

pnpm build

cd src-tauri
# cargo-pruned.sh deletes whatever this build did not use: cargo itself never
# removes old artifacts, and target/ used to grow by gigabytes a week.
if [ "$PROFILE" = "release" ]; then
  "$ROOT/scripts/cargo-pruned.sh" build --release
else
  "$ROOT/scripts/cargo-pruned.sh" build
fi
cd "$ROOT"

# Every running Waveform has to go, not just the bundle about to be replaced:
# the installed app, and any Waveform Dev left over from an older checkout.
#
# A `pnpm dev` Electron instance from before the Tauri port stayed alive for
# 21 hours, holding its own CGEventTap and writing to the same
# ~/Library/Application Support/Waveform/history.json. One Fn press reached
# both apps, and the stale one saved its own in-memory list over the other's
# ten dictations.
#
# Ask each to quit the way a user would, then wait until it is actually gone.
# SIGTERM/SIGKILL of a Cocoa app is what produces "Waveform quit
# unexpectedly" on the next launch -- which is what happened when this
# followed the Apple Event with pkill, then SIGKILL three seconds later
# while the engine was still shutting down.
app_still_running() {
  pgrep -f "Waveform( Dev)?\.app/Contents/(MacOS/[Ww]aveform|Resources/waveform-)" >/dev/null 2>&1
}

wait_for_app_exit() {
  local tenths="$1"
  local n=0
  while app_still_running; do
    n=$((n + 1))
    if [ "$n" -ge "$tenths" ]; then
      return 1
    fi
    sleep 0.1
  done
  return 0
}

if app_still_running; then
  for id in "$BUNDLE_ID" "$BUNDLE_ID.dev"; do
    osascript >/dev/null 2>&1 <<EOF || true
if application id "$id" is running then
  with timeout of 8 seconds
    tell application id "$id" to quit
  end timeout
end if
EOF
  done
  wait_for_app_exit 80 || true
fi

if app_still_running; then
  echo "run-tauri: Waveform did not quit; quit it from the menu bar and run again." >&2
  exit 1
fi

# A previous rebuild that SIGKILL'd the app leaves a crash report, and the
# next `open` is what shows "Waveform quit unexpectedly". Those reports are
# not from a real crash.
find "$HOME/Library/Logs/DiagnosticReports" -maxdepth 2 \
  \( -name 'Waveform*' -o -name 'waveform*' \) -delete 2>/dev/null || true

# Leftovers from earlier stacks, not the app above.
pkill -f "$ROOT/dist/src/main/waveform-hotkey" 2>/dev/null || true
pkill -f "$ROOT/node_modules/.*electron/cli.js" 2>/dev/null || true

# Anything else answering to the name is a second writer for the same history
# file, so say so rather than launch beside it.
strays=$(pgrep -fl "[Ww]aveform" | grep -v -e "$$" -e "run-tauri" -e pgrep || true)
if [ -n "$strays" ]; then
  echo "warning: other Waveform processes are still running:" >&2
  echo "$strays" >&2
fi

# Earlier builds put a second bundle in the checkout. Leaving one behind means
# a second registered app, which is how a stale icon or an old binary gets
# launched by accident.
rm -rf "$ROOT/release/Waveform-tauri" "$ROOT/release/Waveform-darwin-arm64"
rm -rf "$ROOT/release/Waveform.app" "$ROOT/release/Waveform Dev.app" "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "src-tauri/target/$PROFILE/waveform" "$APP/Contents/MacOS/waveform"
cp icons/waveform.icns "$APP/Contents/Resources/icon.icns"

# The Swift hotkey helper is a sibling process, not a library. It must live
# inside the bundle so macOS attributes its event tap and synthetic keystrokes
# to Waveform rather than to whatever launched it.
if [ -x dist/native/waveform-hotkey ]; then
  cp dist/native/waveform-hotkey "$APP/Contents/Resources/waveform-hotkey"
fi
# The system-audio tap for meetings, a sibling process for the same reason.
if [ -x dist/native/waveform-audiotap ]; then
  cp dist/native/waveform-audiotap "$APP/Contents/Resources/waveform-audiotap"
fi

# The Qwen engine is a Python script, not a library. Bundling it keeps the app
# independent of the checkout it was built from.
cp scripts/qwen-worker.py "$APP/Contents/Resources/qwen-worker.py"

# The real version, so the update check compares like with like rather than
# offering the release this build already is.
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>waveform</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleName</key><string>Waveform</string>
  <key>CFBundleDisplayName</key><string>Waveform</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>Waveform uses your microphone to transcribe speech locally.</string>
  <key>NSAudioCaptureUsageDescription</key><string>Waveform records what this Mac plays during a meeting, so the other participants are in the transcript. Nothing leaves this Mac.</string>
</dict></plist>
PLIST

# Hardened runtime and the microphone entitlement, as the released bundle has:
# its designated requirement is what keeps the permission grants.
codesign --force --deep --options runtime \
  --entitlements src-tauri/entitlements.plist --sign "$IDENTITY" "$APP"

echo "Signed as: $IDENTITY"

# `open` deliberately does not forward the environment. To pass overrides such
# as NEMO_SPEECH_BIN, run the executable inside the bundle directly instead.
open "$APP"
echo "Launched $APP"
