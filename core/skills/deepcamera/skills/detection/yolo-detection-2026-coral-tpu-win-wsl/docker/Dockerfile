# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
# Coral Edge TPU Model Compiler
#
# Compiles YOLO 2026 nano to Google Coral Edge TPU .tflite format using
# ultralytics' built-in format="edgetpu" export pipeline.
#
# Per https://docs.ultralytics.com/guides/coral-edge-tpu-on-raspberry-pi/:
#   model.export(format="edgetpu") handles the full pipeline:
#   .pt → ONNX → onnx2tf SavedModel → TFLite INT8 → edgetpu_compiler
#
# MUST run on linux/amd64 — edgetpu_compiler is x86_64 Linux only.
# On Apple Silicon or Windows, Docker Desktop handles QEMU emulation.
# ─────────────────────────────────────────────────────────────────────────────

FROM --platform=linux/amd64 python:3.11-slim

LABEL maintainer="Aegis-AI / DeepCamera"
LABEL description="Compiles YOLO 2026 to Google Coral Edge TPU .tflite"

# ── System deps ───────────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
        gnupg \
        apt-transport-https \
        ca-certificates \
        libgl1 \
        libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# ── edgetpu_compiler from Google Coral apt (x86_64 only) ─────────────────────
RUN curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg \
        | gpg --dearmor -o /usr/share/keyrings/coral-edgetpu.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/coral-edgetpu.gpg] \
        https://packages.cloud.google.com/apt coral-edgetpu-stable main" \
        > /etc/apt/sources.list.d/coral-edgetpu.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends edgetpu-compiler \
    && rm -rf /var/lib/apt/lists/*

# ── Python: ultralytics handles all TF/onnx2tf version management ─────────────
# ultralytics auto-installs: onnx2tf, tensorflow-cpu, onnxslim, etc.
RUN pip install --no-cache-dir \
        "ultralytics>=8.3.0" \
        "numpy>=1.24.0,<2.0"

# ── Copy compile entrypoint ───────────────────────────────────────────────────
WORKDIR /compile
COPY scripts/compile_model.py /compile/compile_model.py

# ── Output volume (mount skill's models/ directory here) ──────────────────────
VOLUME ["/compile/output"]

# ── Entrypoint ────────────────────────────────────────────────────────────────
ENTRYPOINT ["python", "/compile/compile_model.py"]
CMD ["--model", "yolo26n", "--size", "320", "--output", "/compile/output"]
