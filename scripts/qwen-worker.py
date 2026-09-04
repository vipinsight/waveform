#!/usr/bin/env python3
import argparse
import base64
import json
import os
import sys
import traceback

PROTOCOL_PREFIX = "WAVEFORM:"


def send(payload):
    print(PROTOCOL_PREFIX + json.dumps(payload, ensure_ascii=False), flush=True)


def load_model(model_id):
    os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
    import torch
    from qwen_asr import Qwen3ASRModel

    if torch.backends.mps.is_available():
        device = "mps"
        dtype = torch.float16
    else:
        device = "cpu"
        dtype = torch.float32

    model = Qwen3ASRModel.from_pretrained(
        model_id,
        dtype=dtype,
        device_map=device,
        attn_implementation="sdpa",
        max_inference_batch_size=1,
        max_new_tokens=256,
    )
    return model, device


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    args = parser.parse_args()

    try:
        model, device = load_model(args.model)
        send({"type": "ready", "device": device})
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        send({"type": "error", "message": f"Could not load Qwen3-ASR: {error}"})
        return 1

    for raw_line in sys.stdin:
        request = None
        try:
            request = json.loads(raw_line)
            request_id = request["id"]
            audio = base64.b64decode(request["audio"])
            audio_url = "data:audio/wav;base64," + base64.b64encode(audio).decode("ascii")
            result = model.transcribe(audio=audio_url, language=None)[0]
            send(
                {
                    "type": "result",
                    "id": request_id,
                    "text": result.text.strip(),
                    "language": result.language,
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
