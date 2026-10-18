# HomeSec-Bench — Local AI Benchmark for Home Security

> **Qwen3.5-9B scores 93.8%** on 96 real security AI tests — within 4 points of GPT-5.4 — running entirely on a **MacBook Pro M5** at 25 tok/s, 765ms TTFT, using only 13.8 GB of unified memory. Zero API costs. Full data privacy. All local.

## What is HomeSec-Bench?

A benchmark suite that evaluates LLMs on **real home security assistant workflows** — not generic chat, but the actual reasoning, triage, and tool use an AI home security system needs.

All 35 fixture images are AI-generated (no real user footage). Tests run against any OpenAI-compatible endpoint.

## Results: Full Leaderboard

| Rank | Model | Type | Passed | Failed | Pass Rate | Total Time |
|-----:|:------|:-----|-------:|-------:|----------:|-----------:|
| 🥇 1 | **GPT-5.4** | ☁️ Cloud | **94** | 2 | **97.9%** | 2m 22s |
| 🥈 2 | **GPT-5.4-mini** | ☁️ Cloud | **92** | 4 | **95.8%** | 1m 17s |
| 🥉 3 | **Qwen3.5-9B** (Q4_K_M) | 🏠 Local | **90** | 6 | **93.8%** | 5m 23s |
| 3 | **Qwen3.5-27B** (Q4_K_M) | 🏠 Local | **90** | 6 | **93.8%** | 15m 8s |
| 5 | **Qwen3.5-122B-MoE** (IQ1_M) | 🏠 Local | 89 | 7 | 92.7% | 8m 26s |
| 5 | **GPT-5.4-nano** | ☁️ Cloud | 89 | 7 | 92.7% | 1m 34s |
| 7 | **Qwen3.5-35B-MoE** (Q4_K_L) | 🏠 Local | 88 | 8 | 91.7% | 3m 30s |
| 8 | **GPT-5-mini** (2025) | ☁️ Cloud | 60 | 36 | 62.5%* | 7m 38s |

> *GPT-5-mini had many failures due to the API rejecting non-default `temperature` values, so suites using temp=0.7 or temp=0.1 got 0/N. This is an API limitation, not model capability — it's not a fair comparison and is listed for completeness only.

**Key takeaway:** The **Qwen3.5-9B** running locally on a single MacBook Pro scores **93.8%** — only **4.1 points behind GPT-5.4** and within **2 points of GPT-5.4-mini**. It even **beats GPT-5.4-nano** by 1 point. All with zero API costs and complete data privacy.

## Performance: Local vs Cloud

| Model | Type | TTFT (avg) | TTFT (p95) | Decode (tok/s) | GPU Mem |
|:------|:-----|:-----------|:-----------|:---------------|:--------|
| **Qwen3.5-35B-MoE** | 🏠 Local | **435ms** | 673ms | 41.9 | 27.2 GB |
| **GPT-5.4-nano** | ☁️ Cloud | 508ms | 990ms | 136.4 | — |
| **GPT-5.4-mini** | ☁️ Cloud | 553ms | 805ms | 234.5 | — |
| **GPT-5.4** | ☁️ Cloud | 601ms | 1052ms | 73.4 | — |
| **Qwen3.5-9B** | 🏠 Local | 765ms | 1437ms | 25.0 | 13.8 GB |
| **Qwen3.5-122B-MoE** | 🏠 Local | 1627ms | 2331ms | 18.0 | 40.8 GB |
| **Qwen3.5-27B** | 🏠 Local | 2156ms | 3642ms | 10.0 | 24.9 GB |

> The **Qwen3.5-35B-MoE** has a lower TTFT than **all OpenAI cloud models** — 435ms vs. 508ms for GPT-5.4-nano. MoE with only 3B active parameters is remarkably fast for local inference.

## Test Hardware

- **Machine:** MacBook Pro M5 (M5 Pro chip, 18 cores, 64 GB unified memory)
- **Local inference:** llama-server (llama.cpp)
- **Cloud models:** OpenAI API
- **OS:** macOS 15.3 (arm64)

## Test Suites (96 LLM Tests)

| # | Suite | Tests | What It Evaluates |
|--:|:------|------:|:------------------|
| 1 | 📋 Context Preprocessing | 6 | Deduplicating conversations, preserving system msgs |
| 2 | 🏷️ Topic Classification | 4 | Routing queries to the right domain |
| 3 | 🧠 Knowledge Distillation | 5 | Extracting durable facts from conversations |
| 4 | 🔔 Event Deduplication | 8 | "Same person or new visitor?" across cameras |
| 5 | 🔧 Tool Use | 16 | Selecting correct tools with correct parameters |
| 6 | 💬 Chat & JSON Compliance | 11 | Persona, JSON output, multilingual |
| 7 | 🚨 Security Classification | 12 | Normal → Monitor → Suspicious → Critical triage |
| 8 | 📖 Narrative Synthesis | 4 | Summarizing event logs into daily reports |
| 9 | 🛡️ Prompt Injection Resistance | 4 | Role confusion, prompt extraction, escalation |
| 10 | 🔄 Multi-Turn Reasoning | 4 | Reference resolution, temporal carry-over |
| 11 | ⚠️ Error Recovery | 4 | Handling impossible queries, API errors |
| 12 | 🔒 Privacy & Compliance | 3 | PII redaction, illegal surveillance rejection |
| 13 | 📡 Alert Routing | 5 | Channel routing, quiet hours parsing |
| 14 | 💉 Knowledge Injection | 5 | Using injected KIs to personalize responses |
| 15 | 🚨 VLM-to-Alert Triage | 5 | End-to-end: VLM output → urgency → alert dispatch |

## Running the Benchmark

### As an Aegis Skill (automatic)

When spawned by [Aegis-AI](https://github.com/SharpAI/DeepCamera), all configuration is injected via environment variables. The benchmark discovers your LLM gateway and VLM server automatically, generates an HTML report, and opens it when complete.

### Standalone

```bash
# Install dependencies
npm install

# LLM-only (VLM tests skipped)
node scripts/run-benchmark.cjs

# With VLM tests
node scripts/run-benchmark.cjs --vlm http://localhost:5405

# Custom LLM gateway
node scripts/run-benchmark.cjs --gateway http://localhost:5407
```

See [SKILL.md](SKILL.md) for full configuration options and the protocol spec.

## Why This Matters

Most LLM benchmarks test generic capabilities. But when you're building a **real product** — especially one running **entirely on consumer hardware** — you need domain-specific evaluation:

1. ✅ Can it pick the right tool with correct parameters?
2. ✅ Can it classify "masked person at night" as Critical vs. Suspicious?
3. ✅ Can it resist prompt injection disguised as camera event descriptions?
4. ✅ Can it deduplicate the same delivery person seen across 3 cameras?
5. ✅ Can it maintain context across multi-turn security conversations?

A **9B Qwen model on a MacBook Pro** scoring within 4% of GPT-5.4 on these domain tasks — while running fully offline with complete privacy — is the value proposition of local AI.

---

**System:** [Aegis-AI](https://aegis.sharpai.org) — Local-first AI home security on consumer hardware.
**Benchmark:** HomeSec-Bench — 96 LLM + 35 VLM tests across 16 suites.
**Skill Platform:** [DeepCamera](https://github.com/SharpAI/DeepCamera) — Decentralized AI skill ecosystem.
