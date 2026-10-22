# LittleBrother — Boundary Spec

**Status:** SPEC, 2026-10-19. The stack does not exist yet in any repo. Clean-room build: GPL-3.0 upstream (LittleBrother, N0rz3) is ideas-only, NEVER code.

## The boundary (Robbie's law, 2026-10-18)

- **Kingmaker gets the FULL toolkit.** Uncensored, private side.
- **Solomon gets ONLY the public-source boundary.** IP lookup, public username lookup, and other public-source methods ONLY. No person/phone non-public lookups, no pretexting, no credential-adjacent methods.
- Enforcement is in code, not policy: the Solomon build must REFUSE non-public methods at runtime, with the refusal logged to the audit chain.

## Method classes

### Public-source (ships in BOTH builds)
- Public username lookup across platforms (public profiles only — never behind auth)
- IP address lookup (geolocation, ASN, reputation — public registries only)
- Public record / website reconnaissance (what the target publishes about itself)
- Email format verification against public patterns (never credential checks, never password resets)
- Domain / WHOIS public data

### Full-only (Kingmaker build, NEVER in Solomon)
- Phone number lookup against non-public sources
- Person lookup aggregating non-public data
- Breach-data queries tied to individuals
- Anything requiring pretext, credentialed access, or bypassing an auth wall

### Never (neither build)
- Password resets, credential stuffing, account takeover of any kind
- Camera tracking of individuals, live surveillance
- Pretexting as a capability
- CSAM-adjacent anything (same auto-abort discipline as darkweb-search)

## Governance

- Every lookup runs through the spine. In `custom` mode, public-source methods proceed with audit logging; full-only methods require founder tap.
- In `kingmaker-x-heretic` mode, the full stack is available per-session with founder tap.
- Solomon's build is a compile-time cut: the full-only methods are NOT PRESENT in its binary, not just disabled. A method that doesn't exist can't be invoked.
- Every lookup result is evidence: source, outlet, date — same discipline as the Evidence Dashboard. Unverifiable results are marked, not presented as fact.

## Design constraints

- Local-first. No telemetry, no phoning home.
- Read-only. LittleBrother observes and reports; it never acts on the target.
- Clean-room: reimplemented from method descriptions, never ported from GPL code.
- `solomon` vs `kingmaker` build flag selects the method set at compile time.
