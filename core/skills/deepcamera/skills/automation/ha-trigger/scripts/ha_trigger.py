#!/usr/bin/env python3
"""
HA Automation Trigger Skill — Fire events in Home Assistant.
"""

import sys
import json
import argparse
import signal
from pathlib import Path


def parse_args():
    parser = argparse.ArgumentParser(description="HA Automation Trigger")
    parser.add_argument("--config", type=str)
    parser.add_argument("--ha-url", type=str, default="http://homeassistant.local:8123")
    parser.add_argument("--ha-token", type=str)
    return parser.parse_args()


def load_config(args):
    if args.config and Path(args.config).exists():
        with open(args.config) as f:
            return json.load(f)
    return {"ha_url": args.ha_url, "ha_token": args.ha_token}


def emit(event):
    print(json.dumps(event), flush=True)


def main():
    args = parse_args()
    config = load_config(args)

    import requests

    ha_url = config.get("ha_url", "").rstrip("/")
    ha_token = config.get("ha_token")

    if not ha_token:
        emit({"event": "error", "message": "Missing ha_token", "retriable": False})
        sys.exit(1)

    headers = {
        "Authorization": f"Bearer {ha_token}",
        "Content-Type": "application/json",
    }

    # Verify connection
    try:
        resp = requests.get(f"{ha_url}/api/", headers=headers, timeout=5)
        resp.raise_for_status()
        emit({"event": "ready", "ha_url": ha_url, "ha_version": resp.json().get("version", "unknown")})
    except Exception as e:
        emit({"event": "error", "message": f"HA connection failed: {e}", "retriable": False})
        sys.exit(1)

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

        event_type = msg.get("event")
        if event_type in ("clip_completed", "person_detected", "alert"):
            try:
                requests.post(
                    f"{ha_url}/api/events/aegis_detection",
                    headers=headers,
                    json={
                        "camera": msg.get("camera_id", "unknown"),
                        "event_type": event_type,
                        "objects": msg.get("objects", []),
                        "description": msg.get("description", ""),
                        "timestamp": msg.get("timestamp", ""),
                    },
                    timeout=5,
                )
                emit({"event": "ha_event_fired", "event_type": "aegis_detection", "camera": msg.get("camera_id")})
            except Exception as e:
                emit({"event": "error", "message": f"HA event failed: {e}", "retriable": True})


if __name__ == "__main__":
    main()
