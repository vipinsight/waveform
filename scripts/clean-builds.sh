#!/usr/bin/env bash
# Keeps Rust build output from eating the disk.
#
# src-tauri/target only ever grows. Cargo never deletes an artifact it no longer
# needs: every dependency bump, feature change or toolchain update leaves the
# old compiled crates behind in target/<profile>/deps, and incremental caches
# pile up next to them. `pnpm test:rust` builds the debug profile and
# `pnpm app` the release profile, so a busy checkout carries both. Each git
# worktree has its own target, so five worktrees cost five times that.
#
# Two rules, both cheap enough to run on every `pnpm app`:
#
#   1. Another worktree whose target has not been touched for STALE_DAYS loses
#      its target. The checkout stays as it is; only build output goes, and
#      the next build there starts from scratch.
#   2. In this checkout, a profile directory bigger than MAX_GB is removed, so
#      the next build of that profile rebuilds just what is still needed.
#
# Usage: scripts/clean-builds.sh [--dry-run] [--quiet]
# Env:   WAVEFORM_BUILD_STALE_DAYS (default 7), WAVEFORM_BUILD_MAX_GB (default 12)
set -euo pipefail

STALE_DAYS="${WAVEFORM_BUILD_STALE_DAYS:-7}"
MAX_GB="${WAVEFORM_BUILD_MAX_GB:-12}"
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

say() { [ "$QUIET" = 1 ] || echo "clean-builds: $*"; }
size_gb() { du -sk "$1" 2>/dev/null | awk '{ printf "%.1f", $1 / 1048576 }'; }

remove() {
  local dir="$1" why="$2"
  if [ "$DRY_RUN" = 1 ]; then
    echo "clean-builds: would remove $dir ($(size_gb "$dir") GB, $why)"
  else
    echo "clean-builds: removing $dir ($(size_gb "$dir") GB, $why)"
    rm -rf "$dir"
  fi
}

# Recently built if anything near the top of target changed within STALE_DAYS:
# the binary, a fingerprint or an incremental session is rewritten by every
# build, including one still in progress.
recently_built() {
  [ -n "$(find "$1" -maxdepth 3 -mtime "-$STALE_DAYS" -print -quit 2>/dev/null)" ]
}

# 1. Stale targets in other worktrees.
git -C "$ROOT" worktree list --porcelain | sed -n 's/^worktree //p' | while read -r tree; do
  [ "$tree" = "$ROOT" ] && continue
  target="$tree/src-tauri/target"
  [ -d "$target" ] || continue
  if recently_built "$target"; then
    say "keeping $target (built within $STALE_DAYS days)"
  else
    remove "$target" "unbuilt for $STALE_DAYS+ days"
  fi
done

# 2. Oversized profiles in this checkout.
max_kb=$((MAX_GB * 1048576))
for profile in "$ROOT"/src-tauri/target/*/; do
  profile="${profile%/}"
  [ -d "$profile/deps" ] || continue
  kb="$(du -sk "$profile" | awk '{ print $1 }')"
  if [ "$kb" -gt "$max_kb" ]; then
    remove "$profile" "over $MAX_GB GB"
  else
    say "keeping $profile ($(size_gb "$profile") GB)"
  fi
done
