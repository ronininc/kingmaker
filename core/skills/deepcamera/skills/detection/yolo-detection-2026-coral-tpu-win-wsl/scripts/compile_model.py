#!/usr/bin/env python3
"""
Coral TPU Model Compiler — YOLO 2026 → Edge TPU .tflite

Uses ultralytics' built-in format="edgetpu" export, which handles the full
pipeline internally:
  .pt → ONNX → TFLite INT8 (via onnx2tf) → edgetpu_compiler → _edgetpu.tflite

Per the Ultralytics docs (https://docs.ultralytics.com/guides/coral-edge-tpu-on-raspberry-pi/):
  model.export(format="edgetpu")

Output file: <model>_saved_model/<model>_full_integer_quant_edgetpu.tflite
Copied to:   <output_dir>/<model>_full_integer_quant_edgetpu.tflite
             <output_dir>/<model>_full_integer_quant.tflite  (CPU fallback)

Requirements (pre-installed in Docker):
  - ultralytics >= 8.3.0
  - edgetpu_compiler (x86_64 Linux — Google Coral apt package)

Usage:
  python compile_model.py --model yolo26n --size 320 --output /compile/output
  python compile_model.py --model yolo26n --size 640 --output /compile/output
"""

import argparse
import glob
import os
import shutil
import subprocess
import sys
from pathlib import Path


def log(msg):
    print(f"[compile] {msg}", flush=True)


def check_edgetpu_compiler():
    try:
        r = subprocess.run(["edgetpu_compiler", "--version"],
                           capture_output=True, text=True, timeout=10)
        log(f"edgetpu_compiler: {r.stdout.strip()}")
        return True
    except (FileNotFoundError, subprocess.TimeoutExpired):
        log("ERROR: edgetpu_compiler not found.")
        return False


def export_edgetpu(model_name, imgsz, output_dir):
    """
    Export YOLO model using ultralytics format="edgetpu".

    ultralytics handles:
      1. ONNX export
      2. onnx2tf → SavedModel
      3. TFLiteConverter INT8 quantization
      4. edgetpu_compiler

    The only requirement is that edgetpu_compiler is on PATH.
    """
    try:
        from ultralytics import YOLO
    except ImportError:
        log("ERROR: ultralytics not installed.")
        sys.exit(1)

    log(f"Exporting {model_name}.pt → Edge TPU (imgsz={imgsz})...")
    log("This will: download model → ONNX → TFLite INT8 → edgetpu_compiler")
    log("Estimated time: 5-15 minutes on first run (model download + compilation)")

    model = YOLO(f"{model_name}.pt")  # auto-downloads from ultralytics hub
    result = model.export(
        format="edgetpu",
        imgsz=imgsz,
    )
    log(f"Export result: {result}")
    return str(result) if result else None


def collect_outputs(model_name, output_dir):
    """
    Copy compiled .tflite files to output_dir.
    ultralytics saves to: ./<model_name>_saved_model/
    """
    os.makedirs(output_dir, exist_ok=True)
    saved_model_dir = f"{model_name}_saved_model"

    patterns = [
        f"{saved_model_dir}/*_edgetpu.tflite",   # Edge TPU model
        f"{saved_model_dir}/*_full_integer_quant_edgetpu.tflite",
        f"{saved_model_dir}/*_int8.tflite",        # CPU fallback
        f"{saved_model_dir}/*_full_integer_quant.tflite",
    ]

    copied = []
    seen = set()
    for pattern in patterns:
        for src in glob.glob(pattern):
            dest = os.path.join(output_dir, os.path.basename(src))
            if src not in seen:
                shutil.copy2(src, dest)
                size_mb = os.path.getsize(dest) / (1024 * 1024)
                log(f"  {os.path.basename(src)} → {dest} ({size_mb:.1f} MB)")
                copied.append(dest)
                seen.add(src)

    return copied


def main():
    parser = argparse.ArgumentParser(
        description="Compile YOLO 2026 for Coral Edge TPU via ultralytics format='edgetpu'"
    )
    parser.add_argument("--model",  default="yolo26n",
                        help="YOLO model name (yolo26n, yolo26s, yolo26m, ...)")
    parser.add_argument("--size",   type=int, default=320,
                        help="Input image size (default: 320)")
    parser.add_argument("--output", default="/compile/output",
                        help="Output directory for compiled model files")
    args = parser.parse_args()

    output_dir = args.output  # Already absolute from Docker -v mount
    log(f"Model : {args.model}  Size: {args.size}×{args.size}  Output: {output_dir}")

    # Verify edgetpu_compiler is available before starting the long export
    if not check_edgetpu_compiler():
        log("edgetpu_compiler must be on PATH. Inside Docker it is pre-installed.")
        sys.exit(1)

    # Run ultralytics edgetpu export
    export_edgetpu(args.model, args.size, output_dir)

    # Collect and copy output files
    log("Collecting compiled model files...")
    outputs = collect_outputs(args.model, output_dir)

    if not outputs:
        log("ERROR: No .tflite files found after export.")
        log(f"Check {args.model}_saved_model/ for output files.")
        sys.exit(1)

    edgetpu_files = [f for f in outputs if "_edgetpu" in f]
    cpu_files     = [f for f in outputs if "_edgetpu" not in f]

    log("")
    log("✓ Compilation complete!")
    if edgetpu_files:
        log(f"  Edge TPU model : {edgetpu_files[0]}")
    if cpu_files:
        log(f"  CPU fallback   : {cpu_files[0]}")
    log("")
    log("Next steps:")
    log("  git -C /path/to/DeepCamera add skills/detection/yolo-detection-2026-coral-tpu/models/*.tflite")
    log("  git commit -m 'feat(coral-tpu): add compiled yolo26n edgetpu model'")
    log("  git push")


if __name__ == "__main__":
    main()
