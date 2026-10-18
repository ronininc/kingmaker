---
name: ha-automation-trigger
description: "Fire Aegis detection events in Home Assistant"
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

capabilities:
  automation:
    script: scripts/ha_trigger.py
    description: "Fires aegis_detection events in Home Assistant"
---

# Home Assistant Automation Trigger

Fires events in Home Assistant when Aegis detects activity. Use HA automations to turn on lights, send notifications, or trigger any HA action.

## Example HA Automation

```yaml
automation:
  trigger:
    - platform: event
      event_type: aegis_detection
  condition:
    - condition: template
      value_template: "{{ trigger.event.data.camera == 'front_door' }}"
  action:
    - service: light.turn_on
      target:
        entity_id: light.porch
```

## Setup

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```
