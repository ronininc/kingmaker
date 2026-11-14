---
id: m09-followup-system
name: Long-Cycle Follow-Up System
source: Angus public post 2026-10-06 (the 9-word follow-up that closed a $16M deal after 5 silent years)
gate: tap-gate.md — every send batch needs the tap; the attestation is Robbie's alone
inputs: CRM dormant-lead list, per-lead history
tools_local: CRM reads, local model for per-lead context lines
outputs: scheduled follow-up batches (drafted, gated), response tracking in the CRM
---
Steps:
1. Select dormant leads by silence window and last-context; exclude anyone on a do-not-contact list, no exceptions.
2. Draft the short re-opening message per lead (the source's lesson: brief, no pitch, one human line of context from the lead's own history).
3. Assemble into tap-gate batches by window; Robbie taps the batch hash; sends audit-log.
4. Responses disposition the lead in the CRM (alive / not now / dead + reason) — filings feed lead-sourcing refinement.
Stoppers: no batch sends without the tap; no guilt-trip or fake-urgency copy; frequency capped (one touch per window per lead).
