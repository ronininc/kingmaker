---
id: m05-context-levels-analysis
name: Context-Levels Record Analysis
source: Angus public post 2026-07-31 (AI-native CRM from 12,130 records)
trigger: CRM analysis request (pipeline health, lead quality, rep performance)
inputs: CRM records export
tools_local: local model, structured record reader
approval_gates: read-only; any CRM write follows the normal desk rules
outputs: analysis organised by context level (record → contact → account → pattern), each level labelled
---
Steps:
1. Read records as levels of context, not charts: raw record, contact history, account picture, cross-account pattern.
2. Findings must name the level they were derived at; pattern-level claims need counts.
3. Deliver with record ids behind every finding.
Stoppers: none. Public-records rules unchanged; this reads the owner's own CRM only.
