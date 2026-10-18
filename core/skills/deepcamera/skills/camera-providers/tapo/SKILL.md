---
name: camera-provider-tapo
description: "TP-Link Tapo camera integration — RTSP streaming and ONVIF"
version: 1.0.0

parameters:
  - name: host
    label: "Camera IP"
    type: string
    required: true
    group: Connection

  - name: username
    label: "Tapo Cloud Username"
    type: string
    required: true
    group: Connection

  - name: password
    label: "Tapo Cloud Password"
    type: password
    required: true
    group: Connection

capabilities:
  clip_feed:
    script: scripts/feed.py
    description: "Motion-triggered clip capture"
  discover_cameras:
    script: scripts/discover.py
    description: "Discover Tapo cameras on network"
  live_stream:
    script: scripts/stream.py
    description: "RTSP URL for go2rtc live streaming"
---

# Tapo Camera Provider

Integrates TP-Link Tapo cameras (C200, C310, C320WS, C520WS, etc.) via RTSP and ONVIF.

## Setup

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```
