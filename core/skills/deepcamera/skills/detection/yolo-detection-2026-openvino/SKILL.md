---
name: yolo-detection-2026-openvino
description: "OpenVINO — real-time object detection via Docker (NCS2, Intel GPU, CPU)"
version: 1.0.0
icon: assets/icon.png
entry: scripts/detect.py
deploy: deploy.sh
runtime: docker

requirements:
  docker: ">=20.10"
  platforms: ["linux", "macos", "windows"]

parameters:
  - name: auto_start
    label: "Auto Start"
    type: boolean
    default: false
    description: "Start this skill automatically when Aegis launches"
    group: Lifecycle

  - name: confidence
    label: "Confidence Threshold"
    type: number
    min: 0.1
    max: 1.0
    default: 0.5
    description: "Minimum detection confidence (0.1–1.0)"
    group: Model

  - name: classes
    label: "Detect Classes"
    type: string
    default: "person,car,dog,cat"
    description: "Comma-separated COCO class names (80 classes available)"
    group: Model

  - name: fps
    label: "Processing FPS"
    type: select
    options: [0.2, 0.5, 1, 3, 5, 15]
    default: 5
    description: "Frames per second — OpenVINO on GPU/NCS2 handles 15+ FPS"
    group: Performance

  - name: input_size
    label: "Input Resolution"
    type: select
    options: [320, 640]
    default: 640
    description: "640 is recommended for GPU/CPU accuracy, 320 for fastest inference"
    group: Performance

  - name: device
    label: "Inference Device"
    type: select
    options: ["AUTO", "CPU", "GPU", "MYRIAD"]
    default: "AUTO"
    description: "AUTO lets OpenVINO pick the fastest available device"
    group: Performance

  - name: precision
    label: "Model Precision"
    type: select
    options: ["FP16", "INT8", "FP32"]
    default: "FP16"
    description: "FP16 is fastest on GPU/NCS2; INT8 is fastest on CPU; FP32 is most accurate"
    group: Performance

capabilities:
  live_detection:
    script: scripts/detect.py
    description: "Real-time object detection via OpenVINO runtime"

category: detection
mutex: detection
---

# OpenVINO Object Detection

Real-time object detection using Intel OpenVINO runtime. Runs inside Docker for cross-platform support. Supports Intel NCS2 USB stick, Intel integrated GPU, Intel Arc discrete GPU, and any x86_64 CPU.

## Requirements

- **Docker Desktop 4.35+** (all platforms)
- **Optional hardware**: Intel NCS2 USB, Intel iGPU, Intel Arc GPU
- Falls back to CPU if no accelerator present

## How It Works

```
┌─────────────────────────────────────────────────────┐
│ Host (Aegis-AI)                                     │
│   frame.jpg → /tmp/aegis_detection/                 │
│   stdin  ──→ ┌──────────────────────────────┐       │
│              │ Docker Container              │       │
│              │   detect.py                   │       │
│              │   ├─ loads OpenVINO IR model   │       │
│              │   ├─ reads frame from volume   │       │
│              │   └─ runs inference on device  │       │
│   stdout ←── │   → JSONL detections          │       │
│              └──────────────────────────────┘       │
│   USB ──→ /dev/bus/usb (NCS2)                       │
│   DRI ──→ /dev/dri (Intel GPU)                      │
└─────────────────────────────────────────────────────┘
```

1. Aegis writes camera frame JPEG to shared `/tmp/aegis_detection/` volume
2. Sends `frame` event via stdin JSONL to Docker container
3. `detect.py` reads frame, runs inference via OpenVINO
4. Returns `detections` event via stdout JSONL
5. Same protocol as `yolo-detection-2026` — Aegis sees no difference

## Platform Setup

### Linux
```bash
# Intel GPU and NCS2 auto-detected via /dev/dri and /dev/bus/usb
# Docker uses --device flags for direct device access
./deploy.sh
```

### macOS (Docker Desktop 4.35+)
```bash
# Docker Desktop USB/IP handles NCS2 passthrough
# CPU fallback always available
./deploy.sh
```

### Windows
```powershell
# Docker Desktop 4.35+ with USB/IP support
# Or WSL2 backend with usbipd-win for NCS2
.\deploy.bat
```

## Model

Ships without a pre-compiled model by default. On first run, `detect.py` will auto-download `yolo26n.pt` and export to OpenVINO IR format. To pre-export:

```bash
# Runs on any platform (unlike Edge TPU compilation)
python scripts/compile_model.py --model yolo26n --size 640 --precision FP16
```

## Supported Devices

| Device | Flag | Precision | ~Speed |
|--------|------|-----------|--------|
| Intel NCS2 | `MYRIAD` | FP16 | ~15ms |
| Intel iGPU | `GPU` | FP16/INT8 | ~8ms |
| Intel Arc | `GPU` | FP16/INT8 | ~4ms |
| Any CPU | `CPU` | FP32/INT8 | ~25ms |
| Auto | `AUTO` | Best | Auto |

## Protocol

Same JSONL as `yolo-detection-2026`:

### Skill → Aegis (stdout)
```jsonl
{"event": "ready", "model": "yolo26n_openvino", "device": "GPU", "format": "openvino_ir", "classes": 80}
{"event": "detections", "frame_id": 42, "camera_id": "front_door", "objects": [{"class": "person", "confidence": 0.85, "bbox": [100, 50, 300, 400]}]}
{"event": "perf_stats", "total_frames": 50, "timings_ms": {"inference": {"avg": 8.1, "p50": 7.9, "p95": 10.2}}}
```

### Bounding Box Format
`[x_min, y_min, x_max, y_max]` — pixel coordinates (xyxy).

## Installation

```bash
./deploy.sh
```

The deployer builds the Docker image locally, probes for OpenVINO devices, and sets the runtime command. No packages pulled from external registries beyond Docker base images and pip dependencies.
