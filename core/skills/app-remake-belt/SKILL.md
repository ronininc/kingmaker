---
name: "app-remake-belt"
description: "Run Kingmaker's 11-agent remake belt to absorb a tool's capability as a native Kingmaker function: clean-room behavior spec, architecture, design, build, QA, review-mining for the original's unsolved problems, governed ship. Trigger when Robbie wants Kingmaker to remake a capability he saw in a demo, reel, or article."
metadata: { "includeInPrompt": true }
---

# App Remake Belt

## Purpose

Turn any demonstrated capability into a native Kingmaker function through an 11-agent belt. Method distilled from @opusjake's "Replica Skill" reel (https://instagram.com/p/DeB6QU6N4Ec/, posted 2026-10-03) — his 11 skills (Reverse Engineer, Architect, Designer, Builder, Backend Engineer, QA Tester, Inspector, Entrepreneur, Tech Lead, Deployer), his Calendly→"Slotted" demo, his claims (99.2% pixel match, 1,241 reviews mined, 7 issues fixed). His numbers are HIS claims, unverified; the belt structure is the transferable part.

This belt is the **execution layer** under the existing capability-remake pipeline (see `references/kingmaker-wiring.md`): that pipeline owns triage tiers, license/security gates, and activation. This skill owns the agent belt that does the work.

## Workflow

Robbie drops the source (reel, article, screen recording). The belt runs in order. Local agents do the work and drive cloud agents (Claude/Codex) through the CRM; cloud work counts only if the local belt logged it.

1. **Reverse Engineer** — Observe the demonstrated *behavior* only: inputs, outputs, user experience, latency/accuracy. Write a behavioral spec in plain language Robbie can read. Clean-room: no binaries, no decompiling, no private APIs, no copying assets.
2. **Architect** — Design the native Kingmaker system from the spec: components, data flow, where it lives (host-local vs CRM), interfaces with existing belts.
3. **Designer (UX)** — User flows and interaction design for the remade capability inside Robbie's surfaces (CRM, PWA, floor rooms).
4. **Designer (Visual)** — Visual treatment matching the house language (darker Ronin schema; noir where it's customer-facing content).
5. **Builder** — Implement against open components only. Real code, real numbers.
6. **Backend Engineer** — Data layer, storage, API surfaces inside the CRM. No new paid services without Robbie's tap.
7. **QA Tester** — Test the remake against the behavioral spec in the digital twin/sandbox first. Measure with real numbers; never present simulated results as measured.
8. **Inspector** — Audit pass: every step must trace through the governed pipeline (Intent → Evidence → Governance → Decision → Authorization → Audit). Flag anything that can't show its receipts.
9. **Entrepreneur** — Mine public user reviews of the *original* tool for unsolved problems (the reel's genuinely clever move: 1,241 reviews → 7 issues like payments on free plans, double bookings, forced branding). The remake fixes what the original never did — that's the differentiator and the sellable edge.
10. **Tech Lead** — Review the whole build: spec conformance, security pass, license check on every imported component (permissive = import, copyleft = owner review). Reject or rework, never wave through.
11. **Deployer** — Ship behind Robbie's tap. Nothing goes live without his explicit go; the activation is audited end to end.

## Output Contract

Every remake run produces, committed in the CRM:
- `behavior-spec.md` — observed inputs/outputs/expectations, source linked.
- `architecture.md` — components, data flow, interfaces.
- `review-gaps.md` — the original's unsolved user problems found by the Entrepreneur agent, with review sources.
- Sandbox test report with real measured numbers vs the spec.
- Inspector's audit trace + Tech Lead's sign-off (or rework list).
- Activation record: Robbie's tap, timestamp, audit entry.

## Operating Rules

1. **Clean-room only, always.** Remake observed *behavior* with open components. Never copy binaries, assets, tiles, imagery, icons, or sounds; never decompile; never abuse private APIs. This is the legal line — hold it without being reminded.
2. Tier triage from the remake pipeline still applies: if a capability is hardware-bound or a server-side data moat, the belt doesn't start — report it as out of reach with the reason.
3. The Entrepreneur agent mines *public* reviews only, and reports counts honestly ("312 reviews read, 7 recurring complaints") — never inflate to reel-style numbers.
4. Promise spec conformance measured in the sandbox, not pixel-match percentages or timelines from a reel.
5. $0 new spend, RE engines stay off, TCPA attestation untouched, publish toggles untouched — the standing rules ride along on every run.
6. Remakes that clear the belt are products: they belong in the engine/agent-belt roster and the revenue picture, not just in Kingmaker's toolbox.
