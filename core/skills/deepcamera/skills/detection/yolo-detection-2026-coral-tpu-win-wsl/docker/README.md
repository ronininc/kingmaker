# Coral Edge TPU Model Compiler — Docker

Converts the YOLO 2026 nano model to Google Coral Edge TPU format using
a Docker container (so `edgetpu_compiler` runs on Linux x86_64, even from
Windows or Apple Silicon machines).

## Pipeline

```
yolo26n.pt  →  [ultralytics export INT8]  →  yolo26n_int8.tflite
           →  [edgetpu_compiler]          →  yolo26n_int8_edgetpu.tflite
```

The compiled `.tflite` file is written to `../models/` and then committed
to the git repository so `deploy.bat` / `deploy.sh` can pick it up without
needing to compile again.

## Requirements

- Docker Desktop (Windows / macOS) or Docker Engine (Linux)
- Internet access on first run (downloads `yolo26n.pt` from ultralytics + base image)
- On Windows: Docker Desktop with WSL2 backend recommended

## Quick Start

### Option A — Shell script (Linux / macOS / Git Bash on Windows)

```bash
bash docker/compile.sh
```

### Option B — Docker Compose

```bash
# From the skill root (yolo-detection-2026-coral-tpu/)
docker compose -f docker/docker-compose.yml run --rm coral-compiler
```

### Option C — Raw Docker commands

```bash
# Build
docker build --platform linux/amd64 -t coral-tpu-compiler -f docker/Dockerfile .

# Run (mounts models/ as output)
docker run --rm --platform linux/amd64 \
  -v "$(pwd)/models:/compile/output" \
  coral-tpu-compiler \
  --model yolo26n --size 320 --output /compile/output
```

## Output Files

After compilation, `models/` will contain:

| File | Size | Notes |
|------|------|-------|
| `yolo26n_int8.tflite` | ~3–4 MB | Full-integer quantized (CPU fallback) |
| `yolo26n_int8_edgetpu.tflite` | ~3–4 MB | Compiled for Edge TPU (primary model) |

> **Note**: `edgetpu_compiler` may warn that some YOLO operations are not mapped
> to the Edge TPU and will fall back to CPU. This is expected for larger YOLO
> architectures with complex postprocessing. The 320×320 nano model achieves
> ~100% on-chip mapping.

## Committing the Model

```bash
git add models/*.tflite
git commit -m "feat(coral-tpu): add compiled yolo26n edgetpu model (320x320 INT8)"
git push
```

## Recompiling

If you update the YOLO model or want a 640×640 version:

```bash
# 640×640 version
bash docker/compile.sh --model yolo26n --size 640

# Small model
bash docker/compile.sh --model yolo26s --size 320
```
