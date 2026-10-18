#!/usr/bin/env python3
"""
SAM2 Annotation Skill — Interactive segmentation for Aegis Annotation Studio.

Protocol (JSONL over stdin/stdout):
  stdin:  {"command": "encode", "frame_path": "...", "frame_id": "...", "request_id": "..."}
          {"command": "segment", "points": [...], "boxes": [...], "request_id": "..."}
          {"command": "track", "frame_id": "...", "request_id": "..."}
          {"command": "stop"}
  stdout: {"event": "segmentation", "type": "encoded"|"segmented"|"tracked"|"ready", ...}
"""

import sys
import json
import argparse
import signal
import time
import tempfile
import base64
from pathlib import Path


# ───────────────────────────────────────────────────────────────────────────────
# Helpers
# ───────────────────────────────────────────────────────────────────────────────

def emit(event: dict):
    """Send a JSONL event to stdout (Aegis picks this up)."""
    print(json.dumps(event), flush=True)


def log(msg: str):
    """Log to stderr (visible in skill console, not parsed as protocol)."""
    print(f"[SAM2] {msg}", file=sys.stderr, flush=True)


def emit_segmentation(type_: str, request_id: str, data: dict = None, error: str = None):
    """Emit a segmentation event in the format skill-runtime-manager.cjs expects."""
    event = {
        "event": "segmentation",
        "type": type_,
        "request_id": request_id or "",
        "data": data or {},
    }
    if error:
        event["error"] = error
    emit(event)


# ───────────────────────────────────────────────────────────────────────────────
# Performance tracker
# ───────────────────────────────────────────────────────────────────────────────

PERF_INTERVAL = 20


class PerfTracker:
    def __init__(self):
        self.frame_count = 0
        self.total_encodes = 0
        self.total_segments = 0
        self.total_tracks = 0
        self._timings: dict[str, list[float]] = {
            "encode": [], "segment": [], "track": [],
        }

    def record(self, stage: str, ms: float):
        if stage in self._timings:
            self._timings[stage].append(ms)

    def tick(self):
        self.frame_count += 1
        if self.frame_count >= PERF_INTERVAL:
            self._emit()
            self.frame_count = 0

    def _emit(self):
        stats = {"event": "perf_stats", "total_encodes": self.total_encodes,
                 "total_segments": self.total_segments, "total_tracks": self.total_tracks,
                 "timings_ms": {}}
        for stage, vals in self._timings.items():
            if vals:
                stats["timings_ms"][stage] = {
                    "avg": round(sum(vals) / len(vals), 1),
                    "min": round(min(vals), 1),
                    "max": round(max(vals), 1),
                }
        emit(stats)
        for k in self._timings:
            self._timings[k].clear()

    def emit_final(self):
        if any(self._timings.values()):
            self._emit()


# ───────────────────────────────────────────────────────────────────────────────
# Config & device
# ───────────────────────────────────────────────────────────────────────────────

def parse_args():
    parser = argparse.ArgumentParser(description="SAM2 Annotation Skill")
    parser.add_argument("--config", type=str)
    parser.add_argument("--model", type=str, default="sam2-small")
    parser.add_argument("--device", type=str, default="auto")
    parser.add_argument("--mock", action="store_true", help="Mock mode — no model, synthetic responses")
    return parser.parse_args()


def load_config(args):
    import os
    env_params = os.environ.get("AEGIS_SKILL_PARAMS")
    if env_params:
        try:
            return json.loads(env_params)
        except json.JSONDecodeError:
            pass
    if args.config and Path(args.config).exists():
        with open(args.config) as f:
            return json.load(f)
    return {"model": args.model, "device": args.device}


def select_device(pref):
    if pref != "auto":
        return pref
    try:
        import torch
        if torch.cuda.is_available():
            return "cuda"
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return "mps"
    except ImportError:
        pass
    return "cpu"


# ───────────────────────────────────────────────────────────────────────────────
# Model config mapping
# ───────────────────────────────────────────────────────────────────────────────

MODEL_CFG = {
    "sam2-tiny":  "sam2_hiera_t.yaml",
    "sam2-small": "sam2_hiera_s.yaml",
    "sam2-base":  "sam2_hiera_b+.yaml",
    "sam2-large": "sam2_hiera_l.yaml",
}


# ───────────────────────────────────────────────────────────────────────────────
# Main
# ───────────────────────────────────────────────────────────────────────────────

