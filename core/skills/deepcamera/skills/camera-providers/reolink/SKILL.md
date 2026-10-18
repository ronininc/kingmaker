---
name: camera-provider-reolink
description: "Reolink camera integration — RTSP and HTTP API"
version: 1.0.0

parameters:
  - name: host
    label: "Camera IP"
    type: string
    required: true
    group: Connection

  - name: username
    label: "Username"
    type: string
    default: "admin"
    group: Connection

  - name: password
    label: "Password"
    type: password
    required: true
    group: Connection

  - name: channel
    label: "Channel"
    type: number
    default: 0
    group: Connection

capabilities:
  clip_feed:
    script: scripts/feed.py
    description: "Motion-triggered clip capture from Reolink cameras"
  discover_cameras:
    script: scripts/discover.py
    description: "Discover Reolink cameras via ONVIF"
  live_stream:
    script: scripts/stream.py
    description: "RTSP URL for go2rtc live streaming"
  snapshot:
    script: scripts/snapshot.py
    description: "HTTP API snapshot"
---

# Reolink Camera Provider

Integrates Reolink cameras via their HTTP API and RTSP streams. Supports PoE and WiFi models.

## Supported Models

- Reolink RLC-810A, RLC-820A, RLC-1210A
- Reolink Argus series (battery)
- Reolink Duo / TrackMix
- Any Reolink with RTSP enabled

## Setup

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```
