---
name: segmentation-sam2
description: "Interactive click-to-segment using Segment Anything 2 — AI-assisted labeling for Annotation Studio"
version: 1.0.0
entry: scripts/segment.py
deploy: deploy.sh

parameters:
  - name: model
    label: "SAM2 Model"
    type: select
    options: ["sam2-tiny", "sam2-small", "sam2-base", "sam2-large"]
    default: "sam2-small"
    group: Model

  - name: device
    label: "Device"
    type: select
    options: ["auto", "cpu", "cuda", "mps"]
    default: "auto"
    group: Performance

capabilities:
  live_transform:
    script: scripts/segment.py
    description: "Interactive segmentation on frames"

---

# SAM2 Interactive Segmentation

Click anywhere on a video frame to segment objects using Meta's Segment Anything 2. Generates pixel-perfect masks for annotation, tracking, and dataset creation.

## What You Get

- **Click-to-segment** — click on any object to get its mask
- **Point & box prompts** — positive/negative points and bounding box selection
- **Video tracking** — segment in one frame, propagate across the clip
- **Annotation Studio** — full integration with sidebar Annotation Studio

## Protocol

Communicates via **JSON lines** over stdin/stdout.

### Aegis → Skill (stdin)
```jsonl
{"event": "frame", "frame_path": "/tmp/frame.jpg", "frame_id": "frame_1", "request_id": "req_001"}
{"command": "segment", "points": [{"x": 450, "y": 320, "label": 1}], "request_id": "req_002"}
{"command": "track", "frame_path": "/tmp/frame2.jpg", "frame_id": "frame_2", "request_id": "req_003"}
{"command": "stop"}
```

### Skill → Aegis (stdout)
```jsonl
{"event": "segmentation", "type": "ready", "request_id": "", "data": {"model": "sam2-small", "device": "mps"}}
{"event": "segmentation", "type": "encoded", "request_id": "req_001", "data": {"frame_id": "frame_1", "width": 1920, "height": 1080}}
{"event": "segmentation", "type": "segmented", "request_id": "req_002", "data": {"mask_path": "/tmp/mask.png", "mask_b64": "...", "score": 0.95, "bbox": [100, 50, 350, 420]}}
{"event": "segmentation", "type": "tracked", "request_id": "req_003", "data": {"frame_id": "frame_2", "mask_path": "/tmp/track.png", "score": 0.93}}
```

## Installation

The `deploy.sh` bootstrapper handles everything — Python environment, GPU detection, dependency installation, and model download. No manual setup required.

```bash
./deploy.sh
```
