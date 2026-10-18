---
name: annotation-data
description: "Dataset annotation management — COCO labels, sequences, export, and Kaggle upload"
version: 1.0.0
entry: scripts/annotation_manager.py
deploy: deploy.sh

parameters:
  - name: datasets_dir
    label: "Datasets Directory"
    type: string
    default: ""
    description: "Root directory for annotation datasets (auto-detected if empty)"
    group: Storage

capabilities:
  live_transform:
    script: scripts/annotation_manager.py
    description: "Dataset CRUD, annotation save/load, COCO export"

ui_unlocks:
  - annotation_studio
---

# Annotation Data Management

Manages annotation datasets for Aegis Annotation Studio. Handles dataset CRUD, label management, COCO-format export, and Kaggle upload.

## Protocol (stdin/stdout JSONL)

### Aegis → Skill
```jsonl
{"command": "list_datasets", "request_id": "req_001"}
{"command": "get_dataset", "name": "my_dataset", "request_id": "req_002"}
{"command": "save_dataset", "name": "my_dataset", "labels": [...], "request_id": "req_003"}
{"command": "delete_dataset", "name": "my_dataset", "request_id": "req_004"}
{"command": "save_annotation", "dataset": "my_dataset", "frame_id": "f1", "annotations": [...], "request_id": "req_005"}
{"command": "list_labels", "dataset": "my_dataset", "request_id": "req_006"}
{"command": "export_coco", "dataset": "my_dataset", "request_id": "req_007"}
{"command": "get_stats", "dataset": "my_dataset", "request_id": "req_008"}
{"command": "stop"}
```

### Skill → Aegis
```jsonl
{"event": "annotation", "type": "ready", "request_id": "", "data": {"version": "1.0.0"}}
{"event": "annotation", "type": "datasets", "request_id": "req_001", "data": [...]}
{"event": "annotation", "type": "dataset", "request_id": "req_002", "data": {...}}
{"event": "annotation", "type": "saved", "request_id": "req_005", "data": {"frame_id": "f1", "count": 3}}
{"event": "annotation", "type": "exported", "request_id": "req_007", "data": {"path": "/path/to/coco.json"}}
```
