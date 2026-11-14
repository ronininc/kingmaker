---
id: m14-agent-first-tool-design
name: Agent-First Tool Design (doctrine note)
source: Angus public post 2026-09-01 (agent-first software guide; his first version failed on a sales team)
trigger: a new internal tool or CRM surface is designed
inputs: the tool's spec draft
tools_local: this checklist
outputs: a design ruling per surface: agent-usable or not, and why
---
Checklist (from the source's failure, generalised):
1. Can an agent complete the core job through the tool's API/CLI without a human clicking? If it needs the UI, it's not agent-first.
2. Are states readable as structured data (levels of context, per m05), not screenshots?
3. Are actions reversible or gated (tap-gate pattern) proportional to their blast radius?
4. Does the tool fail loudly with a reason an agent can act on?
A surface failing 1-2 is redesigned before build, not patched after.
Stoppers: none. Doctrine input only.
