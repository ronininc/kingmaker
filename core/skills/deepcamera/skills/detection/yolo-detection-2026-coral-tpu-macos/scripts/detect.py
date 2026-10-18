#!/usr/bin/env python3
"""
Coral TPU Object Detection — JSONL stdin/stdout protocol
Uses ai-edge-litert (LiteRT) with Edge TPU delegate for hardware acceleration.
Same protocol as yolo-detection-2026/scripts/detect.py.

Communication:
  stdin:  {"event": "frame", "frame_id": N, "frame_path": "...", ...}
  stdout: {"event": "detections", "frame_id": N, "objects": [...]}
  stderr: Debug logs (ignored by Aegis parser)
"""

import json
import os
import sys
import time
import signal
import threading
from pathlib import Path
from typing import Optional, List, Dict, Any, Tuple

# ─── Windows DLL search path fix (MUST happen before any native import) ───────
_LIB_DIR = Path(__file__).parent.parent / "lib"
if sys.platform == "win32" and _LIB_DIR.exists():
    os.add_dll_directory(str(_LIB_DIR))
    os.environ["PATH"] = str(_LIB_DIR) + os.pathsep + os.environ.get("PATH", "")

import numpy as np
from PIL import Image

# ─── LiteRT imports ────────────────────────────────────────────────────────────
HAS_LITERT = False

try:
    import tflite_runtime.interpreter as litert # interpreter as litert
    HAS_LITERT = True
except ImportError:
    sys.stderr.write("[coral-detect] WARNING: ai-edge-litert not installed\n")


def log(message: str) -> None:
    sys.stderr.write(f"[coral-detect] {message}\n")
    sys.stderr.flush()


