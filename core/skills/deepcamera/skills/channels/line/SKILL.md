---
name: channel-line
description: "LINE messaging channel for Clawdbot agent"
version: 1.0.0

parameters:
  - name: channel_secret
    label: "Channel Secret"
    type: password
    required: true
    group: Connection

  - name: channel_access_token
    label: "Channel Access Token"
    type: password
    required: true
    group: Connection

capabilities:
  messaging_channel:
    script: scripts/channel.py
    description: "LINE messaging channel"
    supported_actions:
      - send
      - send_file
      - reply
---

# LINE Channel

Connect SharpAI Aegis's Clawdbot agent to LINE Messenger. Popular in Japan, Taiwan, Thailand, and Indonesia.

## Setup

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```
