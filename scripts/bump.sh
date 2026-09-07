#!/bin/sh
# Sets the version in the four files that carry it.
#
# release.sh checks that they agree and refuses when they do not, which catches
# a half-done bump but does nothing to prevent one. Four hand edits before every
# release is the kind of step that gets three-quarters done at midnight.
#
# Cargo.lock is the one people forget. Cargo rewrites it on the next build, so
# leaving it stale means a release ends with a dirty tree and the release after
# that fails its own preflight for a reason that looks unrelated.
#
# Usage: scripts/bump.sh 0.2.0
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

fail() {
  echo "bump: $1" >&2
  exit 1
}

NEXT="${1:-}"
[ -n "$NEXT" ] || fail "give the version to set, e.g. scripts/bump.sh 0.2.0"

# The updater compares these as versions, not as strings, so anything it cannot
# parse is worth refusing here rather than discovering in a manifest.
echo "$NEXT" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' \
  || fail "$NEXT is not a three-part version"

NEXT="$NEXT" python3 - <<'PY'
import json, os, pathlib, re, sys

nxt = os.environ["NEXT"]

def fail(message):
    print(f"bump: {message}", file=sys.stderr)
    raise SystemExit(1)

# Read the current version from each file, and rewrite one line rather than the
# whole document: round-tripping JSON reformats files nobody asked to reformat,
# and Cargo.lock is not ours to rewrite at all.
targets = [
    ("src-tauri/tauri.conf.json", re.compile(r'("version":\s*")([^"]+)(")')),
    ("package.json", re.compile(r'("version":\s*")([^"]+)(")')),
    ("src-tauri/Cargo.toml", re.compile(r'(?m)^(version = ")([^"]+)(")')),
    (
        "src-tauri/Cargo.lock",
        re.compile(r'(?ms)(^name = "waveform"\nversion = ")([^"]+)(")'),
    ),
]

current = {}
for path, pattern in targets:
    text = pathlib.Path(path).read_text()
    match = pattern.search(text)
    if not match:
        fail(f"no version found in {path}")
    current[path] = match.group(2)

# A bump that starts from disagreement would paper over the mismatch that
# release.sh exists to catch.
distinct = set(current.values())
if len(distinct) > 1:
    listing = ", ".join(f"{p} says {v}" for p, v in current.items())
    fail(f"the files disagree already: {listing}")

was = distinct.pop()
if was == nxt:
    fail(f"already {nxt}")

for path, pattern in targets:
    file = pathlib.Path(path)
    text = file.read_text()
    file.write_text(pattern.sub(lambda m: m.group(1) + nxt + m.group(3), text, count=1))

print(f"bump: {was} -> {nxt}")
for path in current:
    print(f"  {path}")
PY

echo "bump: commit these, push, then pnpm release"
