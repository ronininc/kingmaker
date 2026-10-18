# Vendored skill: deepcamera

- Upstream: https://github.com/SharpAI/DeepCamera @ `933dcc7`
- License: MIT (license file kept in this folder)
- Fetched and vetted: 2026-10-03/04 (claude.ai chat "App Remake Belt skill"), committed to Ronin's skill collection 2026-10-05
- SKILL.md files are byte-for-byte upstream. Not copied: docs/, tests/, evals/, demos/, media files, contributor boilerplate.
- The top-level SKILL.md here is a Ronin-authored router; the upstream skills sit unmodified underneath it.

## Flags

Model weights, driver binaries and fixtures were pruned upstream of this copy, so several sub-skills will not run standalone. Install scripts use sudo / pipe get-pip.py. Channel, webhook, MQTT and Home Assistant sub-skills act outward with no confirmation gate in code.

Kingmaker's governance applies on top: outbound messages, money, credentials, publishing and persistent config stay behind the operator's explicit go.
