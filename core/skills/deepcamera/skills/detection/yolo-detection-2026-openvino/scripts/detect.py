#!/usr/bin/env python3
"""
OpenVINO Object Detection — JSONL stdin/stdout protocol
Runs inside Docker container with OpenVINO runtime.
Same protocol as yolo-detection-2026 and coral-tpu skills.

Uses Ultralytics YOLO with OpenVINO backend for inference.
Supports: CPU, Intel GPU (iGPU/Arc), NCS2 (MYRIAD).
"""

import json
import os
import sys
import time
import signal
from pathlib import Path

import numpy as np
from PIL import Image

# Suppress Ultralytics auto-install
os.environ.setdefault("YOLO_AUTOINSTALL", "0")


# ─── COCO class names (80 classes) ───────────────────────────────────────────
COCO_CLASSES = [
    "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train",
    "truck", "boat", "traffic light", "fire hydrant", "stop sign",
    "parking meter", "bench", "bird", "cat", "dog", "horse", "sheep",
    "cow", "elephant", "bear", "zebra", "giraffe", "backpack", "umbrella",
    "handbag", "tie", "suitcase", "frisbee", "skis", "snowboard",
    "sports ball", "kite", "baseball bat", "baseball glove", "skateboard",
    "surfboard", "tennis racket", "bottle", "wine glass", "cup", "fork",
    "knife", "spoon", "bowl", "banana", "apple", "sandwich", "orange",
    "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair",
    "couch", "potted plant", "bed", "dining table", "toilet", "tv",
    "laptop", "mouse", "remote", "keyboard", "cell phone", "microwave",
    "oven", "toaster", "sink", "refrigerator", "book", "clock", "vase",
    "scissors", "teddy bear", "hair drier", "toothbrush"
]


