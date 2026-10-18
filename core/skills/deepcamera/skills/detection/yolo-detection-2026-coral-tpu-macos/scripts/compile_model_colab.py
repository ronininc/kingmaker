#!/usr/bin/env python3
"""
Google Colab / Kaggle — Compile YOLO26n for Coral Edge TPU

YOLO26n (released Jan 2026) auto-downloads from Ultralytics.
Uses `format="edgetpu"` which handles:
  TFLite INT8 quantization + edgetpu_compiler in one step.

Usage (Colab):
  1. Open https://colab.research.google.com
  2. New notebook → paste this into a cell → Run all
  3. Download the compiled _edgetpu.tflite model

Usage (Kaggle):
  1. New notebook → Internet ON, GPU not needed
  2. Paste into cell → Run
"""

# ─── Step 1: Install dependencies ────────────────────────────────────────────
import subprocess, sys, os

print("=" * 60)
print("Step 1/3: Installing Ultralytics + Edge TPU compiler...")
print("=" * 60)

subprocess.check_call([sys.executable, "-m", "pip", "install", "-q",
                       "ultralytics>=8.3.0"])

# Install edgetpu_compiler (Colab/Kaggle are x86_64 Linux)
subprocess.run(["bash", "-c", """
    curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | apt-key add - 2>/dev/null
    echo "deb https://packages.cloud.google.com/apt coral-edgetpu-stable main" \
        > /etc/apt/sources.list.d/coral-edgetpu.list
    apt-get update -qq
    apt-get install -y -qq edgetpu-compiler
"""], check=True)
print("✓ Dependencies ready\n")

# ─── Step 2: Export YOLO26n to Edge TPU ──────────────────────────────────────
print("=" * 60)
print("Step 2/3: Downloading YOLO26n + exporting to Edge TPU...")
print("  (auto-download from Ultralytics → INT8 quantize → edgetpu compile)")
print("=" * 60)

from ultralytics import YOLO

# YOLO26n auto-downloads from Ultralytics hub (released Jan 2026)
model = YOLO("yolo26n.pt")

# format="edgetpu" = PT → TFLite INT8 → edgetpu_compiler → _edgetpu.tflite
edgetpu_model = model.export(format="edgetpu", imgsz=320)

print(f"\n✓ Edge TPU model: {edgetpu_model}")
size_mb = os.path.getsize(str(edgetpu_model)) / (1024 * 1024)
print(f"  Size: {size_mb:.1f} MB")

# ─── Step 3: Download ───────────────────────────────────────────────────────
print("\n" + "=" * 60)
print("Step 3/3: Download compiled model")
print("=" * 60)

import glob
edgetpu_files = glob.glob("**/*_edgetpu.tflite", recursive=True)
print(f"Found {len(edgetpu_files)} compiled model(s):")
for f in edgetpu_files:
    sz = os.path.getsize(f) / (1024 * 1024)
    print(f"  {f} ({sz:.1f} MB)")

try:
    from google.colab import files
    for f in edgetpu_files:
        files.download(f)
    print("\n✓ Download started — check your browser downloads")
except ImportError:
    print("\nKaggle: use the Output tab, or:")
    for f in edgetpu_files:
        print(f"  from IPython.display import FileLink; display(FileLink('{f}'))")

print("\n" + "=" * 60)
print("Copy the _edgetpu.tflite file to:")
print("  skills/detection/yolo-detection-2026-coral-tpu/models/")
print("=" * 60)
