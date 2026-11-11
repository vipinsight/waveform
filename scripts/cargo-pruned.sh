#!/usr/bin/env bash
# Runs a cargo build, then deletes every artifact that build did not use, so
# target/ holds only the latest build instead of every build ever made.
#
# Usage: scripts/cargo-pruned.sh build --release
#        scripts/cargo-pruned.sh test --no-run --manifest-path src-tauri/Cargo.toml
#
# Only commands that compile and stop belong here: the JSON messages cargo
# prints on stdout are captured, so `cargo test` must be given --no-run and
# run again for its output.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
messages="$(mktemp -t waveform-cargo)"
trap 'rm -f "$messages"' EXIT

# json-render-diagnostics: JSON to stdout, human-readable errors to stderr.
cargo "$@" --message-format=json-render-diagnostics > "$messages"
python3 -I "$ROOT/scripts/prune-target.py" "$messages" || true
