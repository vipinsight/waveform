#!/usr/bin/env python3
"""Speaker diarization with pyannote, for Waveform's speaker tagging.

Run by src-tauri/src/diarize.rs from the venv the app installs, on a 16 kHz
mono WAV. Prints one line per turn in the format sherpa-onnx's tool uses, so
both engines share one parser:

    1.583 -- 3.406 speaker_00

Usage: pyannote-worker.py MODEL_DIR WAV
"""

import sys
import warnings


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    model_dir, wav = sys.argv[1], sys.argv[2]
    warnings.filterwarnings("ignore")

    import soundfile as sf
    import torch
    from pyannote.audio import Pipeline

    pipeline = Pipeline.from_pretrained(model_dir)
    if pipeline is None:
        print(f"could not load the pipeline from {model_dir}", file=sys.stderr)
        return 1
    # The Mac's GPU runs the voice-print network 2-3x faster than its CPU.
    if torch.backends.mps.is_available():
        pipeline.to(torch.device("mps"))

    # Read here rather than by path: pyannote's own loader needs ffmpeg.
    samples, rate = sf.read(wav, dtype="float32", always_2d=True)
    waveform = torch.from_numpy(samples.mean(axis=1)).unsqueeze(0)
    output = pipeline({"waveform": waveform, "sample_rate": rate})

    # The exclusive variant gives each moment one speaker, which is what
    # tagging a transcript line needs; plain is the fallback for older
    # pipelines that return the annotation itself.
    annotation = getattr(output, "exclusive_speaker_diarization", None)
    if annotation is None:
        annotation = getattr(output, "speaker_diarization", output)
    names = {}
    for segment, _, label in annotation.itertracks(yield_label=True):
        name = names.setdefault(label, f"speaker_{len(names):02d}")
        print(f"{segment.start:.3f} -- {segment.end:.3f} {name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
