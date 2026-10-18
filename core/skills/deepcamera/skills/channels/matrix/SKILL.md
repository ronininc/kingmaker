---
name: channel-matrix
description: "Matrix/Element messaging channel for Clawdbot agent"
version: 1.0.0

parameters:
  - name: homeserver
    label: "Homeserver URL"
    type: url
    default: "https://matrix.org"
    required: true
    group: Connection

  - name: access_token
    label: "Bot Access Token"
    type: password
    required: true
    group: Connection

  - name: room_id
    label: "Room ID"
    type: string
    required: true
    placeholder: "!abc123:matrix.org"
    group: Connection

capabilities:
  messaging_channel:
    script: scripts/channel.py
    description: "Matrix messaging channel"
    supported_actions:
      - send
      - send_file
      - react
      - edit
      - delete
      - reply
      - thread-reply
---

# Matrix Channel

Connect SharpAI Aegis's Clawdbot agent to Matrix/Element. Have full conversations — search clips, get alerts, control cameras — all from your Matrix room.

## Setup

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```
