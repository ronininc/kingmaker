#!/usr/bin/env python3
"""
Home Assistant Bridge Skill — Bidirectional HA ↔ Aegis integration.

Captures frames from HA camera entities and feeds them into Aegis's pipeline.
Pushes detection results back as HA image_processing entities.
"""

import sys
import json
import argparse
import signal
import time
import tempfile
from pathlib import Path


def parse_args():
    parser = argparse.ArgumentParser(description="Home Assistant Bridge")
    parser.add_argument("--config", type=str)
    parser.add_argument("--ha-url", type=str, default="http://homeassistant.local:8123")
    parser.add_argument("--ha-token", type=str)
    parser.add_argument("--cameras", type=str, help="Comma-separated HA camera entity IDs")
    parser.add_argument("--poll-interval", type=int, default=5)
    return parser.parse_args()


def load_config(args):
    if args.config and Path(args.config).exists():
        with open(args.config) as f:
            return json.load(f)
    cameras = []
    if args.cameras:
        cameras = [c.strip() for c in args.cameras.split(",")]
    return {
        "ha_url": args.ha_url,
        "ha_token": args.ha_token,
        "cameras": cameras,
        "poll_interval": args.poll_interval,
    }


def emit(event):
    print(json.dumps(event), flush=True)


def main():
    args = parse_args()
    config = load_config(args)

    import requests

    ha_url = config.get("ha_url", "").rstrip("/")
    ha_token = config.get("ha_token")
    cameras = config.get("cameras", [])
    poll_interval = config.get("poll_interval", 5)

    if not ha_token:
        emit({"event": "error", "message": "Missing ha_token", "retriable": False})
        sys.exit(1)

    headers = {
        "Authorization": f"Bearer {ha_token}",
        "Content-Type": "application/json",
    }

    # Discover cameras if not specified
    if not cameras:
        try:
            resp = requests.get(f"{ha_url}/api/states", headers=headers, timeout=10)
            resp.raise_for_status()
            states = resp.json()
            cameras = [s["entity_id"] for s in states if s["entity_id"].startswith("camera.")]
        except Exception as e:
            emit({"event": "error", "message": f"Camera discovery failed: {e}", "retriable": False})
            sys.exit(1)

    emit({
        "event": "ready",
        "ha_url": ha_url,
        "cameras": cameras,
        "poll_interval": poll_interval,
    })

    running = True
    def handle_signal(s, f):
        nonlocal running
        running = False
    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    # Frame capture loop
    while running:
        for camera_entity in cameras:
            if not running:
                break
            try:
                # Get camera snapshot via HA API
                resp = requests.get(
                    f"{ha_url}/api/camera_proxy/{camera_entity}",
                    headers={"Authorization": f"Bearer {ha_token}"},
                    timeout=10,
                )
                if resp.status_code == 200:
                    # Save frame
                    tmp = tempfile.mktemp(suffix=".jpg", dir="/tmp")
                    with open(tmp, "wb") as f:
                        f.write(resp.content)

                    # Emit frame for Aegis to process
                    camera_id = camera_entity.replace("camera.", "ha_")
                    emit({
                        "event": "frame",
                        "camera_id": camera_id,
                        "camera_name": camera_entity,
                        "frame_path": tmp,
                        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                        "source": "homeassistant",
                    })
            except Exception as e:
                emit({"event": "error", "message": f"Frame capture failed for {camera_entity}: {e}", "retriable": True})

        # Check stdin for commands (non-blocking)
        time.sleep(poll_interval)


if __name__ == "__main__":
    main()
