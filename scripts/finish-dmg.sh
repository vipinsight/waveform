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
if [ -z "${1:-}" ]; then
  set -- "$ROOT"/src-tauri/target/release/bundle/dmg/Waveform_*.dmg
fi
DMG="${1:?usage: finish-dmg.sh <dmg>}"
if [ ! -f "$DMG" ]; then
  echo "finish-dmg: no image at $DMG" >&2
  exit 1
fi

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
