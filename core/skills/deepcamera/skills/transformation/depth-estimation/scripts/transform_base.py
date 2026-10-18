#!/usr/bin/env python3
"""
TransformSkillBase — Abstract base class for Aegis privacy/transform skills.

Any skill that transforms camera frames (depth maps, blur, pixelation, etc.)
should subclass TransformSkillBase and implement the `transform_frame` method.

## Protocol (JSONL over stdin/stdout)

### Aegis → Skill (stdin)
```jsonl
{"event": "frame", "frame_id": "cam1_1710001", "camera_id": "front_door", "frame_path": "/tmp/frame.jpg", "timestamp": "..."}
{"command": "stop"}
{"command": "config-update", "config": {"opacity": 0.8}}
```

### Skill → Aegis (stdout)
```jsonl
{"event": "ready", "model": "depth-anything-v2-small", "device": "mps"}
{"event": "transform", "frame_id": "cam1_1710001", "camera_id": "front_door", "transform_path": "/tmp/depth_001.jpg"}
{"event": "transform", "frame_id": "cam1_1710001", "camera_id": "front_door", "transform_data": "<base64 JPEG>"}
{"event": "error", "message": "...", "retriable": true}
{"event": "perf_stats", "total_frames": 100, "timings_ms": {...}}
```

## Implementing a new transform skill

```python
from transform_base import TransformSkillBase

class MyCustomTransform(TransformSkillBase):
    def load_model(self, config):
        # Load your model here
        self.model = load_my_model(config["model"])
        return {"model": config["model"], "device": self.device}

    def transform_frame(self, image, metadata):
        # Transform the image (numpy BGR array)
        result = self.model.process(image)
        return result  # Return numpy BGR array

if __name__ == "__main__":
    MyCustomTransform().run()
```
"""

import sys
import json
import os
import signal
import time
import argparse
import tempfile
import base64
from abc import ABC, abstractmethod
from pathlib import Path


# ═══════════════════════════════════════════════════════════════════════════════
# Hardware detection — reuse env_config.py from skills/lib/
# ═══════════════════════════════════════════════════════════════════════════════

_script_dir = Path(__file__).resolve().parent
_lib_candidates = [
    _script_dir,                                          # bundled alongside script
    _script_dir.parent.parent.parent.parent / "lib",      # repo: skills/lib/
    _script_dir.parent / "lib",                           # skill-level lib/
]
_env_config_loaded = False
for _lib_path in _lib_candidates:
    if (_lib_path / "env_config.py").exists():
        sys.path.insert(0, str(_lib_path))
        from env_config import HardwareEnv  # noqa: E402
        _env_config_loaded = True
        break

if not _env_config_loaded:
    # Minimal fallback — auto-detect via PyTorch only
    class HardwareEnv:  # type: ignore[no-redef]
        def __init__(self):
            self.backend = "cpu"
            self.device = "cpu"
            self.gpu_name = ""
            self.gpu_memory_mb = 0
            self.export_format = "none"
            self.framework_ok = False

        @staticmethod
        def detect():
            env = HardwareEnv()
            try:
                import torch
                if torch.cuda.is_available():
                    env.backend = "cuda"; env.device = "cuda"
                elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
                    env.backend = "mps"; env.device = "mps"
            except ImportError:
                pass
            return env

        def to_dict(self):
            return {"backend": self.backend, "device": self.device}


# ═══════════════════════════════════════════════════════════════════════════════
# Performance Tracker
# ═══════════════════════════════════════════════════════════════════════════════

