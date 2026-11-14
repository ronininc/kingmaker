---
id: m08-car-sourcing
name: Car Sourcing & Seller Contact (Flipper)
source: Angus public post 2026-10-11 (AI car sourcing, fraud catch, negotiation)
gate: tap-gate.md — seller contact is outbound; per-batch tap + TCPA where applicable
inputs: sourcing criteria (budget, models, radius), listing sources
tools_local: listing readers, local model for listing analysis, CRM for lead records
outputs: vetted deal sheet (listings scored, fraud flags with evidence), then a DRAFT outreach batch
---
Steps:
1. Source listings; score against the Flipper rules (AZ dealer threshold: max 3 deals per rolling 12 months — cherry-pick only the biggest spreads).
2. Fraud screen per listing (photo reuse, title language, price-vs-market outliers) — flags cite the listing evidence, like the source post's crumpled-Corolla catch.
3. Negotiation drafts are prepared per seller, assembled into a tap-gate batch. NOTHING is sent at build or analysis time.
4. After Robbie's tap on the batch hash, sends run through the audit-logged transport. Replies land in the CRM, never in an agent's private thread.
Stoppers: autonomous seller contact REFUSED by design. Dealer-threshold math is checked before any batch is drafted.
