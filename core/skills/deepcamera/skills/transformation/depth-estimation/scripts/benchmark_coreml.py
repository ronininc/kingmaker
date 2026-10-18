#!/usr/bin/env python3
"""
Standalone CoreML depth benchmark — spawned by Aegis IPC handler.

Usage:
  python3 benchmark_coreml.py --variant DepthAnythingV2SmallF16 --runs 10 --colormap viridis

Outputs a single JSON line to stdout with benchmark results.
"""

import sys
import json
import time
import os
import argparse
import platform
from pathlib import Path


MODELS_DIR = Path.home() / ".aegis-ai" / "models" / "feature-extraction"
COREML_INPUT_SIZE = (518, 392)  # width, height

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


def download_test_image(url):
    """Download a test image from URL, return numpy BGR array."""
    import cv2
    import numpy as np
    import urllib.request

    _log(f"Downloading test image: {url}")
    tmp_path = "/tmp/aegis_depth_bench_test.jpg"

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


def run_benchmark(args):
    import cv2
    import numpy as np
    import coremltools as ct
    from PIL import Image

    variant_id = args.variant
    model_path = MODELS_DIR / f"{variant_id}.mlpackage"

    if not model_path.exists():
        print(json.dumps({"error": f"Model not found: {model_path}"}))
        sys.exit(1)

    # Load model
    _log(f"Loading CoreML model: {variant_id}")
    compute_unit_key = COMPUTE_UNIT_MAP.get(args.compute_units, "ALL")
    compute_unit = getattr(ct.ComputeUnit, compute_unit_key, ct.ComputeUnit.ALL)

    t0 = time.perf_counter()
    model = ct.models.MLModel(str(model_path), compute_units=compute_unit)
    load_time_ms = (time.perf_counter() - t0) * 1000
    _log(f"Model loaded in {load_time_ms:.0f}ms (compute_units={compute_unit_key})")

    # Get test image
    test_image = download_test_image(args.test_image_url)
    original_h, original_w = test_image.shape[:2]
    input_w, input_h = COREML_INPUT_SIZE

    # Prepare input
    rgb = cv2.cvtColor(test_image, cv2.COLOR_BGR2RGB)
    resized = cv2.resize(rgb, (input_w, input_h), interpolation=cv2.INTER_LINEAR)
    pil_image = Image.fromarray(resized, mode="RGB")

    colormap_id = COLORMAP_MAP.get(args.colormap, 16)

    # Warm-up run
    _log("Warm-up inference...")
    model.predict({"image": pil_image})

    # Benchmark runs
    _log(f"Running {args.runs} benchmark iterations...")
    times = []
    last_depth_colored = None

    for i in range(args.runs):
        t0 = time.perf_counter()
        prediction = model.predict({"image": pil_image})
        elapsed_ms = (time.perf_counter() - t0) * 1000
        times.append(elapsed_ms)

        if i == 0:
            # Process first result for extraction preview
            output_key = list(prediction.keys())[0]
            depth_map = np.array(prediction[output_key])
            if depth_map.ndim > 2:
                depth_map = np.squeeze(depth_map)
            depth_norm = (depth_map - depth_map.min()) / (depth_map.max() - depth_map.min() + 1e-8)
            depth_uint8 = (depth_norm * 255).astype(np.uint8)
            last_depth_colored = cv2.applyColorMap(depth_uint8, colormap_id)
            last_depth_colored = cv2.resize(last_depth_colored, (original_w, original_h))

    # Compute stats
    import statistics
    times_sorted = sorted(times)
    avg_ms = statistics.mean(times)
    std_ms = statistics.stdev(times) if len(times) > 1 else 0

    result = {
        "model_id": "depth-anything-v2-small",
        "variant_id": variant_id,
        "num_runs": args.runs,
        "successful_runs": len(times),
        "avg_time_ms": round(avg_ms, 2),
        "min_time_ms": round(times_sorted[0], 2),
        "max_time_ms": round(times_sorted[-1], 2),
        "std_time_ms": round(std_ms, 2),
        "fps": round(1000.0 / avg_ms, 2) if avg_ms > 0 else 0,
        "model_load_ms": round(load_time_ms, 2),
        "compute_units": args.compute_units,
    }

    # Encode extraction result as base64 for preview
    if last_depth_colored is not None:
        import base64
        _, buf = cv2.imencode(".jpg", last_depth_colored, [cv2.IMWRITE_JPEG_QUALITY, 85])
        result["extraction_result"] = {
            "success": True,
            "feature_type": "depth_estimation",
            "feature_data": base64.b64encode(buf).decode("ascii"),
            "processing_time": round(times[0], 2),
            "metadata": {
                "model": variant_id,
                "colormap": args.colormap,
                "compute_units": args.compute_units,
                "input_size": list(COREML_INPUT_SIZE),
            },
        }

    _log(f"Benchmark complete: {avg_ms:.1f}ms avg ({result['fps']:.1f} FPS)")
    print(json.dumps(result), flush=True)


if __name__ == "__main__":
    if platform.system() != "Darwin":
        print(json.dumps({"error": "CoreML benchmark requires macOS"}))
        sys.exit(1)

    parser = argparse.ArgumentParser()
    parser.add_argument("--variant", default="DepthAnythingV2SmallF16")
    parser.add_argument("--runs", type=int, default=10)
    parser.add_argument("--colormap", default="viridis")
    parser.add_argument("--compute-units", default="all")
    parser.add_argument("--test-image-url", default="https://ultralytics.com/images/bus.jpg")
    args = parser.parse_args()

    run_benchmark(args)
