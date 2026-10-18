#!/usr/bin/env python3
"""
Cross-platform depth estimation benchmark — spawned by Aegis IPC handler.

Supports all backends:
  macOS  → CoreML (Neural Engine)
  Win/Linux (NVIDIA) → TensorRT FP16 → PyTorch CUDA
  Any    → PyTorch CPU fallback

Usage:
  python benchmark.py --variant DepthAnythingV2SmallF16 --runs 10 --colormap viridis
  python benchmark.py --model depth-anything-v2-small --runs 10

Outputs JSONL progress events and a final result event to stdout.
Progress events: {"event": "progress", "stage": "...", "message": "..."}
Final result:    {"event": "result", ...benchmark data...}
"""

import sys
import json
import time
import os
import argparse
import platform
import tempfile
from pathlib import Path

# Import the skill class from the same directory
_script_dir = Path(__file__).resolve().parent
sys.path.insert(0, str(_script_dir))


MODELS_DIR = Path.home() / ".aegis-ai" / "models" / "feature-extraction"

COLORMAP_MAP = {
    "inferno": 1, "viridis": 16, "plasma": 13, "magma": 12,
    "jet": 2, "turbo": 18, "hot": 11, "cool": 8,
}

COMPUTE_UNIT_MAP = {
    "all": "ALL",
    "cpu": "CPU_ONLY",
    "gpu": "CPU_AND_GPU",
    "cpu_npu": "CPU_AND_NE",
    "npu": "ALL",
}


def _log(msg):
    print(f"[DepthBenchmark] {msg}", file=sys.stderr, flush=True)


def _emit(event: dict):
    """Emit a JSONL event to stdout for the Electron handler to parse."""
    print(json.dumps(event), flush=True)


def download_test_image(url):
    """Download a test image from URL, return numpy BGR array."""
    import cv2
    import numpy as np
    import urllib.request

    _emit({"event": "progress", "stage": "download", "message": f"Downloading test image..."})
    _log(f"Downloading test image: {url}")
    tmp_path = os.path.join(tempfile.gettempdir(), "aegis_depth_bench_test.jpg")

    try:
        urllib.request.urlretrieve(url, tmp_path)
        img = cv2.imread(tmp_path)
        if img is not None:
            return img
    except Exception as e:
        _log(f"Download failed: {e}")

    # Fallback: generate a synthetic test image
    _log("Using synthetic test image (640x480 gradient)")
    return np.random.randint(0, 255, (480, 640, 3), dtype=np.uint8)


# ── CoreML benchmark (macOS only) ───────────────────────────────────────────

def run_coreml_benchmark(args, test_image):
    """Run CoreML benchmark (macOS only). Mirrors legacy benchmark_coreml.py."""
    import cv2
    import numpy as np
    import coremltools as ct
    from PIL import Image

    COREML_INPUT_SIZE = (518, 392)  # width, height

    variant_id = args.variant
    model_path = MODELS_DIR / f"{variant_id}.mlpackage"

    if not model_path.exists():
        return {"error": f"CoreML model not found: {model_path}"}

    # Load model
    _emit({"event": "progress", "stage": "model", "message": f"Loading CoreML model: {variant_id}..."})
    _log(f"Loading CoreML model: {variant_id}")
    compute_unit_key = COMPUTE_UNIT_MAP.get(args.compute_units, "ALL")
    compute_unit = getattr(ct.ComputeUnit, compute_unit_key, ct.ComputeUnit.ALL)

    t0 = time.perf_counter()
    model = ct.models.MLModel(str(model_path), compute_units=compute_unit)
    load_time_ms = (time.perf_counter() - t0) * 1000
    _log(f"Model loaded in {load_time_ms:.0f}ms (compute_units={compute_unit_key})")

    original_h, original_w = test_image.shape[:2]
    input_w, input_h = COREML_INPUT_SIZE

    # Prepare input
    rgb = cv2.cvtColor(test_image, cv2.COLOR_BGR2RGB)
    resized = cv2.resize(rgb, (input_w, input_h), interpolation=cv2.INTER_LINEAR)
    pil_image = Image.fromarray(resized, mode="RGB")

    colormap_id = COLORMAP_MAP.get(args.colormap, 16)

    # Warm-up run
    _emit({"event": "progress", "stage": "warmup", "message": "Warm-up inference..."})
    _log("Warm-up inference...")
    model.predict({"image": pil_image})

    # Benchmark runs
    _emit({"event": "progress", "stage": "benchmark", "message": f"Running {args.runs} iterations...", "total": args.runs})
    _log(f"Running {args.runs} benchmark iterations...")
    times = []
    last_depth_colored = None

    for i in range(args.runs):
        t0 = time.perf_counter()
        prediction = model.predict({"image": pil_image})
        elapsed_ms = (time.perf_counter() - t0) * 1000
        times.append(elapsed_ms)
        _emit({"event": "progress", "stage": "run", "run": i + 1, "total": args.runs,
               "time_ms": round(elapsed_ms, 1), "message": f"Run {i + 1}/{args.runs} ({elapsed_ms:.1f}ms)"})

        if i == 0:
            output_key = list(prediction.keys())[0]
            depth_map = np.array(prediction[output_key])
            if depth_map.ndim > 2:
                depth_map = np.squeeze(depth_map)
            depth_norm = (depth_map - depth_map.min()) / (depth_map.max() - depth_map.min() + 1e-8)
            depth_uint8 = (depth_norm * 255).astype(np.uint8)
            last_depth_colored = cv2.applyColorMap(depth_uint8, colormap_id)
            last_depth_colored = cv2.resize(last_depth_colored, (original_w, original_h))

    return _build_result(
        times, load_time_ms, args, last_depth_colored,
        backend="coreml", device="neural_engine",
    )


