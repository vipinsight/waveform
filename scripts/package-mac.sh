#!/usr/bin/env bash
# Builds and packages Waveform.app.
#
# Signing identity matters more than it looks. macOS keys Accessibility and
# Input Monitoring grants to the app's code signature: an ad-hoc signature is
# just a hash of the contents, so every rebuild looks like a brand new app and
# you have to re-grant both permissions. Signing with a stable certificate keeps
# the grants across rebuilds.
#
#   WAVEFORM_SIGN_IDENTITY="Apple Development: Your Name (TEAMID)" pnpm package:mac
#
# Defaults to ad-hoc so the build works on a machine with no certificates.
set -euo pipefail

APP_DIR="release/Waveform-darwin-arm64/Waveform.app"
IDENTITY="${WAVEFORM_SIGN_IDENTITY:--}"

npx electron-packager . Waveform \
  --platform=darwin \
  --arch=arm64 \
  --icon=icons/waveform.icns \
  --no-asar \
  --out=release \
  --overwrite \
  --app-bundle-id=com.webtiara.waveform \
  --app-category-type=public.app-category.productivity \
  --usage-description.Microphone='Waveform uses your microphone to transcribe speech locally.' \
  --ignore='^/(?:\.git|\.venv-qwen|node_modules|release)(?:/|$)'

codesign --force --deep --sign "$IDENTITY" "$APP_DIR"

if [ "$IDENTITY" = "-" ]; then
  echo
  echo "Signed ad-hoc. macOS will treat the next rebuild as a different app and"
  echo "you will need to grant Input Monitoring and Accessibility again."
  echo "To keep permissions across rebuilds, pick a stable identity:"
  echo
  security find-identity -v -p codesigning | sed -n '1,4p'
  echo
  echo '  WAVEFORM_SIGN_IDENTITY="Apple Development: ..." pnpm package:mac'
fi
