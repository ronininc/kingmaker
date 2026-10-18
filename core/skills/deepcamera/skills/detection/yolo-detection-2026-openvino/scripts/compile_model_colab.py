#!/usr/bin/env python3
"""
Google Colab / Kaggle — Export YOLO26n to OpenVINO IR format

YOLO26n (released Jan 2026) auto-downloads from Ultralytics.
Uses `format="openvino"` for direct conversion.

Unlike Edge TPU compilation, OpenVINO export runs on ANY platform
(x86_64, ARM64, macOS, Linux, Windows). This Colab script is provided
for convenience but you can also run it locally.

Usage (Colab):
  1. Open https://colab.research.google.com
  2. New notebook → paste this into a cell → Run all
  3. Download the compiled model

Usage (local):
  pip install ultralytics openvino
  python scripts/compile_model_colab.py
"""

# ─── Step 1: Install dependencies ────────────────────────────────────────────
import subprocess, sys, os

print("=" * 60)
print("Step 1/3: Installing Ultralytics + OpenVINO...")
print("=" * 60)

subprocess.check_call([sys.executable, "-m", "pip", "install", "-q",
                       "ultralytics>=8.3.0", "openvino>=2024.0"])
print("✓ Dependencies ready\n")

# ─── Step 2: Export YOLO26n to OpenVINO ──────────────────────────────────────
print("=" * 60)
print("Step 2/3: Downloading YOLO26n + exporting to OpenVINO IR...")
print("=" * 60)

from ultralytics import YOLO

# YOLO26n auto-downloads from Ultralytics hub
model = YOLO("yolo26n.pt")

# Export FP16 (best for GPU/NCS2)
print("\nExporting FP16 model...")
fp16_path = model.export(format="openvino", imgsz=640, half=True)
print(f"✓ FP16 model: {fp16_path}")

# Optionally export INT8 (best for CPU)
# print("\nExporting INT8 model...")
# int8_path = model.export(format="openvino", imgsz=640, int8=True)
# print(f"✓ INT8 model: {int8_path}")

# ─── Step 3: Download ───────────────────────────────────────────────────────
print("\n" + "=" * 60)
print("Step 3/3: Download compiled model")
print("=" * 60)

import glob, shutil

# Find exported model directory
openvino_dirs = glob.glob("**/*_openvino_model", recursive=True)
print(f"Found {len(openvino_dirs)} model(s):")
for d in openvino_dirs:
    files = os.listdir(d)
    total_size = sum(os.path.getsize(os.path.join(d, f)) for f in files) / (1024 * 1024)
    print(f"  {d}/ ({total_size:.1f} MB) — {files}")

# Zip for download
for d in openvino_dirs:
    zip_name = d.replace("/", "_")
    shutil.make_archive(zip_name, "zip", d)
    print(f"  Zipped: {zip_name}.zip")

try:
    from google.colab import files
    for d in openvino_dirs:
        zip_name = d.replace("/", "_") + ".zip"
        files.download(zip_name)
    print("\n✓ Download started — check your browser")
except ImportError:
    print("\nLocal/Kaggle: model directory is ready at:")
    for d in openvino_dirs:
        print(f"  {d}/")

print("\n" + "=" * 60)
print("Copy the _openvino_model/ folder to:")
print("  skills/detection/yolo-detection-2026-openvino/models/")
print("=" * 60)
