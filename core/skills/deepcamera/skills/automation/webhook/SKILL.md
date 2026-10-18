---
name: webhook-trigger
description: "POST Aegis events to webhook URLs"
version: 1.0.0

parameters:
  - name: webhook_url
    label: "Webhook URL"
    type: url
    required: true
    group: Connection

  - name: secret
    label: "Webhook Secret"
    type: password
    description: "Sent as X-Aegis-Secret header"
    group: Connection

  - name: events
    label: "Events to Send"
    type: string
    default: "clip_completed,person_detected,alert"
    group: Webhook

capabilities:
  automation:
    script: scripts/webhook.py
    description: "POSTs Aegis events to webhook URL"
---

# Webhook Trigger

Posts SharpAI Aegis events as JSON to any webhook URL. Works with Zapier, IFTTT, Make, n8n, or custom endpoints.

## Setup

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```
