#!/usr/bin/env python3
"""OpenAI Whisper, spoken to over the same protocol as the Qwen worker.

One JSON object per line on stdin, one `WAVEFORM:`-prefixed line back per
result, so src-tauri/src/model_server.rs can drive either engine with the same
reader loop.
"""
import argparse
import base64
import io
import json
import math
import os
import sys
import traceback
import wave

PROTOCOL_PREFIX = "WAVEFORM:"
# What Whisper was trained on. Everything is resampled to this before it is fed
# in; the browser records at whatever rate the audio hardware runs at.
WHISPER_RATE = 16_000


def send(payload):
    print(PROTOCOL_PREFIX + json.dumps(payload, ensure_ascii=False), flush=True)


def decode_wav(data):
    """Mono float32 at Whisper's rate, from the PCM16 the renderer writes.

    Deliberately not `whisper.load_audio`, which shells out to ffmpeg: that
    would put a system binary between a working install and a working
    dictation, and the renderer already hands us plain PCM.
    """
    import numpy as np

    with wave.open(io.BytesIO(data), "rb") as source:
        channels = source.getnchannels()
        width = source.getsampwidth()
        rate = source.getframerate()
        frames = source.readframes(source.getnframes())

    if width != 2:
        raise ValueError(f"Expected 16-bit audio, got {width * 8}-bit.")

    samples = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)

    if rate != WHISPER_RATE:
        from scipy.signal import resample_poly

        # Polyphase rather than plain interpolation: dropping from 48kHz to
        # 16kHz without filtering first folds everything above 8kHz back down
        # over the speech.
        step = math.gcd(int(rate), WHISPER_RATE)
        samples = resample_poly(samples, WHISPER_RATE // step, int(rate) // step)

    return np.ascontiguousarray(samples, dtype=np.float32)


def load_model(name):
    """Loads on the fastest device that actually works, not the fastest one offered.

    Whisper leans on operations Metal does not always implement. The fallback
    covers most of them, but a model that will not load or will not run is
    worth finding out about here rather than on the user's first phrase.
    """
    os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
    import numpy as np
    import torch
    import whisper

    forced = os.environ.get("WAVEFORM_WHISPER_DEVICE")
    order = [forced] if forced else (["mps", "cpu"] if torch.backends.mps.is_available() else ["cpu"])

    last = None
    for device in order:
        try:
            model = whisper.load_model(name, device=device)
            # A tenth of a second of silence, purely to prove the graph runs.
            model.transcribe(
                np.zeros(WHISPER_RATE // 10, dtype=np.float32),
                fp16=device != "cpu",
            )
            return model, device
        except Exception as error:  # noqa: BLE001 - reported to the app verbatim
            traceback.print_exc(file=sys.stderr)
            last = error
    raise RuntimeError(last)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    args = parser.parse_args()

    try:
        model, device = load_model(args.model)
        send({"type": "ready", "device": device})
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        send({"type": "error", "message": f"Could not load Whisper: {error}"})
        return 1

    for raw_line in sys.stdin:
        request = None
        try:
            request = json.loads(raw_line)
            request_id = request["id"]
            audio = decode_wav(base64.b64decode(request["audio"]))
            result = model.transcribe(audio, fp16=device != "cpu", language=None)
            send(
                {
                    "type": "result",
                    "id": request_id,
                    "text": (result.get("text") or "").strip(),
                    "language": result.get("language"),
                }
            )
        except Exception as error:
            traceback.print_exc(file=sys.stderr)
            send(
                {
                    "type": "error",
                    "id": request.get("id") if isinstance(request, dict) else None,
                    "message": str(error),
                }
            )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