def main():
    args = parse_args()
    config = load_config(args)
    device = select_device(config.get("device", "auto"))
    model_name = config.get("model", "sam2-small")
    perf = PerfTracker()

    mock_mode = args.mock or config.get("mock", False)
    predictor = None

    if mock_mode:
        log("Running in MOCK mode — no model loaded, synthetic responses")
        emit_segmentation("ready", "", {
            "model": f"{model_name} (mock)",
            "device": "mock",
            "available_models": list(MODEL_CFG.keys()),
            "mock": True,
        })
    else:
        # ── Load model ──
        emit({"event": "progress", "stage": "init", "message": f"Loading SAM2 ({model_name}) on {device}..."})

        try:
            import torch
            import numpy as np
            import cv2
            from sam2.build_sam import build_sam2
            from sam2.sam2_image_predictor import SAM2ImagePredictor

            cfg_file = MODEL_CFG.get(model_name, "sam2_hiera_s.yaml")
            checkpoint = f"models/{model_name}.pt"

            sam2 = build_sam2(cfg_file, checkpoint)
            predictor = SAM2ImagePredictor(sam2)
            predictor.model.to(device)

            emit_segmentation("ready", "", {
                "model": model_name,
                "device": device,
                "available_models": list(MODEL_CFG.keys()),
            })
            log(f"Model loaded: {model_name} on {device}")
        except Exception as e:
            emit_segmentation("ready", "", error=f"Failed to load SAM2: {e}")
            emit({"event": "error", "message": f"Failed to load SAM2: {e}", "retriable": False})
            sys.exit(1)

    # ── State ──
    current_image = None
    current_frame_id = None
    masks_dir = Path(tempfile.mkdtemp(prefix="sam2_masks_"))

    # ── Signal handling ──
    def handle_signal(signum, frame):
        sig = "SIGTERM" if signum == signal.SIGTERM else "SIGINT"
        log(f"Received {sig}, shutting down")
        perf.emit_final()
        sys.exit(0)
    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    # ── Main stdin loop ──
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue

        cmd = msg.get("command")
        req_id = msg.get("request_id", "")

        if cmd == "stop":
            break

        # ── Mock mode: return synthetic responses immediately ──
        if mock_mode:
            if cmd == "encode":
                frame_id = msg.get("frame_id", "mock_frame")
                current_frame_id = frame_id
                emit_segmentation("encoded", req_id, {
                    "frame_id": frame_id, "width": 1920, "height": 1080, "encode_ms": 1.0,
                })
                log(f"[MOCK] Encoded {frame_id}")
            elif cmd == "segment":
                # Generate a small synthetic 100x100 mock mask PNG
                import io
                mock_w, mock_h = 100, 80
                # Create a simple 1-pixel header PNG-like base64 (white rectangle)
                mock_mask_bytes = bytes([255] * (mock_w * mock_h))
                mock_b64 = base64.b64encode(mock_mask_bytes).decode()
                emit_segmentation("segmented", req_id, {
                    "frame_id": current_frame_id or "mock",
                    "mask_path": "/tmp/mock_mask.png",
                    "mask_b64": mock_b64,
                    "score": 0.95,
                    "bbox": [100, 50, 350, 420],
                    "segment_ms": 2.0,
                    "num_masks": 3,
                })
                log(f"[MOCK] Segmented")
            elif cmd == "track":
                frame_id = msg.get("frame_id", "mock_track")
                emit_segmentation("tracked", req_id, {
                    "frame_id": frame_id,
                    "mask_path": "/tmp/mock_track.png",
                    "score": 0.92,
                    "bbox": [110, 55, 360, 430],
                    "track_ms": 3.0,
                })
                log(f"[MOCK] Tracked {frame_id}")
            else:
                log(f"[MOCK] Unknown command: {cmd}")
            continue

        elif cmd == "encode":
            # ── Encode: load image and set in predictor ──
            t0 = time.perf_counter()
            frame_path = msg.get("frame_path")
            frame_id = msg.get("frame_id", f"frame_{int(time.time())}")

            if not frame_path or not Path(frame_path).exists():
                emit_segmentation("encoded", req_id, error=f"Frame not found: {frame_path}")
                continue

            try:
                img = cv2.imread(frame_path)
                img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
                predictor.set_image(img)
                current_image = img
                current_frame_id = frame_id

                ms = (time.perf_counter() - t0) * 1000
                perf.record("encode", ms)
                perf.total_encodes += 1
                perf.tick()

                emit_segmentation("encoded", req_id, {
                    "frame_id": frame_id,
                    "width": img.shape[1],
                    "height": img.shape[0],
                    "encode_ms": round(ms, 1),
                })
                log(f"Encoded frame {frame_id} ({img.shape[1]}x{img.shape[0]}) in {ms:.0f}ms")
            except Exception as e:
                emit_segmentation("encoded", req_id, error=f"Encode error: {e}")

        elif cmd == "segment":
            # ── Segment: run point/box prompts to get masks ──
            t0 = time.perf_counter()
            if current_image is None:
                emit_segmentation("segmented", req_id, error="No image encoded — send encode first")
                continue

            try:
                points_raw = msg.get("points", [])
                boxes_raw = msg.get("boxes", [])

                point_coords = None
                point_labels = None
                input_box = None

                if points_raw:
                    point_coords = np.array([[p["x"], p["y"]] for p in points_raw])
                    point_labels = np.array([p.get("label", 1) for p in points_raw])

                if boxes_raw:
                    b = boxes_raw[0]
                    input_box = np.array([b["x1"], b["y1"], b["x2"], b["y2"]])

                masks, scores, logits = predictor.predict(
                    point_coords=point_coords,
                    point_labels=point_labels,
                    box=input_box,
                    multimask_output=True,
                )

                # Use best mask
                best_idx = np.argmax(scores)
                mask = masks[best_idx]
                score = float(scores[best_idx])

                # Save mask as PNG
                mask_filename = f"mask_{current_frame_id}_{int(time.time()*1000)}.png"
                mask_path = str(masks_dir / mask_filename)
                cv2.imwrite(mask_path, (mask * 255).astype(np.uint8))

                # Compute bbox from mask
                ys, xs = np.where(mask)
                bbox = [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())] if len(xs) > 0 else [0, 0, 0, 0]

                ms = (time.perf_counter() - t0) * 1000
                perf.record("segment", ms)
                perf.total_segments += 1
                perf.tick()

                # Encode mask as base64 for frontend canvas rendering
                mask_png = cv2.imencode('.png', (mask * 255).astype(np.uint8))[1]
                mask_b64 = base64.b64encode(mask_png.tobytes()).decode()

                emit_segmentation("segmented", req_id, {
                    "frame_id": current_frame_id,
                    "mask_path": mask_path,
                    "mask_b64": mask_b64,
                    "score": round(score, 3),
                    "bbox": bbox,
                    "segment_ms": round(ms, 1),
                    "num_masks": len(masks),
                })
                log(f"Segmented frame {current_frame_id}: score={score:.3f} bbox={bbox} in {ms:.0f}ms")
            except Exception as e:
                emit_segmentation("segmented", req_id, error=f"Segment error: {e}")

        elif cmd == "track":
            # ── Track: encode a new frame and propagate the last mask ──
            t0 = time.perf_counter()
            frame_path = msg.get("frame_path")
            frame_id = msg.get("frame_id", f"track_{int(time.time())}")

            if not frame_path or not Path(frame_path).exists():
                emit_segmentation("tracked", req_id, error=f"Frame not found: {frame_path}")
                continue

            try:
                img = cv2.imread(frame_path)
                img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
                predictor.set_image(img)
                current_image = img
                current_frame_id = frame_id

                # Re-predict with same prompts (simple propagation)
                # For full video tracking, SAM2VideoPredictor is needed
                masks, scores, _ = predictor.predict(
                    point_coords=None,
                    point_labels=None,
                    multimask_output=True,
                )

                best_idx = np.argmax(scores)
                mask = masks[best_idx]
                score = float(scores[best_idx])

                mask_filename = f"track_{frame_id}_{int(time.time()*1000)}.png"
                mask_path = str(masks_dir / mask_filename)
                cv2.imwrite(mask_path, (mask * 255).astype(np.uint8))

                ys, xs = np.where(mask)
                bbox = [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())] if len(xs) > 0 else [0, 0, 0, 0]

                ms = (time.perf_counter() - t0) * 1000
                perf.record("track", ms)
                perf.total_tracks += 1
                perf.tick()

                emit_segmentation("tracked", req_id, {
                    "frame_id": frame_id,
                    "mask_path": mask_path,
                    "score": round(score, 3),
                    "bbox": bbox,
                    "track_ms": round(ms, 1),
                })
                log(f"Tracked frame {frame_id}: score={score:.3f} in {ms:.0f}ms")
            except Exception as e:
                emit_segmentation("tracked", req_id, error=f"Track error: {e}")

        else:
            # Unknown command — echo back for debugging
            log(f"Unknown command: {cmd}")

    perf.emit_final()
    log("Skill exiting cleanly")


if __name__ == "__main__":
    main()