class PerfTracker:
    """Collects per-frame timings and emits periodic aggregate stats."""

    def __init__(self, interval: int = 50):
        self.interval = interval
        self.frame_count = 0
        self.total_frames = 0
        self.error_count = 0
        self.model_load_ms = 0.0

        self._timings: dict[str, list[float]] = {
            "file_read": [],
            "transform": [],
            "encode": [],
            "emit": [],
            "total": [],
        }

    def record(self, stage: str, duration_ms: float):
        if stage in self._timings:
            self._timings[stage].append(duration_ms)

    def record_frame(self):
        self.frame_count += 1
        self.total_frames += 1
        if self.frame_count >= self.interval:
            self.emit_stats()
            self.frame_count = 0

    def emit_stats(self):
        stats = {
            "event": "perf_stats",
            "total_frames": self.total_frames,
            "window_size": len(self._timings["total"]) or 1,
            "errors": self.error_count,
            "model_load_ms": round(self.model_load_ms, 1),
            "timings_ms": {},
        }
        for stage, values in self._timings.items():
            if not values:
                continue
            sv = sorted(values)
            n = len(sv)
            stats["timings_ms"][stage] = {
                "avg": round(sum(sv) / n, 2),
                "min": round(sv[0], 2),
                "max": round(sv[-1], 2),
                "p50": round(sv[n // 2], 2),
                "p95": round(sv[int(n * 0.95)], 2),
            }
        _emit(stats)
        for key in self._timings:
            self._timings[key].clear()

    def emit_final(self):
        if self._timings["total"]:
            self.emit_stats()


# ═══════════════════════════════════════════════════════════════════════════════
# JSONL helpers
# ═══════════════════════════════════════════════════════════════════════════════

def _emit(event: dict):
    """Emit a JSONL event to stdout."""
    print(json.dumps(event), flush=True)


def _log(msg: str, tag: str = "TransformSkill"):
    """Log to stderr (not captured by Aegis JSONL parser)."""
    print(f"[{tag}] {msg}", file=sys.stderr, flush=True)


# ═══════════════════════════════════════════════════════════════════════════════
# Base Class
# ═══════════════════════════════════════════════════════════════════════════════

class TransformSkillBase(ABC):
    """
    Abstract base class for privacy/transform skills.

    Subclasses MUST implement:
      - load_model(config) → dict   : Load the model, return ready event fields
      - transform_frame(image, meta) → ndarray : Transform a single frame (BGR in, BGR out)

    Subclasses MAY override:
      - parse_extra_args(parser)   : Add custom CLI arguments
      - on_config_update(config)   : Handle live config updates
      - get_output_mode()          : Return 'path' (default) or 'base64'
    """

    def __init__(self):
        self.device = "cpu"
        self.env = None  # HardwareEnv — populated in run()
        self.config = {}
        self.perf = PerfTracker()
        self._running = True
        self._tag = self.__class__.__name__

    # ── Abstract methods ─────────────────────────────────────────────────

    @abstractmethod
    def load_model(self, config: dict) -> dict:
        """
        Load the transform model.

        Args:
            config: Merged config from AEGIS_SKILL_PARAMS / CLI / config file

        Returns:
            dict with at least {"model": str, "device": str} for the ready event.
        """
        ...

    @abstractmethod
    def transform_frame(self, image, metadata: dict):
        """
        Transform a single frame.

        Args:
            image: numpy BGR array (from cv2.imread)
            metadata: {"camera_id": str, "frame_id": str, "timestamp": str, ...}

        Returns:
            numpy BGR array (transformed image)
        """
        ...

    # ── Optional overrides ───────────────────────────────────────────────

    def parse_extra_args(self, parser: argparse.ArgumentParser):
        """Override to add skill-specific CLI arguments."""
        pass

    def on_config_update(self, config: dict):
        """Override to handle live config updates from Aegis."""
        pass

    def get_output_mode(self) -> str:
        """Return 'path' (write to temp file) or 'base64' (inline data)."""
        return "path"

    # ── Main entry point ─────────────────────────────────────────────────

    def run(self):
        """Parse args, load model, enter stdin loop."""
        args = self._parse_args()
        self.config = self._load_config(args)

        # Hardware detection — full multi-backend probe
        device_pref = self.config.get("device", "auto")
        self.env = self._detect_hardware(device_pref)
        self.device = self.env.device

        # Load model
        try:
            gpu_msg = f"{self.env.gpu_name} ({self.env.backend})" if self.env.gpu_name else self.env.backend
            _emit({"event": "progress", "stage": "init", "message": f"Hardware: {gpu_msg}"})
            _emit({"event": "progress", "stage": "model", "message": "Loading model..."})
            t0 = time.perf_counter()
            ready_fields = self.load_model(self.config)
            self.perf.model_load_ms = (time.perf_counter() - t0) * 1000

            ready_event = {
                "event": "ready",
                "model_load_ms": round(self.perf.model_load_ms, 1),
                "backend": self.env.backend,
                "gpu": self.env.gpu_name,
                **ready_fields,
            }
            _emit(ready_event)
        except Exception as e:
            _emit({"event": "error", "message": f"Model load failed: {e}", "retriable": False})
            sys.exit(1)

        # Graceful shutdown handler
        def handle_signal(signum, frame):
            sig_name = "SIGTERM" if signum == signal.SIGTERM else "SIGINT"
            _log(f"Received {sig_name}, shutting down", self._tag)
            self.perf.emit_final()
            sys.exit(0)

        signal.signal(signal.SIGTERM, handle_signal)
        signal.signal(signal.SIGINT, handle_signal)

        # Main JSONL stdin loop
        self._mainloop()

    def _mainloop(self):
        import cv2  # noqa: delayed import

        output_mode = self.get_output_mode()

        for line in sys.stdin:
            if not self._running:
                break
            line = line.strip()
            if not line:
                continue

            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue

            # ── Commands ─────────────────────────────────────────────
            if msg.get("command") == "stop":
                break
            if msg.get("command") == "config-update":
                self.on_config_update(msg.get("config", {}))
                continue

            # ── Frame events ─────────────────────────────────────────
            if msg.get("event") == "frame":
                t_start = time.perf_counter()

                frame_path = msg.get("frame_path")
                frame_id = msg.get("frame_id", "")
                camera_id = msg.get("camera_id", "unknown")
                timestamp = msg.get("timestamp", "")

                if not frame_path or not Path(frame_path).exists():
                    _emit({
                        "event": "error",
                        "frame_id": frame_id,
                        "message": f"Frame not found: {frame_path}",
                        "retriable": True,
                    })
                    self.perf.error_count += 1
                    continue

                try:
                    # Read frame
                    t0 = time.perf_counter()
                    image = cv2.imread(frame_path)
                    if image is None:
                        raise ValueError(f"cv2.imread returned None for {frame_path}")
                    self.perf.record("file_read", (time.perf_counter() - t0) * 1000)

                    # Transform
                    t0 = time.perf_counter()
                    metadata = {
                        "camera_id": camera_id,
                        "frame_id": frame_id,
                        "timestamp": timestamp,
                    }
                    result_image = self.transform_frame(image, metadata)
                    self.perf.record("transform", (time.perf_counter() - t0) * 1000)

                    # Encode and emit
                    t0 = time.perf_counter()
                    transform_event = {
                        "event": "transform",
                        "frame_id": frame_id,
                        "camera_id": camera_id,
                        "timestamp": timestamp,
                    }

                    if output_mode == "base64":
                        _, buf = cv2.imencode(".jpg", result_image, [cv2.IMWRITE_JPEG_QUALITY, 85])
                        transform_event["transform_data"] = base64.b64encode(buf).decode("ascii")
                    else:
                        out_path = tempfile.mktemp(suffix=".jpg", dir=tempfile.gettempdir())
                        cv2.imwrite(out_path, result_image, [cv2.IMWRITE_JPEG_QUALITY, 90])
                        transform_event["transform_path"] = out_path

                    self.perf.record("encode", (time.perf_counter() - t0) * 1000)

                    t0 = time.perf_counter()
                    _emit(transform_event)
                    self.perf.record("emit", (time.perf_counter() - t0) * 1000)

                except Exception as e:
                    _emit({
                        "event": "error",
                        "frame_id": frame_id,
                        "message": f"Transform error: {e}",
                        "retriable": True,
                    })
                    self.perf.error_count += 1
                    continue

                self.perf.record("total", (time.perf_counter() - t_start) * 1000)
                self.perf.record_frame()

        self.perf.emit_final()

    # ── Config loading ───────────────────────────────────────────────────

    def _parse_args(self):
        parser = argparse.ArgumentParser(description=f"{self._tag} Skill")
        parser.add_argument("--config", type=str, help="Path to config JSON file")
        parser.add_argument("--device", type=str, default="auto",
                            choices=["auto", "cpu", "cuda", "mps", "rocm"])
        self.parse_extra_args(parser)
        return parser.parse_args()

    def _load_config(self, args) -> dict:
        env_params = os.environ.get("AEGIS_SKILL_PARAMS")
        if env_params:
            try:
                return json.loads(env_params)
            except json.JSONDecodeError:
                pass
        if args.config:
            config_path = Path(args.config)
            if config_path.exists():
                with open(config_path) as f:
                    return json.load(f)
        return {"device": args.device}

    @staticmethod
    def _detect_hardware(device_pref: str = "auto") -> HardwareEnv:
        """
        Full hardware detection using shared env_config.py.

        Supports: NVIDIA CUDA, AMD ROCm, Apple MPS/Neural Engine,
                  Intel OpenVINO/NPU, CPU fallback.

        Returns a HardwareEnv with .backend, .device, .gpu_name, etc.
        """
        env = HardwareEnv.detect()

        # Honour explicit device preference
        if device_pref != "auto":
            env.device = device_pref
            env.backend = device_pref

        return env
