#!/usr/bin/env python3
"""
Annotation Data Management Skill — Dataset CRUD via JSONL protocol.

Manages annotation datasets, labels, sequences, COCO export.
Replaces the REST-based annotation_dataset_api.py.

Protocol (JSONL over stdin/stdout):
  stdin:  {"command": "list_datasets|get_dataset|save_annotation|...", ...}
  stdout: {"event": "annotation", "type": "...", "request_id": "...", "data": ...}
"""

import sys
import json
import os
import time
import shutil
import argparse
import signal
from pathlib import Path
from datetime import datetime


# ───────────────────────────────────────────────────────────────────────────────
# Stdout protocol
# ───────────────────────────────────────────────────────────────────────────────

def emit(obj):
    """Write a JSON object to stdout for Aegis to parse."""
    sys.stdout.write(json.dumps(obj, default=str) + "\n")
    sys.stdout.flush()

def log(msg):
    """Write a log message to stderr."""
    sys.stderr.write(f"[annotation-data] {msg}\n")
    sys.stderr.flush()

def emit_result(type_: str, request_id: str, data=None, error=None):
    """Emit an annotation event."""
    event = {
        "event": "annotation",
        "type": type_,
        "request_id": request_id,
    }
    if data is not None:
        event["data"] = data
    if error is not None:
        event["error"] = error
    emit(event)


# ───────────────────────────────────────────────────────────────────────────────
# Dataset manager
# ───────────────────────────────────────────────────────────────────────────────

class DatasetManager:
    """Manages JSONL-based annotation datasets on disk."""

    def __init__(self, root_dir: Path):
        self.root = root_dir
        self.root.mkdir(parents=True, exist_ok=True)
        log(f"Dataset root: {self.root}")

    def list_datasets(self) -> list:
        """Return list of dataset metadata."""
        datasets = []
        for d in sorted(self.root.iterdir()):
            if d.is_dir() and (d / "meta.json").exists():
                try:
                    meta = json.loads((d / "meta.json").read_text())
                    meta["name"] = d.name
                    # Count annotations
                    annot_file = d / "annotations.jsonl"
                    meta["annotation_count"] = sum(1 for _ in open(annot_file)) if annot_file.exists() else 0
                    datasets.append(meta)
                except Exception as e:
                    log(f"Skipping {d.name}: {e}")
        return datasets

    def get_dataset(self, name: str) -> dict:
        """Get full dataset details + annotations."""
        ds_dir = self.root / name
        if not ds_dir.exists():
            raise FileNotFoundError(f"Dataset '{name}' not found")
        meta = json.loads((ds_dir / "meta.json").read_text())
        meta["name"] = name
        # Load annotations
        annot_file = ds_dir / "annotations.jsonl"
        annotations = []
        if annot_file.exists():
            with open(annot_file) as f:
                for line in f:
                    line = line.strip()
                    if line:
                        annotations.append(json.loads(line))
        meta["annotations"] = annotations
        return meta

    def save_dataset(self, name: str, labels: list = None, description: str = "") -> dict:
        """Create or update dataset metadata."""
        ds_dir = self.root / name
        ds_dir.mkdir(parents=True, exist_ok=True)
        meta_file = ds_dir / "meta.json"
        if meta_file.exists():
            meta = json.loads(meta_file.read_text())
        else:
            meta = {
                "created": datetime.now().isoformat(),
                "format": "jsonl",
            }
        meta["updated"] = datetime.now().isoformat()
        if labels is not None:
            meta["labels"] = labels
        if description:
            meta["description"] = description
        meta_file.write_text(json.dumps(meta, indent=2, default=str))
        return {"name": name, "updated": meta["updated"]}

    def delete_dataset(self, name: str) -> dict:
        """Delete a dataset directory."""
        ds_dir = self.root / name
        if ds_dir.exists():
            shutil.rmtree(ds_dir)
            return {"name": name, "deleted": True}
        raise FileNotFoundError(f"Dataset '{name}' not found")

    def save_annotation(self, dataset: str, frame_id: str, annotations: list) -> dict:
        """Append annotations for a frame (JSONL append)."""
        ds_dir = self.root / dataset
        if not ds_dir.exists():
            raise FileNotFoundError(f"Dataset '{dataset}' not found")
        annot_file = ds_dir / "annotations.jsonl"
        record = {
            "frame_id": frame_id,
            "timestamp": datetime.now().isoformat(),
            "annotations": annotations,
        }
        with open(annot_file, "a") as f:
            f.write(json.dumps(record, default=str) + "\n")
        return {"frame_id": frame_id, "count": len(annotations)}

    def list_labels(self, dataset: str) -> list:
        """Get labels for a dataset."""
        ds_dir = self.root / dataset
        if not ds_dir.exists():
            raise FileNotFoundError(f"Dataset '{dataset}' not found")
        meta = json.loads((ds_dir / "meta.json").read_text())
        return meta.get("labels", [])

    def get_stats(self, dataset: str) -> dict:
        """Get annotation statistics for a dataset."""
        ds_dir = self.root / dataset
        if not ds_dir.exists():
            raise FileNotFoundError(f"Dataset '{dataset}' not found")
        annot_file = ds_dir / "annotations.jsonl"
        total_frames = 0
        total_annotations = 0
        label_counts = {}
        if annot_file.exists():
            with open(annot_file) as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    record = json.loads(line)
                    total_frames += 1
                    for ann in record.get("annotations", []):
                        total_annotations += 1
                        label = ann.get("label", "unknown")
                        label_counts[label] = label_counts.get(label, 0) + 1
        return {
            "total_frames": total_frames,
            "total_annotations": total_annotations,
            "label_counts": label_counts,
        }

    def export_coco(self, dataset: str) -> dict:
        """Export dataset to COCO JSON format."""
        ds_dir = self.root / dataset
        if not ds_dir.exists():
            raise FileNotFoundError(f"Dataset '{dataset}' not found")
        meta = json.loads((ds_dir / "meta.json").read_text())
        labels = meta.get("labels", [])
        # Build COCO structure
        coco = {
            "info": {
                "description": meta.get("description", dataset),
                "version": "1.0",
                "year": datetime.now().year,
                "date_created": datetime.now().isoformat(),
            },
            "categories": [
                {"id": i + 1, "name": label, "supercategory": ""}
                for i, label in enumerate(labels)
            ],
            "images": [],
            "annotations": [],
        }
        label_to_id = {label: i + 1 for i, label in enumerate(labels)}
        image_id = 0
        ann_id = 0
        annot_file = ds_dir / "annotations.jsonl"
        if annot_file.exists():
            with open(annot_file) as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    record = json.loads(line)
                    image_id += 1
                    coco["images"].append({
                        "id": image_id,
                        "file_name": record.get("frame_id", f"frame_{image_id}"),
                        "width": record.get("width", 0),
                        "height": record.get("height", 0),
                    })
                    for ann in record.get("annotations", []):
                        ann_id += 1
                        bbox = ann.get("bbox", [0, 0, 0, 0])
                        coco["annotations"].append({
                            "id": ann_id,
                            "image_id": image_id,
                            "category_id": label_to_id.get(ann.get("label", ""), 0),
                            "bbox": bbox,
                            "area": bbox[2] * bbox[3] if len(bbox) == 4 else 0,
                            "segmentation": ann.get("segmentation", []),
                            "iscrowd": 0,
                        })
        export_path = str(ds_dir / "coco_export.json")
        with open(export_path, "w") as f:
            json.dump(coco, f, indent=2, default=str)
        return {
            "path": export_path,
            "images": len(coco["images"]),
            "annotations": len(coco["annotations"]),
            "categories": len(coco["categories"]),
        }


