#!/usr/bin/env python3
"""
go2rtc Multi-Camera Streaming Skill — Register RTSP streams with go2rtc.
"""

import sys
import json
import argparse
import signal
from pathlib import Path


def parse_args():
    parser = argparse.ArgumentParser(description="go2rtc Camera Streaming")
    parser.add_argument("--config", type=str)
    parser.add_argument("--streams", type=str, help="camera_name=rtsp://... entries, comma-separated")
    return parser.parse_args()


def load_config(args):
    if args.config and Path(args.config).exists():
        with open(args.config) as f:
            return json.load(f)
    streams = {}
    if args.streams:
        for entry in args.streams.split(","):
            if "=" in entry:
                name, url = entry.split("=", 1)
                streams[name.strip()] = url.strip()
    return {"streams": streams}


def emit(event):
    print(json.dumps(event), flush=True)


def main():
    args = parse_args()
    config = load_config(args)
    streams = config.get("streams", {})

    if not streams:
        emit({"event": "error", "message": "No streams configured. Set streams parameter.", "retriable": False})
        sys.exit(1)

    emit({"event": "ready", "streams": len(streams)})

    # Emit each stream for Aegis to register with go2rtc
    for name, url in streams.items():
        camera_id = name.lower().replace(" ", "_")
        emit({
            "event": "live_stream",
            "camera_id": camera_id,
            "camera_name": name,
            "url": url,
        })

    # Keep alive and listen for commands
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
        if msg.get("command") == "add_stream":
            name = msg.get("camera_name", "camera")
            url = msg.get("url")
            if url:
                emit({"event": "live_stream", "camera_id": name.lower().replace(" ", "_"), "camera_name": name, "url": url})


if __name__ == "__main__":
    main()
