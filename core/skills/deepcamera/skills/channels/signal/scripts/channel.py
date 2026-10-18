#!/usr/bin/env python3
"""
Signal Channel Skill — Connect Clawdbot agent to Signal via signal-cli.
"""

import sys
import json
import argparse
import signal as sig
import subprocess
from pathlib import Path


def parse_args():
    parser = argparse.ArgumentParser(description="Signal Channel")
    parser.add_argument("--config", type=str)
    parser.add_argument("--signal-cli-path", type=str, default="signal-cli")
    parser.add_argument("--phone-number", type=str)
    return parser.parse_args()


def load_config(args):
    if args.config and Path(args.config).exists():
        with open(args.config) as f:
            return json.load(f)
    return {
        "signal_cli_path": args.signal_cli_path,
        "phone_number": args.phone_number,
    }


def emit(event):
    print(json.dumps(event), flush=True)


def main():
    args = parse_args()
    config = load_config(args)

    cli = config.get("signal_cli_path", "signal-cli")
    phone = config.get("phone_number")

    if not phone:
        emit({"event": "error", "message": "Missing phone_number", "retriable": False})
        sys.exit(1)

    # Verify signal-cli is available
    try:
        result = subprocess.run([cli, "--version"], capture_output=True, text=True, timeout=5)
        version = result.stdout.strip()
        emit({"event": "ready", "channel": "signal", "version": version, "phone": phone})
    except FileNotFoundError:
        emit({"event": "error", "message": f"signal-cli not found at: {cli}", "retriable": False})
        sys.exit(1)

    running = True
    def handle_signal(s, f):
        nonlocal running
        running = False
    sig.signal(sig.SIGTERM, handle_signal)
    sig.signal(sig.SIGINT, handle_signal)

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

        if msg.get("command") == "send":
            recipient = msg.get("recipient")
            text = msg.get("text", "")
            try:
                subprocess.run(
                    [cli, "-a", phone, "send", "-m", text, recipient],
                    capture_output=True, text=True, timeout=30,
                )
                emit({"event": "message_sent", "channel": "signal", "recipient": recipient})
            except Exception as e:
                emit({"event": "error", "message": f"Send failed: {e}", "retriable": True})


if __name__ == "__main__":
    main()
