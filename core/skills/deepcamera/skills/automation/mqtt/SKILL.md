---
name: mqtt-automation
description: "Publish Aegis events to MQTT broker"
version: 1.0.0

parameters:
  - name: broker
    label: "MQTT Broker"
    type: string
    default: "localhost"
    required: true
    group: Connection

  - name: port
    label: "Port"
    type: number
    default: 1883
    group: Connection

  - name: username
    label: "Username"
    type: string
    group: Connection

  - name: password
    label: "Password"
    type: password
    group: Connection

  - name: topic_prefix
    label: "Topic Prefix"
    type: string
    default: "aegis"
    group: MQTT

  - name: events
    label: "Events to Publish"
    type: string
    default: "clip_completed,person_detected,alert"
    description: "Comma-separated event types"
    group: MQTT

capabilities:
  automation:
    script: scripts/mqtt_publish.py
    description: "Publishes Aegis events to MQTT topics"
---

# MQTT Automation

Publishes SharpAI Aegis events to an MQTT broker. Integrate with Home Assistant, Node-RED, or any MQTT-compatible automation platform.

## Events Published

| Event | Topic | When |
|-------|-------|------|
| `clip_completed` | `aegis/{camera_id}/clip_completed` | New clip analyzed |
| `person_detected` | `aegis/{camera_id}/person_detected` | Person identified |
| `alert` | `aegis/{camera_id}/alert` | Smart alert triggered |
| `camera_offline` | `aegis/{camera_id}/camera_offline` | Camera stops responding |

## Setup

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```
