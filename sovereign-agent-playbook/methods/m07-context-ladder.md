---
id: m07-context-ladder
name: Context Ladder Packet
source: Angus public post 2026-07-14 (5 levels from guess to defensible decision)
trigger: any consequential question put to a model
inputs: topic, owner source files
tools_local: build_packet.py (this folder), local model
approval_gates: none
outputs: a 5-level context packet (identity/facts, current state, history/decisions, constraints/rules, the question)
---
Steps:
1. Assemble the packet with build_packet.py from named source files — every level cites its file.
2. The model answers from the packet only; anything outside it is labelled a guess.
3. The packet is saved with the answer, so the reasoning is auditable later.
Stoppers: none.
