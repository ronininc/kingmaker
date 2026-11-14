# Decision Models: The Reflex Layer

**Status: UNTESTED live.** No traffic has hit a real `/v1/systemone` endpoint from this module. Unit tests use a mocked transport. Calibrate thresholds against labeled traffic before tightening.

## What this is

A decision model answers typed questions (choice / yes-no / score) about a piece of state in a single forward pass — no text generation. Kingmaker uses this as the **reflex layer**: fast, local, bounded decisions so the large reasoning models only wake up for actual thinking.

The decisions it handles:
- Which engine handles this? (router / writer / coder / vision / reasoning)
- Is this command safe to auto-proceed?
- How urgent is this? Escalate or proceed?
- Which governance spine applies?

## What it is not

- It does not understand anything. It classifies. The options must be well-designed — garbage options in, garbage routing out.
- It does not retain context. It is stateless per request. Whatever assembles the `state` string is where context lives or dies.
- It does not replace the tap gate. Low-confidence decisions escalate to the founder. The reflex layer is fast, not authoritative.

## Transport

Ollama >= 0.35.0 exposes the Jev-compatible `/v1/systemone` endpoint (verified 2026-10-18 against ollama.com/library and multiple independent sources). llama.cpp's llama-server exposes the same shape on port 8080.

Request shape:

```json
POST {baseUrl}/v1/systemone
{
  "model": "tev1",
  "state": "compact state bundle — the sticky note, not the full conversation",
  "questions": {
    "engine": {
      "type": "choice",
      "instructions": "Which engine should handle this?",
      "criteria": { "router": "...", "writer": "...", "coder": "..." }
    }
  }
}
```

Up to 64 questions per call. Response returns each answer with per-option probabilities.

## Model selection (license-gated)

Only permissively-licensed builds are registered. Verified 2026-10-18:

| Model | Size | Download | License | Fits |
|-------|------|----------|---------|------|
| tev1 | 0.8B | 812MB | Apache 2.0 | 8GB+ (the reflex candidate) |
| laya | 0.421B | ~450MB | Apache 2.0 | 8GB+ (smallest, ~33ms) |
| tev1:4b | 4B | 4.5GB | Apache 2.0 | 16GB+ |
| nimble | 9B | 9.5GB | Apache 2.0 (Ollama build) | 24GB+ (<100ms on M5 Max) |
| clef-flash | ? | ? | Apache 2.0 | 16GB+ |
| clef | ? | ? | Apache 2.0 | 24GB+ |

**Excluded:** `nimble-v3` HuggingFace weights (bespokelabs/Bespoke-Nimble-9B-v3) are CC BY-NC 4.0 — non-commercial. `registerModel()` refuses them. The Ollama-distributed `nimble` build is Apache 2.0 and is the one registered. Version matters; the registry enforces it.

**Hardware mapping:** 8GB Macs get tev1-0.8B or laya (sub-second target holds). 24GB+ can run nimble 9B. `DecisionRouter.pickModelForMac()` picks the smallest fit automatically.

## Calibration

Default thresholds (conservative — re-calibrate per deployment):

- `autoProceedThreshold: 0.90` — at or above: proceed without escalation.
- `escalateThreshold: 0.60` — below: hard escalate to founder/human review.
- Between: route to the reasoning model (the previous behavior).

Uncalibrated probabilities make thresholds lies. These defaults assume nothing about calibration quality. Tighten only against labeled traffic.

## Failover

If the endpoint is unreachable or times out (default 2s — a slow reflex is a broken reflex), the router falls back to the reasoning model when a fallback is configured. A missing reflex layer degrades to the old path. It never blocks.

## Integration points

1. **Governance chain Decision step** — consult the reflex layer before waking the reasoning model. See `GovernanceDecisionStep` in `contracts/decision-model.ts`.
2. **Model Router** — the AAA manual's routing table becomes the `criteria` maps. The router's colloquial triggers ("make me a video" → pipeline C) become choice questions the decision model answers in ~100ms.
3. **Audit chain** — every decision outcome (auto-proceed / escalate / route-to-reasoning) is logged with its probabilities. The reflex layer is fast, but it is not unaccountable.

## The state bundle ("sticky note")

Each decision carries its own compact context — the current task, the relevant constraints, the question at hand. Not the full conversation. Building good state bundles is the actual engineering work here; the model is just the classifier at the end of it.
