#!/bin/sh
# Builds a signed, notarised disk image that launches on macOS 14, for handing
# to somebody directly. It is not a release: nothing is uploaded, and the
# updater archive is not produced. See docs/macos-14-build.md.
#
# Everything is built for macOS 11.0, not the 13.0 in tauri.conf.json. Homebrew
# rustc 1.92 links proc-macros for 12.0 or later in a form macOS 27's dyld will
# not load, and 11.0 still weak-links the macOS 15 Metal classes ggml uses.
# A target directory of its own keeps objects built for any other target out.
#
# Usage: scripts/build-macos14-dmg.sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

fail() {
  echo "build-macos14-dmg: $1" >&2
  exit 1
}

if [ -f .env.notarization ]; then
  set -a
  . ./.env.notarization
  set +a
fi
[ -n "${APPLE_ID:-}" ] || fail "APPLE_ID is not set; notarisation would be skipped"
[ -n "${APPLE_PASSWORD:-}" ] || fail "APPLE_PASSWORD is not set"
[ -n "${APPLE_TEAM_ID:-}" ] || fail "APPLE_TEAM_ID is not set"
[ -n "${APPLE_SIGNING_IDENTITY:-}" ] || fail "APPLE_SIGNING_IDENTITY is not set"
command -v cmake >/dev/null 2>&1 || fail "cmake is not on PATH (brew install cmake)"

export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/src-tauri/target/macos11}"
# A cached helper skips build-helper.mjs, and with it the Developer ID signing.
rm -f dist/native/waveform-hotkey

pnpm exec tauri build --features dist --bundles dmg \
  --config '{"bundle":{"macOS":{"minimumSystemVersion":"11.0"}}}'

# The fix itself: the class the macOS 14 crash named must be a weak import.
BIN="$CARGO_TARGET_DIR/release/bundle/macos/Waveform.app/Contents/MacOS/waveform"
nm -um "$BIN" | grep -q 'weak external _OBJC_CLASS_$_MTLResidencySetDescriptor' \
  || fail "MTLResidencySetDescriptor is linked strongly; the app would crash on macOS 14"

DMG="$(ls -t "$CARGO_TARGET_DIR"/release/bundle/dmg/Waveform_*.dmg | head -1)"
scripts/finish-dmg.sh "$DMG"

ls "$CARGO_TARGET_DIR"/release/bundle/dmg/Waveform-*-arm64.dmg
