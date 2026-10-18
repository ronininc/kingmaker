---
name: yolo-detection-2026-coral-tpu-macos
description: "Google Coral Edge TPU — real-time object detection natively (macOS / Linux)"
version: 1.0.0
icon: assets/icon.png
entry: scripts/detect.py
deploy:
  linux: deploy.sh
  macos: deploy.sh
runtime: python

requirements:
  platforms: ["linux", "macos"]



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
    description: "Minimum detection confidence — lower than GPU models due to INT8 quantization"
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
    description: "Frames per second — Edge TPU handles 15+ FPS easily"
    group: Performance

  - name: input_size
    label: "Input Resolution"
    type: select
    options: [320, 640]
    default: 320
    description: "320 fits fully on TPU (~4ms), 640 partially on CPU (~20ms)"
    group: Performance

  - name: tpu_device
    label: "TPU Device"
    type: select
    options: ["auto", "0", "1", "2", "3"]
    default: "auto"
    description: "Which Edge TPU to use — auto selects first available"
    group: Performance

  - name: clock_speed
    label: "TPU Clock Speed"
    type: select
    options: ["standard", "max"]
    default: "standard"
    description: "Max is faster but runs hotter — needs active cooling for sustained use"
    group: Performance

capabilities:
  live_detection:
    script: scripts/detect.py
    description: "Real-time object detection on live camera frames via Edge TPU"

category: detection
mutex: detection
---

# Coral TPU Object Detection

Real-time object detection natively utilizing the Google Coral Edge TPU accelerator on your local hardware. Detects 80 COCO classes (person, car, dog, cat, etc.) with ~4ms inference on 320x320 input.

## Requirements

- Python 3.9–3.13

## How It Works

```
┌─────────────────────────────────────────────────────┐
│ Host (Aegis-AI)                                     │
│   frame.jpg → /tmp/aegis_detection/                 │
│   stdin  ──→ ┌──────────────────────────────┐       │
│              │ Native Python Environment     │       │
│              │   detect.py                   │       │
│              │   ├─ loads _edgetpu.tflite     │       │
│              │   ├─ reads frame from disk     │       │
│              │   └─ runs inference on TPU    │       │
│   stdout ←── │   → JSONL detections          │       │
│              └──────────────────────────────┘       │
│   USB ──→ Native System USB / edgetpu drivers       │
└─────────────────────────────────────────────────────┘
```

1. Aegis writes camera frame JPEG to shared `/tmp/aegis_detection/` workspace
2. Sends `frame` event via stdin JSONL to the local Python instance
3. `detect.py` invokes PyCoral and executes natively on the mapped USB Edge TPU
4. Returns `detections` event via stdout JSONL

## Platform Setup

### Linux
```bash
# Uses the official apt-get google-coral packages natively
./deploy.sh
```

### macOS 
```bash
# Downloads and installs the libedgetpu OS payload framework inline
./deploy.sh
```

> **Important Deployment Notice**: The updated `deploy.sh` script will natively halt execution and prompt you securely for your OS `sudo` password to securely register the USB drivers (`libedgetpu`) system-wide. If you refuse the prompt, it gracefully outputs the exact terminal instructions for you to configure it manually.

## Performance

| Input Size | Inference | On-chip | Notes |
|-----------|-----------|---------|-------|
| 320x320 | ~4ms | 100% | Fully on TPU, best for real-time |
| 640x640 | ~20ms | Partial | Some layers on CPU (model segmented) |

> **Cooling**: The USB Accelerator aluminum case acts as a heatsink. If too hot to touch during continuous inference, it will thermal-throttle. Consider active cooling or `clock_speed: standard`.

## Protocol

Same JSONL as `yolo-detection-2026`:

### Skill → Aegis (stdout)
```jsonl
{"event": "ready", "model": "yolo26n_edgetpu", "device": "coral", "format": "edgetpu_tflite", "tpu_count": 1, "classes": 80}
{"event": "detections", "frame_id": 42, "camera_id": "front_door", "objects": [{"class": "person", "confidence": 0.85, "bbox": [100, 50, 300, 400]}]}
{"event": "perf_stats", "total_frames": 50, "timings_ms": {"inference": {"avg": 4.1, "p50": 3.9, "p95": 5.2}}}
```

### Bounding Box Format
`[x_min, y_min, x_max, y_max]` — pixel coordinates (xyxy).

## Installation

### Linux / macOS
```bash
./deploy.sh
```

The deployer builds the local Python virtual environment and installs the Edge TPU runtime. No Docker required.
