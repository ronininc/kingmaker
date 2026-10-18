---
name: "open-harness"
description: "Run routine coding and agent work on free/open models through a local MIT-licensed harness (Hermes Agent, OpenCode) under Kingmaker's governance — own the weights, keep data private, demote Claude/Codex to hard tasks only. Trigger when Robbie wants $0 coding capacity or a Claude-independent execution path."
metadata: { "includeInPrompt": true }
---

# Open Harness

## Purpose

Give Kingmaker a $0 coding body. Method distilled from @tysn.dev reel "own your weights and keep your data private" (https://www.instagram.com/reel/Dch57p_iA87/): free/open models + a local open-source harness (his picks: Hermes Agent, OpenCode, DeepSeek Harness) + a free-token aggregator (his: FreeLLMAPI), run on a spare/sandbox machine. The reel's "never pay for Claude or Codex again" is HIS claim from August 2026 — free tiers are volatile and free models are not frontier models. What transfers is the architecture: **Kingmaker routes routine work to $0 harnesses and keeps Claude/Codex for the hard stuff.** This is the cost doctrine made executable, and it plugs directly into the engine's Model Router (free providers become registry entries).

## The pieces (vetted 2026-10-05)

- **Hermes Agent** — MIT, https://github.com/NousResearch/hermes-agent (Nous Research). Self-hosted personal agent: CLI, desktop app, messaging gateway (Telegram/Discord/Slack/WhatsApp/Signal), built-in cron, persistent memory, self-improving skills, sandboxed execution. The "night shift": resident, runs 24/7, remembers across sessions.
- **OpenCode** — MIT, https://github.com/anomalyco/opencode (Anomaly, ex-SST). Model-agnostic terminal coding agent (TUI + desktop + IDE), 75+ providers, local-first. The "day shift": interactive coding passes, driven per-task.
- **FreeLLMAPI** — third-party aggregation SERVICE (not open source, not vendored). Claims ~1B free tokens/month across Google/Groq/Cerebras/NVIDIA/Mistral behind one OpenAI-compatible endpoint. Treat as a volatile upstream: verify the free tier is still live at build time, never hard-depend on it, and it enters Kingmaker only as a router provider entry with Robbie's explicit per-batch tap.
- **EXCLUDED: OmniRoute** — the reel itself flags a past malware package issue. Never install, never route through it, never list it as an option.

## Operating rules

1. **Sandbox first (Robbie's self-extension doctrine).** Nothing touches his machines or repos until it has been sandboxed in a digital twin, tested on harmless tasks, and passed. Then reverse-engineer/import per the app-remake-belt intake — MIT licensing allows direct import; do it clean-room anyway so Kingmaker owns the behavior spec.
2. **Governance wraps the harness, never the reverse.** The harness executes; Kingmaker governs: Intent → Evidence → Governance → Decision → Authorization → Audit on every task. The harness never gets standing authorization — Robbie's per-batch tap rule applies to provider enablement and to any task that writes, sends, or spends.
3. **Data stays local.** Own-weights/local-first is the point. No repo contents, CRM data, or credentials leave his machines to a third-party aggregator without his explicit tap for that batch. FreeLLMAPI-class services are untrusted upstreams: assume prompts are visible to them.
4. **Routing policy (with the Model Router).** Routine implementation, refactors, test runs, and digest generation → $0 harness. Architecture decisions, governance changes, anything touching money/credentials/outreach → Claude/Codex. The router logs which model served each task, why, and at what cost ($0 entries included).
5. **No credential sprawl.** Provider keys live in the router's encrypted store, mode-600, never in chat/logs/plaintext. Free-tier API keys are still keys.
6. **Volatility check.** Free-token programs die without notice. The skill re-verifies every free upstream's terms before each build that depends on it, and every design keeps a paid/frontier fallback path so a dead free tier degrades to "costs money" instead of "stops working."
7. **Claude is demoted, not deleted.** The honest target: Claude handles the 10% of tasks that need frontier judgment; the harness handles the 90% that need hands. Full replacement is a claim to be proven by measurement (task success rate on the harness vs Claude), not assumed from a reel.

## Intake checklist (for Claude/Codex building this)

1. Sandbox Hermes Agent AND OpenCode in a digital twin; run the same 5 routine CRM tasks through each; record success rate, time, and cost vs Claude.
2. Verify FreeLLMAPI's current free tier (or pick the live equivalent); register it as a Model Router provider entry — Robbie's tap required.
3. Write the behavior spec: what the harness may do unsupervised (read, draft, test) vs what needs Robbie's tap (write to prod, send, spend).
4. Wire the router policy: routine → harness, hard → Claude/Codex, with audit logging on every route.
5. Register this skill on the CRM skill index. Report measured results before claiming any replacement.

## What this skill does NOT do
- It does not promise $0 forever — free tiers change; the design degrades gracefully.
- It does not send his code or data to aggregators by default — local-first, his tap otherwise.
- It does not touch OmniRoute, ever.
- It does not grant the harness standing authorization — Robbie's per-batch tap rule stands.
