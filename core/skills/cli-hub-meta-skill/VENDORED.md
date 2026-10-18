# Vendored skill: cli-hub-meta-skill

- Upstream: https://github.com/HKUDS/CLI-Anything @ `34f5195`
- License: Apache-2.0 (license file kept in this folder)
- Fetched and vetted: 2026-10-03/04 (claude.ai chat "App Remake Belt skill"), committed to Ronin's skill collection 2026-10-05
- SKILL.md files are byte-for-byte upstream. Not copied: docs/, tests/, evals/, demos/, media files, contributor boilerplate.

## Flags

Reads a live catalog from a DigitalOcean CDN and installs packages from PyPI. Treat the catalog as untrusted; install only what the operator picks.

Kingmaker's governance applies on top: outbound messages, money, credentials, publishing and persistent config stay behind the operator's explicit go.