def emit_json(payload: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _edgetpu_lib_name():
    """Return the platform-specific libedgetpu shared library name."""
    import platform
    system = platform.system()
    if system == "Linux":
        return "libedgetpu.so.1"
    elif system == "Darwin":
        return "libedgetpu.1.dylib"
    elif system == "Windows":
        local_dll = _LIB_DIR / "edgetpu.dll"
        if local_dll.exists():
            return str(local_dll.resolve())
        return "edgetpu.dll"
    return "libedgetpu.so.1"


# ─── COCO class names (80 classes) ────────────────────────────────────────────
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
        self.timings: List[Dict[str, float]] = []
        self.total_frames = 0

    def record(self, timing_dict: Dict[str, float]) -> None:
        self.timings.append(timing_dict)
        self.total_frames += 1

    def should_emit(self) -> bool:
        return len(self.timings) >= self.emit_interval

    def emit_and_reset(self) -> Optional[Dict[str, Any]]:
        if not self.timings:
            return None

        stats = {"event": "perf_stats", "total_frames": len(self.timings), "timings_ms": {}}
        for key in self.timings[0]:
            values = sorted([t[key] for t in self.timings])
            n = len(values)
            p95_idx = min(n - 1, int(n * 0.95))
            p99_idx = min(n - 1, int(n * 0.99))
            stats["timings_ms"][key] = {
                "avg": round(sum(values) / n, 2),
                "p50": round(values[n // 2], 2),
                "p95": round(values[p95_idx], 2),
                "p99": round(values[p99_idx], 2),
            }
        self.timings = []
        return stats


class TPUHealthWatchdog:
    """
    Detects two distinct TPU failure modes:

    1. Inference hang: interpreter.invoke() takes longer than `invoke_timeout_s`.
    2. Silent stall: consecutive empty results after previous successful detections.
    """

    def __init__(self, invoke_timeout_s=10, stall_frames=30, min_active_frames=5):
        self.invoke_timeout_s = invoke_timeout_s
        self.stall_frames = stall_frames
        self.min_active_frames = min_active_frames

        self._consecutive_zero = 0
        self._total_frames_with_detections = 0
        self._invoke_exception: Optional[Exception] = None

    def run_invoke(self, interpreter) -> None:
        """Run interpreter.invoke() with a hard timeout."""
        self._invoke_exception = None
        completed = [False]

        def _invoke():
            try:
                interpreter.invoke()
                completed[0] = True
            except Exception as e:
                self._invoke_exception = e

        t = threading.Thread(target=_invoke, daemon=True)
        t.start()
        t.join(timeout=self.invoke_timeout_s)

        if t.is_alive():
            raise RuntimeError(
                f"TPU invoke() timed out after {self.invoke_timeout_s}s — "
                "USB connection may be lost or TPU is locked up"
            )

        if self._invoke_exception is not None:
            raise self._invoke_exception

    def record(self, n_detections: int) -> Optional[str]:
        if n_detections > 0:
            self._total_frames_with_detections += 1
            self._consecutive_zero = 0
            return None

        self._consecutive_zero += 1
        if (
            self._total_frames_with_detections >= self.min_active_frames
            and self._consecutive_zero >= self.stall_frames
        ):
            return "stall"

        return None

    def reset_stall(self) -> None:
        self._consecutive_zero = 0


class CoralDetector:
    """Edge TPU object detector using ai-edge-litert with libedgetpu delegate."""

    def __init__(self, params: Dict[str, Any]):
        self.params = params
        self.confidence = float(params.get("confidence", 0.5))
        self.input_size = int(params.get("input_size", 320))
        self.interpreter = None
        self.tpu_count = 0
        self.device_name = "unknown"
        self.watchdog = TPUHealthWatchdog(
            invoke_timeout_s=10,
            stall_frames=30,
            min_active_frames=5,
        )

        classes_str = params.get("classes", "person,car,dog,cat")
        self.target_classes = set(c.strip().lower() for c in classes_str.split(",") if c.strip())

        self._load_model()

    def _find_model_path(self) -> Optional[str]:
        """Find the compiled Edge TPU model."""
        candidates = [
            Path("/app/models"),
            Path(__file__).parent.parent / "models",
        ]

        for d in candidates:
            if not d.exists():
                continue
            for pattern in [
                "*_full_integer_quant_edgetpu.tflite",
                "*_edgetpu.tflite",
                "*.tflite",
            ]:
                matches = sorted(d.glob(pattern))
                if matches:
                    return str(matches[0])

        return None

    def _load_model(self) -> None:
        """Load model onto Edge TPU (or CPU fallback)."""
        if not HAS_LITERT:
            log("FATAL: ai-edge-litert not available. pip install ai-edge-litert")
            emit_json({"event": "error", "message": "ai-edge-litert not installed", "retriable": False})
            sys.exit(1)

        model_path = self._find_model_path()
        if not model_path:
            log("ERROR: No .tflite model found in models/")
            emit_json({"event": "error", "message": "No Edge TPU model found", "retriable": False})
            sys.exit(1)

        edgetpu_lib = _edgetpu_lib_name()
        try:
            if hasattr(litert, "Delegate"):
                original_del = getattr(litert.Delegate, "__del__", None)
                if original_del and not hasattr(litert.Delegate, "_patched_del"):
                    def safe_del(self):
                        try:
                            original_del(self)
                        except AttributeError:
                            pass
                    litert.Delegate.__del__ = safe_del
                    litert.Delegate._patched_del = True

            delegate = litert.load_delegate(edgetpu_lib)
            self.interpreter = litert.Interpreter(
                model_path=model_path,
                experimental_delegates=[delegate],
            )
            self.interpreter.allocate_tensors()
            self.device_name = "coral"
            self.tpu_count = 1
            log(f"Loaded model on Edge TPU: {model_path}")
        except (ValueError, OSError) as e:
            log(f"Edge TPU delegate not available: {e}")
            log("Falling back to CPU inference")
            self._load_cpu_fallback(model_path)

    def _load_cpu_fallback(self, model_path: str) -> None:
        """Fallback to CPU-only LiteRT interpreter."""
        cpu_path = model_path.replace("_edgetpu.tflite", ".tflite")
        if not os.path.exists(cpu_path):
            universal_fallback = os.path.join(
                os.path.dirname(model_path),
                "ssd_mobilenet_v2_coco_quant_postprocess.tflite",
            )
            if os.path.exists(universal_fallback):
                log("Falling back to universal SSD MobileNet CPU model")
                cpu_path = universal_fallback
            elif "edgetpu" in model_path.lower():
                log("FATAL: Cannot load Edge TPU compiled model on pure CPU, and no fallback model exists.")
                emit_json({
                    "event": "error",
                    "message": "No Edge TPU plugged in and no pure-CPU fallback model found.",
                    "retriable": False,
                })
                sys.exit(1)
            else:
                cpu_path = model_path

        try:
            self.interpreter = litert.Interpreter(model_path=cpu_path)
            self.interpreter.allocate_tensors()
            self.device_name = "cpu"
            log(f"Loaded model on CPU: {cpu_path}")
        except Exception as e:
            log(f"FATAL: Cannot load model: {e}")
            emit_json({"event": "error", "message": f"Cannot load model: {e}", "retriable": False})
            sys.exit(1)

    def _prepare_input_tensor(self, img_resized: Image.Image, input_details: Dict[str, Any]) -> np.ndarray:
        """
        Prepare input tensor matching model dtype and quantization parameters.

        Fixes crash where INT8 models were being fed UINT8 tensors.
        """
        req_dtype = input_details["dtype"]
        input_shape = input_details["shape"]
        quant = input_details.get("quantization", (0.0, 0))
        scale, zero_point = quant if quant is not None else (0.0, 0)

        img_np = np.asarray(img_resized)

        if req_dtype == np.uint8:
            tensor = img_np.astype(np.uint8)

        elif req_dtype == np.int8:
            # Quantize from float pixel domain using model input quantization.
            # If scale metadata is missing/zero, fall back to common full-int8 image mapping.
            if scale and scale > 0:
                tensor_f = img_np.astype(np.float32) / scale + zero_point
                tensor = np.clip(np.round(tensor_f), -128, 127).astype(np.int8)
            else:
                tensor = (img_np.astype(np.int16) - 128).clip(-128, 127).astype(np.int8)

        elif req_dtype == np.float32:
            tensor = img_np.astype(np.float32)
            if scale and scale > 0:
                tensor = (tensor - zero_point) * scale
            else:
                tensor /= 255.0

        else:
            tensor = img_np.astype(req_dtype)

        return np.expand_dims(tensor, axis=0).reshape(input_shape)

    def _dequantize_output(self, arr: np.ndarray, detail: Dict[str, Any]) -> np.ndarray:
        """Convert quantized output tensor to float if needed."""
        if np.issubdtype(arr.dtype, np.floating):
            return arr.astype(np.float32)

        scale, zero_point = detail.get("quantization", (0.0, 0))
        if scale and scale > 0:
            return (arr.astype(np.float32) - zero_point) * scale
        return arr.astype(np.float32)

    def _parse_ssd_outputs(
        self,
        output_details: List[Dict[str, Any]],
        orig_w: int,
        orig_h: int,
    ) -> List[Dict[str, Any]]:
        """Parse SSD MobileNet-style outputs: boxes, classes, scores, count."""
        boxes = self._dequantize_output(
            self.interpreter.get_tensor(output_details[0]["index"]),
            output_details[0],
        )[0]
        classes = self._dequantize_output(
            self.interpreter.get_tensor(output_details[1]["index"]),
            output_details[1],
        )[0]
        scores = self._dequantize_output(
            self.interpreter.get_tensor(output_details[2]["index"]),
            output_details[2],
        )[0]
        count_tensor = self.interpreter.get_tensor(output_details[3]["index"])
        count = int(np.array(count_tensor).flatten()[0])

        objects: List[Dict[str, Any]] = []
        for i in range(min(count, len(scores), 100)):
            score = float(scores[i])
            if score < self.confidence:
                continue

            class_id = int(classes[i])
            class_name = COCO_CLASSES[class_id] if 0 <= class_id < len(COCO_CLASSES) else f"class_{class_id}"

            if self.target_classes and class_name.lower() not in self.target_classes:
                continue

            y1, x1, y2, x2 = [float(v) for v in boxes[i]]
            x1 = max(0.0, min(1.0, x1))
            y1 = max(0.0, min(1.0, y1))
            x2 = max(0.0, min(1.0, x2))
            y2 = max(0.0, min(1.0, y2))

            objects.append({
                "label": class_name,
                "confidence": round(score, 4),
                "bbox": {
                    "x": round(x1 * orig_w, 1),
                    "y": round(y1 * orig_h, 1),
                    "width": round((x2 - x1) * orig_w, 1),
                    "height": round((y2 - y1) * orig_h, 1),
                },
            })

        return objects

    def detect_frame(self, frame_path: str) -> Tuple[List[Dict[str, Any]], Dict[str, float], Optional[str]]:
        """Run detection on a single frame."""
        t0 = time.perf_counter()

        try:
            img = Image.open(frame_path).convert("RGB")
        except Exception as e:
            log(f"ERROR reading frame: {e}")
            return [], {}, None

        t_read = time.perf_counter()

        input_details = self.interpreter.get_input_details()[0]
        input_shape = input_details["shape"]
        h, w = int(input_shape[1]), int(input_shape[2])
        orig_w, orig_h = img.size
        img_resized = img.resize((w, h), Image.LANCZOS)

        try:
            input_data = self._prepare_input_tensor(img_resized, input_details)
            self.interpreter.set_tensor(input_details["index"], input_data)
        except Exception as e:
            log(f"ERROR preparing input tensor: dtype={input_details.get('dtype')} quant={input_details.get('quantization')} err={e}")
            return [], {}, "input_error"

        t_pre = time.perf_counter()

        try:
            self.watchdog.run_invoke(self.interpreter)
        except RuntimeError as e:
            log(f"TPU invoke() failed: {e}")
            return [], {}, "hang"
        except Exception as e:
            log(f"Inference failed: {e}")
            return [], {}, "invoke_error"

        t_infer = time.perf_counter()

        objects: List[Dict[str, Any]] = []
        output_details = self.interpreter.get_output_details()

        try:
            if len(output_details) >= 4:
                objects = self._parse_ssd_outputs(output_details, orig_w, orig_h)
            else:
                log(f"Unsupported model output layout: {len(output_details)} tensors")
        except Exception as e:
            log(f"ERROR parsing outputs: {e}")
            return [], {}, "parse_error"

        t_post = time.perf_counter()

        timings = {
            "file_read": round((t_read - t0) * 1000.0, 2),
            "preprocess": round((t_pre - t_read) * 1000.0, 2),
            "inference": round((t_infer - t_pre) * 1000.0, 2),
            "postprocess": round((t_post - t_infer) * 1000.0, 2),
            "total": round((t_post - t0) * 1000.0, 2),
        }

        health = self.watchdog.record(len(objects))
        return objects, timings, health


_shutdown = False


def _handle_signal(signum, frame):
    global _shutdown
    _shutdown = True
    log(f"Received signal {signum}, shutting down...")


def main() -> None:
    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)

    raw_params = os.environ.get("AEGIS_SKILL_PARAMS", "{}")
    try:
        params = json.loads(raw_params)
    except Exception:
        params = {}

    log(f"Starting with params: {json.dumps(params)}")

    detector = CoralDetector(params)
    perf = PerfTracker(emit_interval=50)

    emit_json({
        "event": "ready",
        "model": "yolo26n_edgetpu",
        "device": detector.device_name,
        "format": "edgetpu_tflite",
        "runtime": "ai-edge-litert",
        "tpu_count": detector.tpu_count,
        "classes": len(COCO_CLASSES),
        "input_size": detector.input_size,
        "fps": int(params.get("fps", 5)),
    })
    log("Ready — waiting for frame events on stdin")

    while not _shutdown:
        line = sys.stdin.readline()
        if not line:
            break

        line = line.strip()
        if not line:
            continue

        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            log(f"Ignoring invalid JSON line: {line[:200]}")
            continue

        event = msg.get("event")
        if event == "shutdown":
            break

        if event != "frame":
            continue

        frame_path = msg.get("frame_path")
        frame_id = msg.get("frame_id")
        camera_id = msg.get("camera_id")
        timestamp = msg.get("timestamp")

        if not frame_path:
            emit_json({
                "event": "error",
                "frame_id": frame_id,
                "message": "Missing frame_path",
                "retriable": True,
            })
            continue

        objects, timings, health = detector.detect_frame(frame_path)

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

        if health == "hang":
            emit_json({
                "event": "error",
                "frame_id": frame_id,
                "message": "TPU inference hang detected",
                "retriable": True,
            })
        elif health == "stall":
            emit_json({
                "event": "warning",
                "frame_id": frame_id,
                "message": "TPU may be stalled: too many consecutive empty detections",
            })

    stats = perf.emit_and_reset()
    if stats:
        emit_json(stats)


if __name__ == "__main__":
    main()
