#!/bin/sh
# Prepares a draft: builds, signs, notarises, and uploads what the updater
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

REPO="vipinsight/waveform"

fail() {
  echo "release: $1" >&2
  exit 1
}

# ------------------------------------------------------------------ preflight

[ -z "$(git status --porcelain)" ] || fail "the working tree has changes; commit them first"
[ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ] \
  || fail "release builds require an Apple Silicon Mac"
python3 scripts/check-version.py

# The shared check above includes Cargo.lock as well as the three manifests.
VERSION="$(python3 -c 'import json;print(json.load(open("src-tauri/tauri.conf.json"))["version"])')"

if git rev-parse "v$VERSION" >/dev/null 2>&1; then
  fail "v$VERSION already exists; bump the version first"
fi

# The build reads this checkout; the tag is cut from what the remote has. If
# HEAD has not been pushed, the release names one commit and ships another,
# and nothing about it looks wrong afterwards -- the tag exists, the assets
# are attached. Checked rather than pushed for you: pushing is a decision.
COMMIT="$(git rev-parse HEAD)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
git fetch --quiet origin "$BRANCH" 2>/dev/null || fail "cannot reach origin to check $BRANCH is pushed"
git merge-base --is-ancestor "$COMMIT" "origin/$BRANCH" 2>/dev/null \
  || fail "HEAD is not on origin/$BRANCH; push before releasing so the tag names what was built"

command -v gh >/dev/null 2>&1 || fail "the gh CLI is needed to upload the release"
# A query failure must not be treated as an absent release.
RELEASES="$(gh api --paginate "repos/$REPO/releases?per_page=100" --jq '.[].tag_name')" \
  || fail "cannot list releases; check GitHub CLI access"
if printf '%s\n' "$RELEASES" | grep -Fxq "v$VERSION"; then
  fail "v$VERSION already has a release or draft; inspect it before retrying"
fi

# The Tauri CLI reads these from the environment and not from a file, which is
# the one thing that catches everybody out.
if [ -f .env.notarization ]; then
  set -a
  . ./.env.notarization
  set +a
fi
KEY="${TAURI_SIGNING_PRIVATE_KEY_PATH:-$HOME/.tauri/waveform.key}"
[ -f "$KEY" ] || fail "no existing updater signing key at $KEY; restore it from your secure backup"
[ -n "${APPLE_ID:-}" ] || fail "APPLE_ID is not set; notarisation would be skipped"
[ -n "${APPLE_PASSWORD:-}" ] || fail "APPLE_PASSWORD is not set"
[ -n "${APPLE_TEAM_ID:-}" ] || fail "APPLE_TEAM_ID is not set"
[ -n "${APPLE_SIGNING_IDENTITY:-}" ] || fail "APPLE_SIGNING_IDENTITY is not set"

TAURI_SIGNING_PRIVATE_KEY="$KEY"
export TAURI_SIGNING_PRIVATE_KEY
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"

case "$APPLE_SIGNING_IDENTITY" in
  "Developer ID Application:"*) ;;
  *) fail "APPLE_SIGNING_IDENTITY must be a Developer ID Application certificate" ;;
esac

# ---------------------------------------------------------------------- build

# app as well as dmg: the tarball the updater installs comes from the app
# target, and `--bundles dmg` on its own silently produces no updater artifact
# at all, however `createUpdaterArtifacts` is set.
echo "release: building $VERSION"
# Recompile the helper so a cached development helper cannot bypass signing.
rm -f dist/native/waveform-hotkey

# Path remapping used to strip the checkout path from panic/`strings` output,
# but `--remap-path-prefix` breaks proc-macro resolution on current rustc
# (dependents cannot find `*_derive` / `*_macros` crates). Prefer a shippable
# build; revisit when Cargo `trim-paths` is stable on the release toolchain.
export CFLAGS="${CFLAGS:-}"
export CXXFLAGS="${CXXFLAGS:-}"

pnpm exec tauri build --features dist --bundles app,dmg
[ -x dist/native/waveform-hotkey ] || fail "native hotkey helper was not built"

BUNDLE="src-tauri/target/release/bundle"
TARBALL="$BUNDLE/macos/Waveform.app.tar.gz"
SIGNATURE="$TARBALL.sig"
# Scoped to this version: the bundler does not clear the directory, so an image
# left by an earlier release sorts ahead of this one and would be published
# under this version's tag.
DMG="$BUNDLE/dmg/Waveform_${VERSION}_aarch64.dmg"

[ -f "$TARBALL" ] || fail "no updater tarball at $TARBALL"
[ -f "$SIGNATURE" ] || fail "no signature at $SIGNATURE"
[ -f "$DMG" ] || fail "no disk image in $BUNDLE/dmg"

scripts/finish-dmg.sh "$DMG"

# finish-dmg.sh renames the image to the name webtiara.com's download link
# expects, so the file to publish is not the one found above.
DMG="$BUNDLE/dmg/Waveform-${VERSION}-arm64.dmg"
[ -f "$DMG" ] || fail "no disk image at $DMG after finish-dmg.sh"

APP="$BUNDLE/macos/Waveform.app"
codesign --verify --deep --strict "$APP"
xcrun stapler validate "$APP"
spctl --assess --type execute "$APP"
xcrun stapler validate "$DMG"
spctl --assess --type open --context context:primary-signature "$DMG"
[ -z "$(git status --porcelain)" ] || fail "the build changed tracked source or created untracked files"

# ------------------------------------------------------------------- manifest

# Only darwin-aarch64. Waveform needs an Apple Silicon Mac, and a platform in
# this file is a promise that an update exists for it.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT HUP INT TERM
ASSET="Waveform_${VERSION}.app.tar.gz"
cp "$TARBALL" "$WORK/$ASSET"
cp "$SIGNATURE" "$WORK/$ASSET.sig"
cp "$DMG" "$WORK/$(basename "$DMG")"

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

(
  cd "$WORK"
  shasum -a 256 "$(basename "$DMG")" "$ASSET" "$ASSET.sig" latest.json > SHA256SUMS
)

# ----------------------------------------------------------------- draft

# latest.json is fetched through releases/latest/download, which always
# resolves to the newest release -- so it has to be attached to this one.
echo "release: uploading draft v$VERSION"
# --target pins the tag to the commit that was actually built. Without it the
# tag is cut from the remote's default branch, which is the same thing only
# until it is not.
gh release create "v$VERSION" \
  --repo "$REPO" \
  --target "$COMMIT" \
  --title "Waveform $VERSION" \
  --generate-notes \
  --draft \
  "$DMG" \
  "$WORK/$ASSET" \
  "$WORK/$ASSET.sig" \
  "$WORK/SHA256SUMS" \
  "$WORK/latest.json"

echo "release: draft v$VERSION uploaded; follow docs/releasing.md before publishing"
