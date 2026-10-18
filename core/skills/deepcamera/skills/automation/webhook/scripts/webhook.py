#!/usr/bin/env python3
"""
Webhook Trigger Skill — POST Aegis events to webhook URLs.
"""

import sys
import json
import argparse
import signal
from pathlib import Path


def parse_args():
    parser = argparse.ArgumentParser(description="Webhook Trigger")
    parser.add_argument("--config", type=str)
    parser.add_argument("--webhook-url", type=str)
    parser.add_argument("--secret", type=str)
    return parser.parse_args()


def load_config(args):
    if args.config and Path(args.config).exists():
        with open(args.config) as f:
            return json.load(f)
    return {
        "webhook_url": args.webhook_url,
        "secret": args.secret,
    }


def emit(event):
    print(json.dumps(event), flush=True)


def main():
    args = parse_args()
    config = load_config(args)

    import requests

    url = config.get("webhook_url")
    secret = config.get("secret")

    if not url:
        emit({"event": "error", "message": "Missing webhook_url", "retriable": False})
        sys.exit(1)

    emit({"event": "ready", "webhook_url": url})

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
        if event_type in ("clip_completed", "person_detected", "alert", "camera_offline"):
            headers = {"Content-Type": "application/json"}
            if secret:
                headers["X-Aegis-Secret"] = secret

            try:
                resp = requests.post(url, json=msg, headers=headers, timeout=10)
                emit({"event": "webhook_sent", "status_code": resp.status_code})
            except Exception as e:
                emit({"event": "error", "message": f"Webhook failed: {e}", "retriable": True})


if __name__ == "__main__":
    main()