class PerfTracker:
    """Tracks per-frame timing and emits aggregate stats."""

    def __init__(self, emit_interval=50):
        self.emit_interval = emit_interval
        self.timings = []
        self.total_frames = 0

    def record(self, timing_dict):
        self.timings.append(timing_dict)
        self.total_frames += 1

    def should_emit(self):
        return len(self.timings) >= self.emit_interval

    def emit_and_reset(self):
        if not self.timings:
            return None

        stats = {"event": "perf_stats", "total_frames": len(self.timings), "timings_ms": {}}
        for key in self.timings[0]:
            values = sorted([t[key] for t in self.timings])
            n = len(values)
            stats["timings_ms"][key] = {
                "avg": round(sum(values) / n, 2),
                "p50": round(values[n // 2], 2),
                "p95": round(values[int(n * 0.95)], 2),
                "p99": round(values[int(n * 0.99)], 2),
            }
        self.timings = []
        return stats


class OpenVINODetector:
    """YOLO detector using Ultralytics OpenVINO backend."""

    def __init__(self, params):
        self.params = params
        self.confidence = float(params.get("confidence", 0.5))
        self.input_size = int(params.get("input_size", 640))
        self.device = params.get("device", "AUTO")
        self.precision = params.get("precision", "FP16")
        self.model = None
        self.device_name = "unknown"
        self.available_devices = []

        # Parse target classes
        classes_str = params.get("classes", "person,car,dog,cat")
        self.target_classes = set(c.strip().lower() for c in classes_str.split(","))

        self._probe_devices()
        self._load_model()

    def _probe_devices(self):
        """Enumerate available OpenVINO devices."""
        try:
            from openvino.runtime import Core
            core = Core()
            self.available_devices = core.available_devices
            log(f"OpenVINO devices: {self.available_devices}")
        except Exception as e:
            log(f"WARNING: Could not probe OpenVINO devices: {e}")
            self.available_devices = ["CPU"]

    def _find_model_path(self):
        """Find OpenVINO IR model or .pt file."""
        model_dir = Path("/app/models")
        script_dir = Path(__file__).parent.parent / "models"

        for d in [model_dir, script_dir]:
            if not d.exists():
                continue
            # Look for OpenVINO IR model directory (contains .xml + .bin)
            for subdir in d.iterdir():
                if subdir.is_dir() and list(subdir.glob("*.xml")):
                    return str(subdir)
            # Look for .xml directly
            xml_files = list(d.glob("*.xml"))
            if xml_files:
                return str(xml_files[0])
            # Look for .pt file (will be exported to OpenVINO at runtime)
            pt_files = list(d.glob("*.pt"))
            if pt_files:
                return str(pt_files[0])

        # Fallback: use yolo26n.pt (auto-download from Ultralytics)
        return "yolo26n.pt"

    def _load_model(self):
        """Load YOLO model with OpenVINO backend."""
        from ultralytics import YOLO

        model_path = self._find_model_path()
        log(f"Loading model: {model_path}")

        t0 = time.perf_counter()

        if model_path.endswith(".pt"):
            # Load PyTorch model, let Ultralytics handle OpenVINO export
            log(f"Exporting to OpenVINO format (precision: {self.precision})...")
            self.model = YOLO(model_path)
            half = self.precision == "FP16"
            int8 = self.precision == "INT8"
            export_path = self.model.export(
                format="openvino",
                imgsz=self.input_size,
                half=half,
                int8=int8,
            )
            log(f"Exported to: {export_path}")
            # Reload from exported OpenVINO model
            self.model = YOLO(export_path)
        else:
            # Load pre-exported OpenVINO model directly
            self.model = YOLO(model_path)

        load_ms = (time.perf_counter() - t0) * 1000
        log(f"Model loaded in {load_ms:.0f}ms")

        # Determine actual device
        if self.device in self.available_devices or self.device == "AUTO":
            self.device_name = self.device
        else:
            log(f"WARNING: Device '{self.device}' not available, using AUTO")
            self.device_name = "AUTO"

    def detect_frame(self, frame_path):
        """Run detection on a single frame. Returns list of detection dicts."""
        t0 = time.perf_counter()

        if not os.path.exists(frame_path):
            log(f"Frame not found: {frame_path}")
            return [], {}

        t_read = time.perf_counter()

        # Run inference via Ultralytics (handles OpenVINO internally)
        t_pre = time.perf_counter()
        results = self.model(
            frame_path,
            conf=self.confidence,
            imgsz=self.input_size,
            verbose=False,
        )

        t_infer = time.perf_counter()

        # Parse results
        objects = []
        for r in results:
            for box in r.boxes:
                cls_id = int(box.cls[0])
                cls_name = self.model.names.get(cls_id, f"class_{cls_id}")

                if self.target_classes and cls_name not in self.target_classes:
                    continue

                x1, y1, x2, y2 = box.xyxy[0].tolist()
                objects.append({
                    "class": cls_name,
                    "confidence": round(float(box.conf[0]), 3),
                    "bbox": [int(x1), int(y1), int(x2), int(y2)],
                })

        t_post = time.perf_counter()

        timings = {
            "file_read": round((t_read - t0) * 1000, 2),
            "preprocess": round((t_pre - t_read) * 1000, 2),
            "inference": round((t_infer - t_pre) * 1000, 2),
            "postprocess": round((t_post - t_infer) * 1000, 2),
            "total": round((t_post - t0) * 1000, 2),
        }

        return objects, timings


# ─── Helpers ──────────────────────────────────────────────────────────────────

def log(msg):
    sys.stderr.write(f"[openvino-detect] {msg}\n")
    sys.stderr.flush()


def emit_json(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


# ─── Main loop ───────────────────────────────────────────────────────────────

def main():
    params_str = os.environ.get("AEGIS_SKILL_PARAMS", "{}")
    try:
        params = json.loads(params_str)
    except json.JSONDecodeError:
        params = {}

    log(f"Starting with params: {json.dumps(params)}")

    detector = OpenVINODetector(params)
    perf = PerfTracker(emit_interval=50)

    # Emit ready event
    emit_json({
        "event": "ready",
        "model": "yolo26n_openvino",
        "device": detector.device_name,
        "format": "openvino_ir",
        "precision": detector.precision,
        "available_devices": detector.available_devices,
        "classes": len(COCO_CLASSES),
        "input_size": detector.input_size,
        "fps": params.get("fps", 5),
    })

    # Graceful shutdown
    running = True
    def on_signal(sig, frame):
        nonlocal running
        running = False
    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)

    log("Ready — waiting for frame events on stdin")
    for line in sys.stdin:
        if not running:
            break

        line = line.strip()
        if not line:
            continue

        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            log(f"Invalid JSON: {line[:100]}")
            continue

        if msg.get("command") == "stop" or msg.get("event") == "stop":
            break

        if msg.get("event") == "frame":
            frame_id = msg.get("frame_id", 0)
            frame_path = msg.get("frame_path", "")
            camera_id = msg.get("camera_id", "")
            timestamp = msg.get("timestamp", "")

            if not frame_path or not os.path.exists(frame_path):
                log(f"Frame not found: {frame_path}")
                emit_json({
                    "event": "detections",
                    "frame_id": frame_id,
                    "camera_id": camera_id,
                    "timestamp": timestamp,
                    "objects": [],
                })
                continue

            objects, timings = detector.detect_frame(frame_path)

            emit_json({
                "event": "detections",
                "frame_id": frame_id,
                "camera_id": camera_id,
                "timestamp": timestamp,
                "objects": objects,
            })

            if timings:
                perf.record(timings)
                if perf.should_emit():
                    stats = perf.emit_and_reset()
                    if stats:
                        emit_json(stats)

    log("Shutting down")


if __name__ == "__main__":
    main()
