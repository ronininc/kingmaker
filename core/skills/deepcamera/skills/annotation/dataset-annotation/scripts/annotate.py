#!/usr/bin/env python3
"""
Dataset Annotation Skill — AI-assisted COCO annotation + export.

Manages annotation datasets, processes frames with detections,
and exports in COCO, YOLO, or VOC format.
"""

import sys
import json
import argparse
import signal
import os
import time
from pathlib import Path
from datetime import datetime


def parse_args():
    parser = argparse.ArgumentParser(description="Dataset Annotation Skill")
    parser.add_argument("--config", type=str)
    parser.add_argument("--method", type=str, default="dinov3", choices=["bbox", "sam2", "dinov3"])
    parser.add_argument("--export-format", type=str, default="coco", choices=["coco", "yolo", "voc"])
    parser.add_argument("--dataset-dir", type=str, default=os.path.expanduser("~/datasets"))
    return parser.parse_args()


def load_config(args):
    if args.config and Path(args.config).exists():
        with open(args.config) as f:
            return json.load(f)
    return {
        "method": args.method,
        "export_format": args.export_format,
        "dataset_dir": args.dataset_dir,
    }


def emit(event):
    print(json.dumps(event), flush=True)


class CocoDatasetManager:
    """Manages COCO format annotation datasets."""

    def __init__(self, dataset_dir):
        self.dataset_dir = Path(dataset_dir)
        self.dataset_dir.mkdir(parents=True, exist_ok=True)
        self.current_dataset = None
        self.annotations = []
        self.images = []
        self.categories = {}
        self._next_ann_id = 1
        self._next_img_id = 1

    def create_dataset(self, name, description=""):
        path = self.dataset_dir / name
        path.mkdir(parents=True, exist_ok=True)
        (path / "images").mkdir(exist_ok=True)
        self.current_dataset = {
            "name": name,
            "path": str(path),
            "description": description,
            "created_at": datetime.now().isoformat(),
        }
        self.annotations = []
        self.images = []
        self.categories = {}
        self._next_ann_id = 1
        self._next_img_id = 1
        return path

    def add_image(self, frame_path, width, height, frame_number=0):
        import shutil
        if not self.current_dataset:
            return None

        dst = Path(self.current_dataset["path"]) / "images" / Path(frame_path).name
        if not dst.exists() and Path(frame_path).exists():
            shutil.copy2(frame_path, dst)

        img_entry = {
            "id": self._next_img_id,
            "file_name": dst.name,
            "width": width,
            "height": height,
            "date_captured": datetime.now().isoformat(),
            "frame_number": frame_number,
        }
        self.images.append(img_entry)
        self._next_img_id += 1
        return img_entry["id"]

    def add_annotation(self, image_id, category, bbox, track_id=None, is_keyframe=False):
        if category not in self.categories:
            cat_id = len(self.categories) + 1
            self.categories[category] = {
                "id": cat_id,
                "name": category,
                "supercategory": "object",
            }

        x, y, w, h = bbox
        ann = {
            "id": self._next_ann_id,
            "image_id": image_id,
            "category_id": self.categories[category]["id"],
            "bbox": [x, y, w, h],
            "area": w * h,
            "iscrowd": 0,
        }
        if track_id:
            ann["tracking_id"] = track_id
        self.annotations.append(ann)
        self._next_ann_id += 1

    def save_coco(self):
        if not self.current_dataset:
            return None

        coco = {
            "info": {
                "description": self.current_dataset.get("description", ""),
                "version": "1.0",
                "year": datetime.now().year,
                "date_created": self.current_dataset["created_at"],
                "contributor": "DeepCamera Annotation Skill",
            },
            "images": self.images,
            "annotations": self.annotations,
            "categories": list(self.categories.values()),
        }

        out_path = Path(self.current_dataset["path"]) / "annotations.json"
        with open(out_path, "w") as f:
            json.dump(coco, f, indent=2)

        return {
            "format": "coco",
            "path": str(self.current_dataset["path"]),
            "stats": {
                "images": len(self.images),
                "annotations": len(self.annotations),
                "categories": len(self.categories),
            },
        }


def main():
    args = parse_args()
    config = load_config(args)

    manager = CocoDatasetManager(config.get("dataset_dir", os.path.expanduser("~/datasets")))

    emit({
        "event": "ready",
        "methods": ["bbox", "sam2", "dinov3"],
        "export_formats": ["coco", "yolo", "voc"],
    })

    running = True
    def handle_signal(s, f):
        nonlocal running
        running = False
    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    for line in sys.stdin:
        if not running:
            break
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue

        if msg.get("command") == "stop":
            break

        event = msg.get("event")

        if event == "create_dataset":
            name = msg.get("name", f"dataset_{int(time.time())}")
            manager.create_dataset(name, msg.get("description", ""))
            emit({"event": "dataset_created", "name": name, "path": str(manager.current_dataset["path"])})

        elif event == "frame":
            if manager.current_dataset is None:
                manager.create_dataset(f"dataset_{int(time.time())}")

            image_id = manager.add_image(
                msg.get("frame_path", ""),
                msg.get("width", 0),
                msg.get("height", 0),
                msg.get("frame_number", 0),
            )
            if image_id:
                emit({"event": "frame_added", "image_id": image_id, "frame_number": msg.get("frame_number", 0)})

        elif event == "annotation":
            for ann in msg.get("annotations", []):
                manager.add_annotation(
                    image_id=msg.get("image_id", len(manager.images)),
                    category=ann.get("category", "object"),
                    bbox=ann.get("bbox", [0, 0, 0, 0]),
                    track_id=ann.get("track_id"),
                    is_keyframe=ann.get("is_keyframe", False),
                )
            emit({"event": "annotations_saved", "count": len(msg.get("annotations", []))})

        elif event == "save_dataset":
            result = manager.save_coco()
            if result:
                emit({"event": "dataset_saved", **result})
            else:
                emit({"event": "error", "message": "No active dataset", "retriable": True})


if __name__ == "__main__":
    main()
