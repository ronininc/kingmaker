# Vendored skill: algo-trading

- Upstream: https://github.com/terminalskills/skills @ `a021875`
- License: Apache-2.0 (license file kept in this folder)
- Fetched and vetted: 2026-10-03/04 (claude.ai chat "App Remake Belt skill"), committed to Ronin's skill collection 2026-10-05
- SKILL.md files are byte-for-byte upstream. Not copied: docs/, tests/, evals/, demos/, media files, contributor boilerplate.

## Flags

Has paper-trade-first and risk limits but no kill switch. Execution/infra only; strategy stays the operator's. Live trading is the operator's act only.

Kingmaker's governance applies on top: outbound messages, money, credentials, publishing and persistent config stay behind the operator's explicit go.
