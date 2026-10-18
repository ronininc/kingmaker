---
name: camera-provider-eufy
description: "Eufy camera integration — local RTSP streaming and event clips"
version: 1.0.0

parameters:
  - name: station_ip
    label: "HomeBase IP"
    type: string
    required: true
    group: Connection

  - name: username
    label: "Eufy Account Email"
    type: string
    required: true
    group: Account

  - name: password
    label: "Eufy Account Password"
    type: password
    required: true
    group: Account

capabilities:
  clip_feed:
    script: scripts/feed.py
    description: "Event-triggered clip capture from Eufy cameras"
  discover_cameras:
    script: scripts/discover.py
    description: "List Eufy cameras on network"
  live_stream:
    script: scripts/stream.py
    description: "RTSP URL for go2rtc live streaming"
---

# Eufy Camera Provider

Integrates Eufy cameras (local P2P or cloud) with SharpAI Aegis. Supports RTSP streaming for live view and event-triggered clip download for analysis.

## Setup

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```
