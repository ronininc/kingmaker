#!/usr/bin/env python3
"""
LINE Channel Skill — Connect Clawdbot agent to LINE Messenger.
"""

import sys
import json
import argparse
import signal
from pathlib import Path


def parse_args():
    parser = argparse.ArgumentParser(description="LINE Channel")
    parser.add_argument("--config", type=str)
    parser.add_argument("--channel-secret", type=str)
    parser.add_argument("--channel-access-token", type=str)
    return parser.parse_args()


def load_config(args):
    if args.config and Path(args.config).exists():
        with open(args.config) as f:
            return json.load(f)
    return {
        "channel_secret": args.channel_secret,
        "channel_access_token": args.channel_access_token,
    }


def emit(event):
    print(json.dumps(event), flush=True)


def main():
    args = parse_args()
    config = load_config(args)

    if not config.get("channel_access_token"):
        emit({"event": "error", "message": "Missing channel_access_token", "retriable": False})
        sys.exit(1)

    try:
        from linebot.v3.messaging import MessagingApi, Configuration, ApiClient
        from linebot.v3.messaging.models import TextMessage, PushMessageRequest

        configuration = Configuration(access_token=config["channel_access_token"])
        api_client = ApiClient(configuration)
        messaging_api = MessagingApi(api_client)

        emit({"event": "ready", "channel": "line"})
    except Exception as e:
        emit({"event": "error", "message": f"LINE init failed: {e}", "retriable": False})
        sys.exit(1)

    running = True
    def handle_signal(s, f):
        nonlocal running
        running = False
    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    for line_input in sys.stdin:
        if not running:
            break
        line_input = line_input.strip()
        if not line_input:
            continue
        try:
            msg = json.loads(line_input)
        except json.JSONDecodeError:
            continue

        if msg.get("command") == "stop":
            break

        if msg.get("command") == "send":
            user_id = msg.get("user_id")
            text = msg.get("text", "")
            try:
                messaging_api.push_message(PushMessageRequest(
                    to=user_id,
                    messages=[TextMessage(text=text)],
                ))
                emit({"event": "message_sent", "channel": "line", "user_id": user_id})
            except Exception as e:
                emit({"event": "error", "message": f"Send failed: {e}", "retriable": True})


if __name__ == "__main__":
    main()