# ── ONNX / TensorRT / PyTorch benchmark (Windows/Linux) ─────────────────

def run_inference_benchmark(args, test_image):
    """Run non-macOS benchmark. Uses DepthEstimationSkill (auto: ONNX → TRT → PyTorch)."""
    import cv2
    import numpy as np
    from transform import DepthEstimationSkill

    model_name = args.model or "depth-anything-v2-small"
    colormap_id = COLORMAP_MAP.get(args.colormap, 16)

    # Create skill and load model (auto-selects TensorRT → PyTorch cascade)
    skill = DepthEstimationSkill()

    # Hardware detection
    from transform_base import TransformSkillBase
    device_pref = args.device or "auto"
    skill.env = TransformSkillBase._detect_hardware(device_pref)
    skill.device = skill.env.device

    config = {
        "model": model_name,
        "device": device_pref,
        "colormap": args.colormap,
        "blend_mode": "depth_only",
    }

    _emit({"event": "progress", "stage": "model", "message": f"Loading model: {model_name} ({skill.device})..."})
    _log(f"Loading model: {model_name} (device={skill.device})")
    t0 = time.perf_counter()
    ready_info = skill.load_model(config)
    load_time_ms = (time.perf_counter() - t0) * 1000
    backend = ready_info.get("backend", "pytorch")
    device = ready_info.get("device", skill.device)
    _log(f"Model loaded in {load_time_ms:.0f}ms (backend={backend}, device={device})")

    # Warm-up run
    _emit({"event": "progress", "stage": "warmup", "message": "Warm-up inference..."})
    _log("Warm-up inference...")
    skill.transform_frame(test_image, {"camera_id": "bench", "frame_id": "warmup"})

    # Benchmark runs
    _emit({"event": "progress", "stage": "benchmark", "message": f"Running {args.runs} iterations...", "total": args.runs})
    _log(f"Running {args.runs} benchmark iterations...")
    times = []
    last_depth_colored = None

    for i in range(args.runs):
        t0 = time.perf_counter()
        result = skill.transform_frame(
            test_image, {"camera_id": "bench", "frame_id": f"run_{i}"}
        )
        elapsed_ms = (time.perf_counter() - t0) * 1000
        times.append(elapsed_ms)
        _emit({"event": "progress", "stage": "run", "run": i + 1, "total": args.runs,
               "time_ms": round(elapsed_ms, 1), "message": f"Run {i + 1}/{args.runs} ({elapsed_ms:.1f}ms)"})

        if i == 0:
            last_depth_colored = result

    return _build_result(
        times, load_time_ms, args, last_depth_colored,
        backend=backend, device=device,
    )


# ── Shared result builder ────────────────────────────────────────────────────

def _build_result(times, load_time_ms, args, last_depth_colored,
                  backend="pytorch", device="cpu"):
    """Build the JSON result dict from benchmark timings."""
    import statistics

    times_sorted = sorted(times)
    avg_ms = statistics.mean(times)
    std_ms = statistics.stdev(times) if len(times) > 1 else 0

    result = {
        "model_id": args.model or "depth-anything-v2-small",
        "variant_id": args.variant,
        "num_runs": args.runs,
        "successful_runs": len(times),
        "avg_time_ms": round(avg_ms, 2),
        "min_time_ms": round(times_sorted[0], 2),
        "max_time_ms": round(times_sorted[-1], 2),
        "std_time_ms": round(std_ms, 2),
        "fps": round(1000.0 / avg_ms, 2) if avg_ms > 0 else 0,
        "model_load_ms": round(load_time_ms, 2),
        "backend": backend,
        "device": device,
        "compute_units": args.compute_units,
        "platform": platform.system(),
    }

    # Encode extraction result as base64 for preview
    if last_depth_colored is not None:
        import base64
        import cv2
        _, buf = cv2.imencode(".jpg", last_depth_colored, [cv2.IMWRITE_JPEG_QUALITY, 85])
        result["extraction_result"] = {
            "success": True,
            "feature_type": "depth_estimation",
            "feature_data": base64.b64encode(buf).decode("ascii"),
            "processing_time": round(times[0], 2),
            "metadata": {
                "model": args.variant or args.model,
                "colormap": args.colormap,
                "backend": backend,
                "device": device,
            },
        }

    return result


# ── Main ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Cross-platform depth estimation benchmark")
    parser.add_argument("--variant", default="DepthAnythingV2SmallF16",
                        help="CoreML variant ID (macOS) or model variant name")
    parser.add_argument("--model", default="depth-anything-v2-small",
                        help="Model name (e.g., depth-anything-v2-small)")
    parser.add_argument("--runs", type=int, default=10)
    parser.add_argument("--colormap", default="viridis")
    parser.add_argument("--compute-units", default="all")
    parser.add_argument("--device", default="auto",
                        choices=["auto", "cpu", "cuda", "mps"])
    parser.add_argument("--test-image-url",
                        default="https://ultralytics.com/images/bus.jpg")
    args = parser.parse_args()

    # Download test image (shared across all backends)
    test_image = download_test_image(args.test_image_url)

    # Route to appropriate benchmark
    if platform.system() == "Darwin":
        try:
            result = run_coreml_benchmark(args, test_image)
        except Exception as e:
            _log(f"CoreML benchmark failed ({e}), falling back to ONNX/PyTorch")
            result = run_inference_benchmark(args, test_image)
    else:
        result = run_inference_benchmark(args, test_image)

    if "error" in result:
        _log(f"Benchmark failed: {result['error']}")
    else:
        _log(f"Benchmark complete: {result['avg_time_ms']:.1f}ms avg ({result['fps']:.1f} FPS)")

    # Emit final result as JSONL (event=result so handler knows to resolve)
    result["event"] = "result"
    _emit(result)
