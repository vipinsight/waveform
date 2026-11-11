#!/usr/bin/env bash
# Removes build output from git worktrees nobody is building in.
#
# Every worktree has its own src-tauri/target, several gigabytes each. Builds
# in a checkout keep only their latest output (see cargo-pruned.sh), but a
# worktree that is left alone keeps its last build forever. Once its target
# has gone STALE_DAYS without a build, this deletes it. The checkout itself is
# untouched; the next build there just starts from scratch.
#
# Usage: scripts/clean-builds.sh [--dry-run] [--quiet]
# Env:   WAVEFORM_BUILD_STALE_DAYS (default 7)
set -euo pipefail

STALE_DAYS="${WAVEFORM_BUILD_STALE_DAYS:-7}"
DRY_RUN=0
QUIET=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --quiet) QUIET=1 ;;
    *) echo "usage: $0 [--dry-run] [--quiet]" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

git -C "$ROOT" worktree list --porcelain | sed -n 's/^worktree //p' | while read -r tree; do
  [ "$tree" = "$ROOT" ] && continue
  target="$tree/src-tauri/target"
  [ -d "$target" ] || continue
  # The binary, a fingerprint or an incremental session near the top of target
  # is rewritten by every build, including one still in progress.
  if [ -n "$(find "$target" -maxdepth 3 -mtime "-$STALE_DAYS" -print -quit 2>/dev/null)" ]; then
    [ "$QUIET" = 1 ] || echo "clean-builds: keeping $target (built within $STALE_DAYS days)"
    continue
  fi
  gb="$(du -sk "$target" | awk '{ printf "%.1f", $1 / 1048576 }')"
  if [ "$DRY_RUN" = 1 ]; then
    echo "clean-builds: would remove $target ($gb GB, no build for $STALE_DAYS+ days)"
  else
    echo "clean-builds: removing $target ($gb GB, no build for $STALE_DAYS+ days)"
    rm -rf "$target"
  fi
done
