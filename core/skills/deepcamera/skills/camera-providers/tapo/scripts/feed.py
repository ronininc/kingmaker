#!/usr/bin/env python3
"""
Tapo Camera Provider — RTSP streaming and ONVIF for TP-Link Tapo cameras.
"""

import sys
import json
import argparse
import signal
import hashlib
from pathlib import Path


def parse_args():
    parser = argparse.ArgumentParser(description="Tapo Camera Provider")
    parser.add_argument("--config", type=str)
    parser.add_argument("--host", type=str)
    parser.add_argument("--username", type=str)
    parser.add_argument("--password", type=str)
    return parser.parse_args()


def load_config(args):
    if args.config and Path(args.config).exists():
        with open(args.config) as f:
            return json.load(f)
    return {
        "host": args.host,
        "username": args.username,
        "password": args.password,
    }


def emit(event):
    print(json.dumps(event), flush=True)


def main():
    args = parse_args()
    config = load_config(args)

    host = config.get("host")
    username = config.get("username")
    password = config.get("password")

    if not all([host, username, password]):
        emit({"event": "error", "message": "Missing required config: host, username, password", "retriable": False})
        sys.exit(1)

    # Tapo cameras use cloud credentials hashed for RTSP
    # Stream 1 = high quality, Stream 2 = low quality
    rtsp_url = f"rtsp://{username}:{password}@{host}:554/stream1"
    rtsp_sub = f"rtsp://{username}:{password}@{host}:554/stream2"

    emit({"event": "ready", "provider": "tapo", "host": host})

    emit({
        "event": "live_stream",
        "camera_id": f"tapo_{host.replace('.', '_')}",
        "camera_name": f"Tapo {host}",
        "url": rtsp_url,
        "sub_url": rtsp_sub,
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


if __name__ == "__main__":
    main()
