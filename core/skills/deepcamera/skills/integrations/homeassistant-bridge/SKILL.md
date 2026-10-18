---
name: homeassistant-bridge
description: "Bidirectional Home Assistant integration — HA cameras in, detection results out"
version: 1.0.0

parameters:
  - name: ha_url
    label: "Home Assistant URL"
    type: url
    default: "http://homeassistant.local:8123"
    required: true
    group: Connection

  - name: ha_token
    label: "Long-Lived Access Token"
    type: password
    required: true
    group: Connection

  - name: cameras
    label: "HA Camera Entities"
    type: string
    placeholder: "camera.front_door, camera.backyard"
    description: "Comma-separated HA camera entity IDs"
    group: Cameras

  - name: poll_interval
    label: "Frame Capture Interval (seconds)"
    type: number
    min: 1
    max: 60
    default: 5
    group: Processing

capabilities:
  ha_bridge:
    script: scripts/bridge.py
    description: "Bidirectional HA ↔ Aegis integration"
---

# Home Assistant Bridge

Bidirectional integration: HA camera feeds flow into Aegis's AI pipeline (detection → VLM → REID), and analysis results flow back as HA `image_processing` entities for automations.

## How It Works

```
Home Assistant                    SharpAI Aegis
──────────────                    ──────────────
camera.front_door ───────────►    Detection → VLM → REID
camera.backyard                        ↓
                                  Analysis results
image_processing.aegis_*  ◄──────  → objects, descriptions
  → HA automations                   → person identity
  → notifications                    → smart alerts
```

## Wraps

This skill builds on DeepCamera's `src/home-assistant-py/` and `src/home-assistant-nodejs/` modules.

## Setup

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```
