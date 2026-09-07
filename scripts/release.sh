#!/bin/sh
# Cuts a release: builds, signs, notarises, and publishes what the updater
# needs alongside the disk image people download by hand.
#
# Two signatures are involved and they are unrelated. Apple's says the app came
# from a known developer, and macOS refuses to run it otherwise. minisign's says
# an update came from us, and the app itself refuses to unpack it otherwise --
# which is why the private key must never be in this repository, and why losing
# it means no existing install can ever be updated again.
#
# Usage: scripts/release.sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

REPO="vipiny35/waveform"
KEY="${TAURI_SIGNING_PRIVATE_KEY_PATH:-$HOME/.tauri/waveform.key}"

fail() {
  echo "release: $1" >&2
  exit 1
}

# ------------------------------------------------------------------ preflight

[ -z "$(git status --porcelain)" ] || fail "the working tree has changes; commit them first"

# tauri.conf.json is the version the updater compares. The other two only have
# to agree with it: three hand-kept copies of one number is a trap, and a
# mismatch here means the release is named one thing and reports another.
VERSION="$(python3 -c 'import json;print(json.load(open("src-tauri/tauri.conf.json"))["version"])')"
PKG_VERSION="$(python3 -c 'import json;print(json.load(open("package.json"))["version"])')"
CARGO_VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' src-tauri/Cargo.toml | head -1)"
[ "$PKG_VERSION" = "$VERSION" ] || fail "package.json says $PKG_VERSION, tauri.conf.json says $VERSION"
[ "$CARGO_VERSION" = "$VERSION" ] || fail "Cargo.toml says $CARGO_VERSION, tauri.conf.json says $VERSION"

if git rev-parse "v$VERSION" >/dev/null 2>&1; then
  fail "v$VERSION already exists; bump the version first"
fi

[ -f "$KEY" ] || fail "no update signing key at $KEY (tauri signer generate -w \"$KEY\")"
command -v gh >/dev/null 2>&1 || fail "the gh CLI is needed to publish the release"

# The Tauri CLI reads these from the environment and not from a file, which is
# the one thing that catches everybody out.
if [ -f .env.notarization ]; then
  set -a
  . ./.env.notarization
  set +a
fi
[ -n "${APPLE_ID:-}" ] || fail "APPLE_ID is not set; notarisation would be skipped"
[ -n "${APPLE_PASSWORD:-}" ] || fail "APPLE_PASSWORD is not set"
[ -n "${APPLE_TEAM_ID:-}" ] || fail "APPLE_TEAM_ID is not set"
[ -n "${APPLE_SIGNING_IDENTITY:-}" ] || fail "APPLE_SIGNING_IDENTITY is not set"

TAURI_SIGNING_PRIVATE_KEY="$KEY"
export TAURI_SIGNING_PRIVATE_KEY
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"

# ---------------------------------------------------------------------- build

# app as well as dmg: the tarball the updater installs comes from the app
# target, and `--bundles dmg` on its own silently produces no updater artifact
# at all, however `createUpdaterArtifacts` is set.
echo "release: building $VERSION"
pnpm exec tauri build --bundles app,dmg

BUNDLE="src-tauri/target/release/bundle"
TARBALL="$BUNDLE/macos/Waveform.app.tar.gz"
SIGNATURE="$TARBALL.sig"
DMG="$(ls "$BUNDLE"/dmg/Waveform_*.dmg | head -1)"

[ -f "$TARBALL" ] || fail "no updater tarball at $TARBALL"
[ -f "$SIGNATURE" ] || fail "no signature at $SIGNATURE"
[ -f "$DMG" ] || fail "no disk image in $BUNDLE/dmg"

scripts/finish-dmg.sh "$DMG"

# ------------------------------------------------------------------- manifest

# Only darwin-aarch64. Waveform needs an Apple Silicon Mac, and a platform in
# this file is a promise that an update exists for it.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT HUP INT TERM
ASSET="Waveform_${VERSION}.app.tar.gz"
cp "$TARBALL" "$WORK/$ASSET"

VERSION="$VERSION" REPO="$REPO" ASSET="$ASSET" SIGNATURE="$SIGNATURE" \
  python3 - "$WORK/latest.json" <<'PY'
import json, os, sys, datetime

path = sys.argv[1]
version = os.environ["VERSION"]
with open(os.environ["SIGNATURE"]) as handle:
    signature = handle.read().strip()

manifest = {
    "version": version,
    "notes": f"See https://github.com/{os.environ['REPO']}/releases/tag/v{version}",
    "pub_date": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
    "platforms": {
        "darwin-aarch64": {
            "signature": signature,
            "url": (
                f"https://github.com/{os.environ['REPO']}/releases/download/"
                f"v{version}/{os.environ['ASSET']}"
            ),
        }
    },
}
with open(path, "w") as handle:
    json.dump(manifest, handle, indent=2)
    handle.write("\n")
PY

# ----------------------------------------------------------------- publish

# latest.json is fetched through releases/latest/download, which always
# resolves to the newest release -- so it has to be attached to this one.
echo "release: publishing v$VERSION"
gh release create "v$VERSION" \
  --repo "$REPO" \
  --title "Waveform $VERSION" \
  --generate-notes \
  "$DMG" \
  "$WORK/$ASSET" \
  "$WORK/latest.json"

echo "release: v$VERSION is out"
