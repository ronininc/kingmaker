---
name: go2rtc-cameras
description: "Multi-camera RTSP to WebRTC streaming via go2rtc"
version: 1.0.0

parameters:
  - name: streams
    label: "RTSP Stream URLs"
    type: string
    description: "Comma-separated camera_name=rtsp://... entries"
    placeholder: "front_door=rtsp://192.168.1.100:554/stream1"
    required: true
    group: Streams

capabilities:
  live_stream:
    script: scripts/stream.py
    description: "Register RTSP streams with go2rtc for WebRTC playback"
---

# go2rtc Multi-Camera Streaming

Registers RTSP camera streams with SharpAI Aegis's go2rtc sidecar for low-latency WebRTC live view in the browser.

## How It Works

```
Your Cameras (RTSP)          go2rtc (in Aegis)           Browser
───────────────────          ─────────────────           ───────
rtsp://cam1:554/stream ───►  /api/webrtc?src=cam1  ───► WebRTC Player
rtsp://cam2:554/stream ───►  /api/webrtc?src=cam2  ───► WebRTC Player
rtsp://cam3:554/stream ───►  /api/webrtc?src=cam3  ───► WebRTC Player
```

## Supported Sources

go2rtc accepts any stream source:
- `rtsp://` — standard RTSP cameras
- `rtmp://` — RTMP streams
- `http://` — MJPEG or HLS streams
- `ffmpeg:` — FFmpeg pipeline
- `exec:` — custom command

## Protocol

### Skill → Aegis (stdout)
```jsonl
{"event": "ready", "streams": 3}
{"event": "live_stream", "camera_id": "front_door", "camera_name": "Front Door", "url": "rtsp://192.168.1.100:554/stream1"}
{"event": "live_stream", "camera_id": "backyard", "camera_name": "Backyard", "url": "rtsp://192.168.1.101:554/stream1"}
```

Aegis registers each stream with go2rtc via IPC:
- `go2rtc:add-stream` → registers camera
- `go2rtc:connection-info` → returns WebRTC URL for player

## Setup

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```
