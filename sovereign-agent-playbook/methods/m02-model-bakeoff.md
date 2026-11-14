---
id: m02-model-bakeoff
name: Model Bake-Off Eval
source: Angus public post 2026-09-25 (two models, same campaign brief, raw results)
trigger: a new model candidate or a seat change is proposed
inputs: one real task brief, 2+ candidate models (local seats first), a fixed rubric
tools_local: harness2 model transport (ollama / openai-compatible), rubric judge call
approval_gates: none to run; seat changes need the founder tap (registry pin rules)
outputs: side-by-side outputs + judge scores + cost/time per model, filed as a bench receipt
---
Steps:
1. Freeze the brief and the rubric before any model runs. Same prompt, temp 0, same context.
2. Run each candidate through the harness transport; record tokens, latency, output verbatim.
3. Judge pass with the rubric (separate call); blind the judge to model names.
4. File the receipt (bench/ format) — a pick changes only on measured results, never on claims.
Stoppers: none. Cloud candidates only via the Model Router escalation lane, disclosed in the receipt.
