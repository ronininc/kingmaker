#!/usr/bin/env python3
"""
MQTT Automation Skill — Publish Aegis events to MQTT broker.
"""

import sys
import json
import argparse
import signal
from pathlib import Path


def parse_args():
    parser = argparse.ArgumentParser(description="MQTT Automation")
    parser.add_argument("--config", type=str)
    parser.add_argument("--broker", type=str, default="localhost")
    parser.add_argument("--port", type=int, default=1883)
    parser.add_argument("--username", type=str)
    parser.add_argument("--password", type=str)
    parser.add_argument("--topic-prefix", type=str, default="aegis")
    return parser.parse_args()


def load_config(args):
    if args.config and Path(args.config).exists():
        with open(args.config) as f:
            return json.load(f)
    return {
        "broker": args.broker,
        "port": args.port,
        "username": args.username,
        "password": args.password,
        "topic_prefix": args.topic_prefix,
    }


def emit(event):
    print(json.dumps(event), flush=True)


def main():
    args = parse_args()
    config = load_config(args)

    try:
        import paho.mqtt.client as mqtt

        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)

        if config.get("username"):
            client.username_pw_set(config["username"], config.get("password"))

        client.connect(config["broker"], config.get("port", 1883), 60)
        client.loop_start()

        prefix = config.get("topic_prefix", "aegis")
        emit({"event": "ready", "broker": config["broker"], "topic_prefix": prefix})
    except Exception as e:
        emit({"event": "error", "message": f"MQTT connection failed: {e}", "retriable": False})
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
        camera_id = msg.get("camera_id", "unknown")

        if event_type in ("clip_completed", "person_detected", "alert", "camera_offline"):
            topic = f"{prefix}/{camera_id}/{event_type}"
            payload = json.dumps(msg)
            client.publish(topic, payload, qos=1)
            emit({"event": "published", "topic": topic})

    client.loop_stop()
    client.disconnect()


if __name__ == "__main__":
    main()
