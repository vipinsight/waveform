#!/usr/bin/env bash
# Tests the model proxy as if Hugging Face were blocked.
#
#   test/run.sh                 the live proxy at models.webtiara.com
#   test/run.sh --local         this checkout's Worker, under `wrangler dev`
#   test/run.sh [--local] --full   checksum every model and pull whole repos (many GB)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
base="https://models.webtiara.com"
args=()
local=false
for arg in "$@"; do
  case "$arg" in
    --local) local=true ;;
    *) args+=("$arg") ;;
  esac
done

venv="$here/.venv"
if [ ! -x "$venv/bin/python" ]; then
  python3 -m venv "$venv"
  "$venv/bin/python" -m pip install --quiet --upgrade pip
  "$venv/bin/python" -m pip install --quiet "huggingface_hub>=0.30"
fi

if $local; then
  port=8787
  base="http://localhost:$port"
  log="$(mktemp)"
  # A second hostname for the same server stands in for models-cdn.
  (cd "$here/.." && exec npx --yes wrangler@4 dev --port "$port" \
    --var "CDN_ORIGIN:http://127.0.0.1:$port" >"$log" 2>&1) &
  server=$!
  trap 'kill $server 2>/dev/null; pkill -f "wrangler.*dev --port $port" 2>/dev/null || true' EXIT
  for _ in $(seq 1 60); do
    curl -s -o /dev/null "$base/" && break
    sleep 1
  done
  curl -s -o /dev/null "$base/" || { cat "$log"; exit 1; }
fi

"$venv/bin/python" -I "$here/test_proxy.py" "$base" ${args[@]+"${args[@]}"}
