# pyannote as the speaker tagger, sherpa-onnx as the fallback

Decided 2026-11-04. Builds on [0001](0001-voice-speaker-tagging.md).

## Why

On a real 18-minute standup, the app's sherpa-onnx diarizer (TitaNet-small,
threshold 1.1) gave one label to the first 1:40 of talk, which was two people
taking turns. pyannote's own pipeline (`speaker-diarization-community-1`:
segmentation, WeSpeaker ResNet34 voice prints, VBx clustering) had the
switches right to within a couple of seconds, as checked by the person who was
in the call. Overall the two disagreed on 22% of the talk time.

## Measured

All with `diarize_eval`, 10-minute clips, the app's own pipeline code
(`--engine pyannote|sherpa`).

One track (AMI Mix-Headset: ES2004b, IS1009a, IS1009b, pooled):

| Engine | Lines tagged right | DER | Right number of people |
|---|---|---|---|
| sherpa, TitaNet-small 1.1 | 87.1% | 11.2% | 1 of 3 |
| **pyannote community-1** | **94.6%** | **9.0%** | 2 of 3 |

pyannote's miss on headcount is IS1009b, where it merged two quiet people
(2 found, 4 true). sherpa over-split instead.

Two-track calls (`diarize_eval call`: dictation enrolment, mic and far end
joined and diarized together), lines tagged right:

| Meeting | sherpa | pyannote |
|---|---|---|
| ES2004b | 51.3% | 46.1% (found 5 of 4) |
| IS1009b | 82.1% | 78.6% (found 2 of 4) |

So on the simulated call pyannote is a few points worse. These are two
meetings, and the joined audio (short enrolment clips, 2 s seams) is the
shape pyannote was not tuned for. It is the main thing to watch.

Speed: about 1.8 min per 30 min of one track on the Mac GPU (mps), against
2.7 min for sherpa on the CPU.

## Decision

1. pyannote runs from its own venv (`runtimes/pyannote`) with the pipeline in
   `models/pyannote`, like Qwen. The worker (`scripts/pyannote-worker.py`) is
   compiled into the binary and prints sherpa's turn format, so everything
   after the turns (joining, `me`, echo, line tagging) is shared.
2. "Tell speakers apart" installs sherpa first (65 MB), then pyannote
   (~1.3 GB) if the Mac has Python 3. A Mac without Python keeps sherpa.
   Existing installs are offered the download again until pyannote is in.
3. When both are installed, pyannote is used.

## Open

- **Weights.** The Hugging Face repo is gated, so the download needs a token
  the app does not have. The licence (CC BY 4.0) allows re-hosting with
  credit; an ungated copy (and a NOTICE entry) is needed before release.
- Look into the two-track result: try diarizing each track with pyannote
  and matching voices across them, instead of one run over the joined audio.
