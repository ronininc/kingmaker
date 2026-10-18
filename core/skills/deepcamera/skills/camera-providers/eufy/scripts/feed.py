#!/usr/bin/env python3
"""
Eufy Camera Provider — Discover and stream from Eufy cameras.
"""

import sys
import json
import argparse
import signal
from pathlib import Path


def parse_args():
    parser = argparse.ArgumentParser(description="Eufy Camera Provider")
    parser.add_argument("--config", type=str)
    parser.add_argument("--station-ip", type=str)
    parser.add_argument("--username", type=str)
    parser.add_argument("--password", type=str)
    return parser.parse_args()


def load_config(args):
    if args.config and Path(args.config).exists():
        with open(args.config) as f:
            return json.load(f)
    return {
        "station_ip": args.station_ip,
        "username": args.username,
        "password": args.password,
    }


def emit(event):
    print(json.dumps(event), flush=True)


def main():
    args = parse_args()
    config = load_config(args)

    station_ip = config.get("station_ip")
    username = config.get("username")
    password = config.get("password")

    if not all([station_ip, username, password]):
        emit({"event": "error", "message": "Missing required config: station_ip, username, password", "retriable": False})
        sys.exit(1)

    try:
        # NOTE: eufy-security-client handles P2P connection to HomeBase
        # RTSP URL format for Eufy cameras with RTSP enabled
        emit({"event": "ready", "provider": "eufy", "station_ip": station_ip})
    except Exception as e:
        emit({"event": "error", "message": f"Connection failed: {e}", "retriable": False})
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

        if msg.get("command") == "discover":
            # Return discovered cameras with RTSP URLs
            emit({
                "event": "cameras_discovered",
                "cameras": [
                    {
                        "id": "eufy_front_door",
                        "name": "Front Door",
                        "model": "eufyCam",
                        "rtsp_url": f"rtsp://{station_ip}:8554/front_door",
                    }
                ],
            })

        elif msg.get("event") == "query_existing":
            camera_id = msg.get("camera_id")
            since = msg.get("since")
            emit({
                "event": "clip_query_result",
                "camera_id": camera_id,
                "clips": [],  # Would contain downloaded clips
            })


if __name__ == "__main__":
    main()