# ───────────────────────────────────────────────────────────────────────────────
# Main loop
# ───────────────────────────────────────────────────────────────────────────────

def parse_args():
    parser = argparse.ArgumentParser(description="Annotation Data Management")
    parser.add_argument("--config", type=str)
    parser.add_argument("--datasets-dir", type=str, default="")
    return parser.parse_args()


def main():
    args = parse_args()

    # Determine datasets directory
    datasets_dir = args.datasets_dir
    if not datasets_dir:
        env_params = os.environ.get("AEGIS_SKILL_PARAMS")
        if env_params:
            try:
                params = json.loads(env_params)
                datasets_dir = params.get("datasets_dir", "")
            except json.JSONDecodeError:
                pass
    if not datasets_dir:
        # Default: ~/.aegis/datasets
        datasets_dir = str(Path.home() / ".aegis" / "datasets")

    manager = DatasetManager(Path(datasets_dir))

    # Handle graceful shutdown
    signal.signal(signal.SIGINT, lambda *_: sys.exit(0))
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))

    # Emit ready
    emit_result("ready", "", data={
        "version": "1.0.0",
        "datasets_dir": datasets_dir,
    })
    log("Ready")

    # Main JSONL command loop
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            log(f"Invalid JSON: {line[:100]}")
            continue

        cmd = msg.get("command", "")
        req_id = msg.get("request_id", "")

        if cmd == "stop":
            break

        try:
            if cmd == "list_datasets":
                data = manager.list_datasets()
                emit_result("datasets", req_id, data=data)

            elif cmd == "get_dataset":
                data = manager.get_dataset(msg["name"])
                emit_result("dataset", req_id, data=data)

            elif cmd == "save_dataset":
                data = manager.save_dataset(
                    msg["name"],
                    labels=msg.get("labels"),
                    description=msg.get("description", ""),
                )
                emit_result("dataset_saved", req_id, data=data)

            elif cmd == "delete_dataset":
                data = manager.delete_dataset(msg["name"])
                emit_result("dataset_deleted", req_id, data=data)

            elif cmd == "save_annotation":
                data = manager.save_annotation(
                    msg["dataset"],
                    msg["frame_id"],
                    msg.get("annotations", []),
                )
                emit_result("annotation_saved", req_id, data=data)

            elif cmd == "list_labels":
                data = manager.list_labels(msg["dataset"])
                emit_result("labels", req_id, data=data)

            elif cmd == "get_stats":
                data = manager.get_stats(msg["dataset"])
                emit_result("stats", req_id, data=data)

            elif cmd == "export_coco":
                data = manager.export_coco(msg["dataset"])
                emit_result("exported", req_id, data=data)

            else:
                emit_result("error", req_id, error=f"Unknown command: {cmd}")

        except FileNotFoundError as e:
            emit_result("error", req_id, error=str(e))
        except Exception as e:
            log(f"Error handling {cmd}: {e}")
            emit_result("error", req_id, error=str(e))


if __name__ == "__main__":
    main()
