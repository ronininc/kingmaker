#!/usr/bin/env python3
"""
Local OpenVINO Model Export — compile YOLO26n to OpenVINO IR format.

Unlike Edge TPU compilation, OpenVINO export runs on ANY platform
(x86_64, ARM64, macOS, Linux, Windows). No special hardware needed.

Usage:
  python scripts/compile_model.py --model yolo26n --size 640 --precision FP16
  python scripts/compile_model.py --model yolo26s --size 640 --precision INT8 --output models/
"""

import argparse
import os
import shutil
import sys
import time


def main():
    parser = argparse.ArgumentParser(
        description="Export YOLO model to OpenVINO IR format"
    )
    parser.add_argument(
        "--model", default="yolo26n",
        help="YOLO model name (e.g., yolo26n, yolo26s). Auto-downloads from Ultralytics."
    )
    parser.add_argument(
        "--size", type=int, default=640,
        help="Input image size (default: 640)"
    )
    parser.add_argument(
        "--precision", choices=["FP16", "INT8", "FP32"], default="FP16",
        help="Model precision: FP16 (GPU/NCS2), INT8 (CPU), FP32 (accuracy)"
    )
    parser.add_argument(
        "--output", default=None,
        help="Output directory (default: alongside the .pt file)"
    )
    args = parser.parse_args()

    # ─── Step 1: Install check ──────────────────────────────────────────────
    print("=" * 60)
    print(f"Step 1/3: Loading {args.model}...")
    print("=" * 60)

    try:
        from ultralytics import YOLO
    except ImportError:
        print("ERROR: ultralytics not installed.")
        print("  pip install ultralytics>=8.3.0 openvino>=2024.0")
        sys.exit(1)

    try:
        import openvino  # noqa: F401
    except ImportError:
        print("ERROR: openvino not installed.")
        print("  pip install openvino>=2024.0")
        sys.exit(1)

    # ─── Step 2: Download + Export ──────────────────────────────────────────
    model_name = f"{args.model}.pt"
    print(f"\nDownloading {model_name} from Ultralytics hub...")
    model = YOLO(model_name)

    print("\n" + "=" * 60)
    print(f"Step 2/3: Exporting to OpenVINO IR ({args.precision}, {args.size}×{args.size})...")
    print("=" * 60)

    t0 = time.perf_counter()

    half = args.precision == "FP16"
    int8 = args.precision == "INT8"

    export_path = model.export(
        format="openvino",
        imgsz=args.size,
        half=half,
        int8=int8,
    )

    elapsed = time.perf_counter() - t0
    print(f"\n✓ Export completed in {elapsed:.1f}s")
    print(f"  Output: {export_path}")

    # ─── Step 3: Copy to output ────────────────────────────────────────────
    if args.output:
        print("\n" + "=" * 60)
        print(f"Step 3/3: Copying to {args.output}...")
        print("=" * 60)

        os.makedirs(args.output, exist_ok=True)
        dest = os.path.join(args.output, os.path.basename(str(export_path)))

        if os.path.exists(dest):
            shutil.rmtree(dest)
        shutil.copytree(str(export_path), dest)
        print(f"✓ Model copied to: {dest}")
    else:
        print("\nStep 3/3: Skipped (no --output specified)")
        print(f"  Model is at: {export_path}")

    # Summary
    files = os.listdir(str(export_path))
    total_size = sum(
        os.path.getsize(os.path.join(str(export_path), f))
        for f in files
    ) / (1024 * 1024)

    print("\n" + "=" * 60)
    print(f"✓ {args.model} exported to OpenVINO IR ({args.precision})")
    print(f"  Size: {total_size:.1f} MB")
    print(f"  Files: {files}")
    print(f"\nCopy the _openvino_model/ folder to:")
    print(f"  skills/detection/yolo-detection-2026-openvino/models/")
    print("=" * 60)


if __name__ == "__main__":
    main()
