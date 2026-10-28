#!/usr/bin/env bash
# Fetches the public recordings the speaker-tagging harness scores against
# (see src-tauri/examples/diarize_eval.rs). Nothing here is committed: the
# audio is large and the corpus has its own licence (AMI, CC BY 4.0).
#
# For each meeting it keeps:
#   <id>.mix.wav     every headset summed: several people, clean audio
#   <id>.far.wav     one table microphone: several people in a room, as a
#                    laptop mic hears them
#   <id>.rttm        who spoke when (pyannote's word-aligned AMI setup)
#   <id>.headset-N.wav  each person's own headset (first two meetings of a
#                    series), for enrolling a voice and building two-track calls
#
# Usage: scripts/fetch-diarization-eval.sh [dir]   (default ~/.cache/waveform-eval/ami)
set -euo pipefail

DIR="${1:-$HOME/.cache/waveform-eval/ami}"
AUDIO="https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus"
RTTM="https://raw.githubusercontent.com/pyannote/AMI-diarization-setup/main/only_words/rttms/test"

# Two series from the AMI test set, four meetings each with the same four
# people, so a voice enrolled in one meeting can be looked for in the next.
MEETINGS=(ES2004a ES2004b ES2004c ES2004d IS1009a IS1009b IS1009c IS1009d)

mkdir -p "$DIR"
get() {
  local url="$1" out="$2"
  [[ -s "$out" ]] && return 0
  echo "fetching $(basename "$out")"
  curl -fsSL --retry 3 -o "$out.part" "$url"
  mv "$out.part" "$out"
}

for id in "${MEETINGS[@]}"; do
  series="${id%?}"
  get "$RTTM/$id.rttm" "$DIR/$id.rttm"
  get "$AUDIO/$id/audio/$id.Mix-Headset.wav" "$DIR/$id.mix.wav"
  get "$AUDIO/$id/audio/$id.Array1-01.wav" "$DIR/$id.far.wav"
  # Headsets for the first two meetings of each series: the first to enrol
  # voices from, the second to build a two-track call (some people on the
  # mic, the rest on the system track) to find them in.
  if [[ "$id" == "${series}a" || "$id" == "${series}b" ]]; then
    for n in 0 1 2 3; do
      get "$AUDIO/$id/audio/$id.Headset-$n.wav" "$DIR/$id.headset-$n.wav"
    done
  fi
done
echo "done: $DIR"
