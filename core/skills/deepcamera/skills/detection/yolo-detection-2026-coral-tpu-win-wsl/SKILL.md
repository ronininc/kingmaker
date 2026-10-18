---
name: yolo-detection-2026-coral-tpu-win-wsl
description: "Google Coral Edge TPU — real-time object detection natively via Windows WSL"
version: 1.0.0
icon: assets/icon.png
entry: scripts/wsl_wrapper.cjs
deploy:
  windows: deploy.bat
runtime: wsl-python

requirements:
  platforms: ["windows"]



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
    description: "Real-time object detection on live camera frames via Edge TPU inside WSL"

category: detection
mutex: detection
---

# Coral TPU Object Detection (Windows WSL)

Real-time object detection natively utilizing the Google Coral Edge TPU accelerator on your local hardware via Windows Subsystem for Linux (WSL). Detects 80 COCO classes (person, car, dog, cat, etc.) with ~4ms inference on 320x320 input.

## Requirements

- **Google Coral USB Accelerator** (USB 3.0 port recommended)
- **WSL2** installed and running on Windows
- `usbipd-win` installed on the Windows host

## How It Works

```
┌─────────────────────────────────────────────────────┐
│ Host (Aegis-AI on Windows)                          │
│   frame.jpg → /tmp/aegis_detection/                 │
│   stdin  ──→ ┌──────────────────────────────┐       │
│              │ WSL Container / Environment   │       │
│              │   detect.py                   │       │
│              │   ├─ loads _edgetpu.tflite     │       │
│              │   ├─ reads frame from disk     │       │
│              │   └─ runs inference on TPU    │       │
│   stdout ←── │   → JSONL detections          │       │
│              └──────────────────────────────┘       │
│   USB ──→ usbipd-win bridge to WSL                  │
└─────────────────────────────────────────────────────┘
```

1. Aegis writes camera frame JPEG to shared `/tmp/aegis_detection/` workspace
2. Sends `frame` event via stdin JSONL to the WSL Python instance
3. `detect.py` invokes PyCoral and executes natively on the mapped USB Edge TPU inside Linux
4. Returns `detections` event via stdout JSONL back to Windows Host

## Performance

| Input Size | Inference | On-chip | Notes |
|-----------|-----------|---------|-------|
| 320x320 | ~4ms | 100% | Fully on TPU, best for real-time |
| 640x640 | ~20ms | Partial | Some layers on CPU (model segmented) |

> **Cooling**: The USB Accelerator aluminum case acts as a heatsink. If too hot to touch during continuous inference, it will thermal-throttle. Consider active cooling or `clock_speed: standard`.

## Installation

### Windows (WSL)
Run `deploy.bat` — this will:
1. Verify `usbipd` is installed and bind the `18d1:9302` and `1a6e:089a` Edge TPU hardware IDs.
2. Setup a Python virtual environment exclusively within WSL.
3. Install the Edge TPU libraries and dependencies within the WSL boundary.
4. Auto-attach the device using `usbipd` seamlessly during invocation.
