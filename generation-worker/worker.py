"""Offline, owner-configured FLUX.2 Klein worker. One process per job; no listener or downloads.

Real CUDA inference is a separate acceptance gate. A probe must fail closed on this laptop.
"""
import argparse
import base64
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys


def probe(model_dir):
    dependencies = {name: importlib.util.find_spec(name) is not None for name in ("torch", "diffusers", "transformers")}
    result = {"dependencies": dependencies, "modelPresent": (Path(model_dir) / "model_index.json").is_file(), "cuda": False, "ready": False}
    if dependencies["torch"]:
        import torch
        result["cuda"] = torch.cuda.is_available()
        result["bf16"] = result["cuda"] and torch.cuda.is_bf16_supported()
    result["ready"] = all(dependencies.values()) and result["modelPresent"] and result["cuda"] and result.get("bf16", False)
    return result


def validate(request):
    if not isinstance(request, dict) or set(request) != {"version", "prompt", "width", "height", "seed"}:
        raise ValueError("Invalid request")
    if request["version"] != 1 or not isinstance(request["prompt"], str) or not request["prompt"].strip() or len(request["prompt"]) > 6000:
        raise ValueError("Invalid request")
    for key in ("width", "height"):
        n = request[key]
        if type(n) is not int or not 64 <= n <= 2048 or n % 16:
            raise ValueError("Invalid dimensions")
    if type(request["seed"]) is not int or not 0 <= request["seed"] <= 0xffffffff:
        raise ValueError("Invalid seed")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--probe", action="store_true")
    args = parser.parse_args()
    # Model/transformer libraries may print to stdout. Reserve stdout for one machine-readable result.
    with contextlib.redirect_stdout(sys.stderr):
        ready = probe(args.model_dir)
    if args.probe:
        print(json.dumps(ready))
        return 0 if ready["ready"] else 2
    request = json.loads(sys.stdin.buffer.read(32769))
    validate(request)
    if not ready["ready"]:
        print(json.dumps({"error": "GENERATION_MODEL_UNAVAILABLE"}))
        return 2
    with contextlib.redirect_stdout(sys.stderr):
        import torch
        from diffusers import Flux2KleinPipeline
        pipe = Flux2KleinPipeline.from_pretrained(str(Path(args.model_dir).resolve()), torch_dtype=torch.bfloat16,
                                                local_files_only=True, use_safetensors=True)
        pipe.enable_model_cpu_offload()
        image = pipe(prompt=request["prompt"], width=request["width"], height=request["height"],
                     num_inference_steps=4, guidance_scale=1.0,
                     generator=torch.Generator(device="cuda").manual_seed(request["seed"])).images[0]
        png = io.BytesIO()
        image.convert("RGB").save(png, format="PNG")
    if len(png.getvalue()) > 8 * 1024 * 1024:
        raise ValueError("Output too large")
    print(json.dumps({"mimeType": "image/png", "base64": base64.b64encode(png.getvalue()).decode("ascii")}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        print(json.dumps({"error": "GENERATION_WORKER_UNAVAILABLE"}))
        sys.exit(2)
