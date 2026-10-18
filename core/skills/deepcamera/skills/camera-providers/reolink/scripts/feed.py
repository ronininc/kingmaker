#!/usr/bin/env python3
"""
Reolink Camera Provider — RTSP streaming and HTTP API integration.
"""

import sys
import json
import argparse
import signal
from pathlib import Path


def parse_args():
    parser = argparse.ArgumentParser(description="Reolink Camera Provider")
    parser.add_argument("--config", type=str)
    parser.add_argument("--host", type=str)
    parser.add_argument("--username", type=str, default="admin")
    parser.add_argument("--password", type=str)
    parser.add_argument("--channel", type=int, default=0)
    return parser.parse_args()


def load_config(args):
    if args.config and Path(args.config).exists():
        with open(args.config) as f:
            return json.load(f)
    return {
        "host": args.host,
        "username": args.username,
        "password": args.password,
        "channel": args.channel,
    }


def emit(event):
    print(json.dumps(event), flush=True)


def main():
    args = parse_args()
    config = load_config(args)

    host = config.get("host")
    username = config.get("username", "admin")
    password = config.get("password")
    channel = config.get("channel", 0)

    if not host or not password:
        emit({"event": "error", "message": "Missing required config: host, password", "retriable": False})
        sys.exit(1)

    # Reolink RTSP URL format
    rtsp_url = f"rtsp://{username}:{password}@{host}:554/h264Preview_{channel + 1:02d}_main"
    rtsp_sub = f"rtsp://{username}:{password}@{host}:554/h264Preview_{channel + 1:02d}_sub"

    emit({
        "event": "ready",
        "provider": "reolink",
        "host": host,
    })

    # Emit live stream URL for go2rtc registration
    emit({
        "event": "live_stream",
        "camera_id": f"reolink_{host.replace('.', '_')}",
        "camera_name": f"Reolink {host}",
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
        if msg.get("command") == "snapshot":
            import urllib.request
            import tempfile
            try:
                snapshot_url = f"http://{host}/cgi-bin/api.cgi?cmd=Snap&channel={channel}&rs=&user={username}&password={password}"
                tmp = tempfile.mktemp(suffix=".jpg", dir="/tmp")
                urllib.request.urlretrieve(snapshot_url, tmp)
                emit({"event": "snapshot", "camera_id": f"reolink_{host.replace('.', '_')}", "path": tmp})
            except Exception as e:
                emit({"event": "error", "message": f"Snapshot error: {e}", "retriable": True})


if __name__ == "__main__":
    main()
