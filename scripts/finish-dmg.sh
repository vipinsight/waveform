#!/bin/sh
# Writes the disk image's window layout, which the bundler leaves unfinished.
#
# Tauri copies the background into .background/ and records the icon
# positions, but never records the picture itself. Asking Finder to do it
# fails on macOS 26: the AppleEvent handler errors, and a pBBk bookmark
# captured against the temporary mount is what Tahoe's Finder then prefers,
# so the window opens on default grey. The layout is written the way
# dmgbuild does it — an icvp alias, no bookmark — which is why this
# converts the finished image, writes .DS_Store, and converts it back.
#
# The app inside is not touched, so a notarisation ticket stapled to it
# survives; the image itself is re-signed afterwards because repacking
# invalidates its signature.
#
# Usage: APPLE_SIGNING_IDENTITY=… scripts/finish-dmg.sh [path/to/Waveform.dmg]
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
# Newest rather than first: the bundler does not clear the directory, and an
# image left by an earlier version sorts ahead of the one just built.
if [ -z "${1:-}" ]; then
  set -- "$(ls -t "$ROOT"/src-tauri/target/release/bundle/dmg/Waveform_*.dmg 2>/dev/null | head -1)"
fi
DMG="${1:?usage: finish-dmg.sh <dmg>}"
if [ ! -f "$DMG" ]; then
  echo "finish-dmg: no image at $DMG" >&2
  exit 1
fi

# The bundler names the image Waveform_0.1.1_aarch64.dmg, from the Rust target
# triple. aarch64 and arm64 are two names for one instruction set; Apple's is
# arm64, and that is the one somebody choosing a download recognises.
#
# Hyphens rather than underscores because webtiara.com serves the image from
# its own public/ directory and its download link is written that way. The name
# is the contract between the two repositories, so it is settled here instead of
# at the point somebody copies the file across.
#
# Renamed before signing, so the signature and the notarisation ticket belong to
# the file that ships rather than to a name that no longer exists.
case "$DMG" in
  *_aarch64.dmg)
    dir="$(dirname "$DMG")"
    base="$(basename "$DMG" _aarch64.dmg)"
    renamed="$dir/Waveform-${base#Waveform_}-arm64.dmg"
    mv "$DMG" "$renamed"
    DMG="$renamed"
    ;;
esac

BACKGROUND_NAME="dmg-background.png"
# Must match bundle.macOS.dmg in src-tauri/tauri.conf.json.
WINDOW_W=660
WINDOW_H=400
APP_X=180
APP_Y=170
FOLDER_X=480
FOLDER_Y=170
ICON_SIZE=128

VENV="$ROOT/.venv-dmg"
if ! "$VENV/bin/python" -c "import ds_store, mac_alias" 2>/dev/null; then
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install -q ds_store mac_alias
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT HUP INT TERM

# A leftover mount of the same name makes attach pick Waveform 1, and the
# alias would then point at the wrong volume.
for leftover in /Volumes/Waveform /Volumes/Waveform\ 1 /Volumes/Waveform\ 2; do
  if [ -d "$leftover" ]; then
    hdiutil detach "$leftover" -force -quiet 2>/dev/null || true
  fi
done

rw="$work/rw.dmg"
hdiutil convert "$DMG" -format UDRW -o "$rw" -quiet

mount_point="$(hdiutil attach "$rw" -noautoopen -owners on \
  | grep -o '/Volumes/.*' | head -1)"
if [ -z "$mount_point" ]; then
  echo "finish-dmg: the image did not mount" >&2
  exit 1
fi

if [ ! -f "$mount_point/.background/$BACKGROUND_NAME" ]; then
  hdiutil detach "$mount_point" -quiet || true
  echo "finish-dmg: no .background/$BACKGROUND_NAME in the image" >&2
  exit 1
fi

# Replace the bundler's copy so a layout tweak does not need a full rebuild.
cp "$ROOT/icons/dmg-background.png" "$mount_point/.background/$BACKGROUND_NAME"
if [ -f "$ROOT/icons/dmg-background@2x.png" ]; then
  cp "$ROOT/icons/dmg-background@2x.png" "$mount_point/.background/"
fi

"$VENV/bin/python" "$ROOT/scripts/write-dmg-layout.py" "$mount_point" \
  --background ".background/$BACKGROUND_NAME" \
  --window "$WINDOW_W" "$WINDOW_H" \
  --app "$APP_X" "$APP_Y" \
  --folder "$FOLDER_X" "$FOLDER_Y" \
  --icon-size "$ICON_SIZE"

sync
hdiutil detach "$mount_point" -quiet

compressed="$work/final.dmg"
hdiutil convert "$rw" -format UDZO -imagekey zlib-level=9 -o "$compressed" -quiet
mv "$compressed" "$DMG"

if [ -n "${APPLE_SIGNING_IDENTITY:-}" ]; then
  codesign --force --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$DMG"
  echo "finish-dmg: laid out and re-signed $DMG"
else
  echo "finish-dmg: laid out $DMG (unsigned: no APPLE_SIGNING_IDENTITY)"
fi

# And notarise the image, not only the app inside it.
#
# The bundler notarises and staples the .app, which is what lets it launch. The
# image is a separate thing to Gatekeeper, and repacking it above invalidated
# whatever it had -- so without this the download meets "Apple cannot check it
# for malicious software" before anyone gets as far as the app. Two builds went
# out that way.
if [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
  echo "finish-dmg: notarising $DMG"
  xcrun notarytool submit "$DMG" \
    --apple-id "$APPLE_ID" \
    --password "$APPLE_PASSWORD" \
    --team-id "$APPLE_TEAM_ID" \
    --wait
  xcrun stapler staple "$DMG"
  # Says "accepted" only when a downloaded copy would open without a warning.
  spctl -a -t open --context context:primary-signature -v "$DMG" || true
else
  echo "finish-dmg: not notarised (APPLE_ID, APPLE_PASSWORD or APPLE_TEAM_ID unset)" >&2
fi
