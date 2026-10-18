---
name: dataset-annotation
description: "AI-assisted dataset annotation with COCO export — bbox, SAM2, DINOv3 methods"
version: 1.0.0

parameters:
  - name: method
    label: "Annotation Method"
    type: select
    options: ["bbox", "sam2", "dinov3"]
    default: "dinov3"
    group: Annotation

  - name: export_format
    label: "Export Format"
    type: select
    options: ["coco", "yolo", "voc"]
    default: "coco"
    group: Export

  - name: auto_detect
    label: "Auto-detect Before Annotation"
    type: boolean
    default: true
    description: "Run detection first, then human corrects"
    group: Annotation

  - name: detection_model
    label: "Detection Model"
    type: select
    options: ["yolov8n", "yolov11n", "dinov3"]
    default: "yolov8n"
    group: Annotation

  - name: dataset_dir
    label: "Dataset Directory"
    type: string
    default: "~/datasets"
    group: Storage

capabilities:
  annotation:
    script: scripts/annotate.py
    description: "Dataset annotation with AI assistance and COCO export"
---

# Dataset Annotation

AI-assisted dataset creation for training custom detection models. Supports three annotation methods with COCO format export.

## What You Get

- **BBox annotation** — draw bounding boxes, AI auto-suggests
- **SAM2 annotation** — click to segment, get pixel-perfect masks
- **DINOv3 annotation** — click a patch, find similar objects across frames via visual grounding
- **Object tracking** — annotate keyframes, DINOv3 interpolates across the video
- **COCO export** — standard `images[]`, `annotations[]`, `categories[]` format
- **Kaggle/HuggingFace upload** — push datasets directly to platforms

## Annotation Loop

```
1. Feed frames from clips → auto-detect objects
2. Human reviews → corrects bboxes, adds labels
3. Save as COCO dataset
4. Train improved model
5. Repeat with better auto-detection
```

## Protocol

### Aegis → Skill (stdin)
```jsonl
{"event": "frame", "camera_id": "...", "frame_path": "/tmp/frame.jpg", "frame_number": 0, "width": 1920, "height": 1080}
{"event": "detections", "frame_number": 0, "detections": [{"class": "person", "bbox": [100, 50, 200, 350], "confidence": 0.9, "track_id": "t1"}]}
{"event": "save_dataset", "name": "front_door_people", "format": "coco"}
```

### Skill → Aegis (stdout)
```jsonl
{"event": "ready", "methods": ["bbox", "sam2", "dinov3"], "export_formats": ["coco", "yolo", "voc"]}
{"event": "annotation", "frame_number": 0, "annotations": [{"category": "person", "bbox": [100, 50, 200, 350], "track_id": "t1", "is_keyframe": true}]}
{"event": "dataset_saved", "format": "coco", "path": "~/datasets/front_door_people/", "stats": {"images": 150, "annotations": 423, "categories": 5}}
```

## Setup

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```
