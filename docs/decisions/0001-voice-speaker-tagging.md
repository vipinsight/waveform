# 1. Tell speakers apart by voice on both tracks

Date: 2026-10-28. Status: accepted.

A decision record says why the code is the way it is, as of the day it was
written. If it and the code disagree, the code is right; write a new record
rather than editing this one.

## Context

Meetings record two tracks: the Mac's microphone and the other side of the
call. Until now every microphone line was `me`, and only the other side was
diarized (sherpa-onnx: pyannote segmentation 3.0, then the 3D-Speaker ERes2Net
voice-print model, which was trained on Mandarin, with a clustering threshold
of 0.7). So:

- several people in the room with the Mac all showed up as `me`;
- the other side leaking back into the microphone through the Mac's speakers
  was transcribed twice;
- nobody knew how accurate the tagging was. The threshold had been chosen by
  ear on one call.

## Measuring

`src-tauri/examples/diarize_eval.rs` runs the same diarizer the app runs on
recordings where we already know who spoke, and reports three numbers:

- **DER** (diarization error rate): of the time someone is talking, the share
  that is missed, invented, or given to the wrong person. It uses 10 ms frames
  and a 250 ms collar, the way published results are scored.
- **Speakers found** against the true count.
- **Lines tagged right**: transcript lines, cut by the app's own segmenter,
  that carry the right person. This is the number the user actually sees.

Labels are paired with the Hungarian method before anything is counted.
`scripts/fetch-diarization-eval.sh` downloads the test data: the AMI Meeting
Corpus (CC BY 4.0), real 4-person meetings with "who spoke when" marked by
hand. It is kept outside the repo, in `~/.cache/waveform-eval`.

## Findings

On a full AMI meeting (ES2004a, 17 minutes, 4 people), today's setup found
**52 people**, tagged **48%** of lines right, and had a DER of **40%**. Most of
that came from the threshold: with the same model, 1.0 reached 87% of lines.

Every voice-print model sherpa-onnx ships for English was compared on
10-minute clips of three meetings it had not been tuned on (ES2004b, IS1009a,
IS1009b):

| Model, threshold | Lines tagged right | DER | People found (true: 4) | Time for 30 min of audio |
|---|---|---|---|---|
| ERes2Net zh, 0.7 (before) | 70% | 25% | 16–44 | 5.5 min |
| ERes2Net en, 1.2 | 88% | 11% | 2–3 | 6.4 min |
| TitaNet-small, 1.0 | 87% | 12% | 4–16 | 2.7 min |
| **TitaNet-small, 1.1** | **87%** | **11%** | **3–9** | **2.7 min** |
| TitaNet-small, 1.15 | 81% | 18% | 1–5 | 2.6 min |

On ES2004a, at thresholds 1.0 and 1.2, both CAM++ models (3D-Speaker and
WeSpeaker) had a DER of 56% or worse. WeSpeaker ResNet34 matched the finalists
at 1.0 but was slower than TitaNet and fell apart at 1.2. CoreML was 1.3 to
1.6 times slower than the CPU for both finalists. About 6% of the DER is speech the
segmentation model misses or invents, and no voice-print model can fix that.

## Decision

1. **Voice model: TitaNet-small, threshold 1.1.** It is as accurate per line
   as ERes2Net en and twice as fast. ERes2Net en scores slightly higher only
   because it merges quiet speakers into louder ones. A merged person is
   invisible to the user, while an over-split one can be fixed by renaming.
   The file is installed under a new name, so existing installs are offered
   the download again.
2. **Diarize both tracks in one run.** Up to 60 s of the user's recent
   dictations, the microphone and the other side are joined, with 2 s of
   silence between them, and diarized together, so one voice gets one label
   on either track:
   - the cluster the dictation clips fall into is `me`;
   - with no saved dictations, `me` is the voice that talks most on the mic;
   - any other voice on the mic is someone in the room (`speaker_NN`);
   - a mic line in a far-end voice, said while the far end was talking, is
     echo. It is stored with speaker `echo` and hidden from the transcript
     and summary, not deleted, so re-tagging can change its mind.
3. **Run the tool at low priority** (`nice -n 10`). It uses every core but one.
4. **No CoreML**, because it was slower.

## Consequences

- Tagging reads the microphone too, so a meeting takes about twice as long to
  tag as before. With the faster model the total is about the same as before:
  roughly 5 minutes after a 1-hour call.
- Everyone who already has speaker tagging installed downloads it again
  (65 MB).
- A line that spans two speakers still gets one label. The harness counts
  these lines, but how often it happens has not been looked at yet.

## Not yet verified

- The two-track logic (finding `me`, room speakers, echo) is covered only by
  unit tests. `diarize_eval call [--echo -25]` scores it on a simulated call
  built from AMI headsets: two people on the mic, two on the other side, the
  user enrolled from the previous meeting in the series. It has not been run
  yet.
- No real Waveform meeting has gone through the new path yet.
- The model was chosen on three 10-minute clips. One full run over all eight
  AMI meetings (`diarize_eval ami`) would confirm it.
