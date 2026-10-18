---
name: channel-signal
description: "Signal messaging channel for Clawdbot agent"
version: 1.0.0

parameters:
  - name: signal_cli_path
    label: "signal-cli Path"
    type: string
    default: "signal-cli"
    group: Connection

  - name: phone_number
    label: "Bot Phone Number"
    type: string
    required: true
    placeholder: "+1234567890"
    group: Connection

capabilities:
  messaging_channel:
    script: scripts/channel.py
    description: "Signal messaging channel"
    supported_actions:
      - send
      - send_file
      - react
      - reply
---

# Signal Channel

Connect SharpAI Aegis's Clawdbot agent to Signal — the most private messaging channel. Uses signal-cli for bot communication.

## Setup

```bash
# Install signal-cli first: https://github.com/AsamK/signal-cli
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```
