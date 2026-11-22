# THE AUDIT — Folded Kingmaker Stack

**Date:** 2026-10-20 · **Scope:** ~/workspace/kingmaker-stack/ and its five component homes
**Standard (Robbie's, governing every line below):** only MEASURED numbers count as gains. Estimates are labeled **ESTIMATE**. Anything that cannot show a number goes on the cut/watch list with the one measurement that would prove it.

---

## PART 1 — Integrity + Edge0 tensor audit

### 1(a) verify-all re-run — confirmed 123/123

Re-run by this audit on 2026-10-20 (`node ~/workspace/kingmaker-stack/verify-all.mjs`, exit 0). Verbatim output:

```
PASS  router/governed-router — 10/10 (0.3s)
PASS  router/federation-memory — 10/10 (0.1s)
PASS  router/guardrails-doctor — 8/8 (0.4s)
PASS  router/guardrails-router-wiring — 2/2 (0.2s)
PASS  littlebrother/acceptance — 13/13 (0.2s)
PASS  space-cell/cell — 10/10 (0.1s)
PASS  training-data-pipeline/pipeline — 28/28 (0.1s)
PASS  edge0-augmentation/truth-pass+lane-policy — 20/20 (0.1s)
PASS  stack/seams — 22/22 (0.1s)

STACK GREEN — 9/9 suites passed; 123/123 checks counted across suites.
```

Matches the fold-in record exactly. The folded stack is internally consistent and every suite passes from one runner.

### 1(b) Edge0 MTP tensor audit — **HEAD ABSENT**

- **Repo:** `Edge0/Edge0-35B-A3B-preview` (from `~/workspace/kingmaker-survey/lib/edge0-candidate.json`).
- **Method:** fetched ONLY `model.safetensors.index.json` (HTTP 200, 180,182 bytes — metadata, no weights).
- **Index contents:** 1,757 tensors across 4 shards; `metadata.total_size` = 20,401,929,952 bytes; **every** key sits under the `language_model.` prefix.
- **`mtp.*` tensors: 0.** Zero keys contain `mtp` anywhere in the index.
- **The config still declares it:** `sources/edge0_config.json` line 724 — `"mtp_num_hidden_layers": 1`. Config says the head exists; the shipped weights do not contain it.

**Verdict: HEAD ABSENT — stripped in conversion**, exactly the failure mode the MTP verification memo predicted for this base architecture on the standard MLX path. There is nothing to switch on. An MTP build would require recovering the head from the Qwen3.6-35B-A3B bf16 base as a sidecar, then building a draft/verify loop that coexists with Edge0's one-step-ahead prerouter, then measuring acceptance on the 4-bit weights before any speedup number may be spoken. Until step one happens, MTP is a **CUT CANDIDATE** (see Part 2) and must never be a tier-grading assumption.

---

## PART 2 — Performance ledger

| Component | Claim | Measured evidence | Verdict |
|---|---|---|---|
| **Codemod prefilter** (router) | Mechanical edits resolve with no model call, cost $0 | `router-phase2/tests/governed-router.test.mjs` case 1 asserts `runnerCalls === 0` and `costUsd === 0` (test lines 52–68); suite 10/10 in the fresh verify-all run above | **EARNS ITS PLACE** (mechanism proven; share of live workload unmeasured — no live traffic exists yet) |
| **Routing bandit** (router) | Cost-shaped learning: expensive success on a simple task is scored as waste | Test group 8 asserts the shaping arithmetic — frontier success on a low bucket banks **0.4** vs cheap success **1.0**; outcomes accepted only from the verifier; state persists. Arithmetic measured; production dollar savings = not measured (zero live routes) | **UNPROVEN-YET** |
| **Lane policy** (augmentation) | Per-lane generation caps cut wasted tokens | Budgets in `lane-policy.mjs`: reflex **256**, standard **2,048**, deep **8,192** maxTokens (32× spread reflex→deep), enforced by clamp + mid-flight usage check; 20/20 suite. Budget enforcement measured. Actual savings = **ESTIMATE** (20–40% on reflex calls) until live traffic is metered | **UNPROVEN-YET** |
| **Condense truth pass** (augmentation) | The planner prices Edge0 truthfully | KV corrected **40,960 → 10,240 B/token** (Edge0 carries KV on 10 of 40 layers — the old planner overstated 4×); at native 262,144 context the corrected fp8 cache is **exactly 2.5 GiB**; MoE gate census 21,053,440 params, fp8 pin costs **9.21 MB** delta; affine-int4-g64 byte model predicted MiniCPM5-1B's real MLX artifact at 607.9 MB vs actual 608.0 MB (**0.02% error**). 20/20 suite, all values from the real shipped configs | **EARNS ITS PLACE** |
| **Guardrails + doctor + rollback** (router) | Integrity machinery: bad input flagged, corruption caught, state restorable | 8/8 + 2/2 suites: injection attempt flagged, never executed; traversal/symlink escapes refused; doctor exits 1 on corrupted bandit state and on a tampered chain, with the forged entry located at its exact sequence; snapshot → mutate → restore is byte-identical; tampered snapshot and wrong pinned key refused, live tree untouched | **EARNS ITS PLACE** (integrity claim, measured — these claim safety, not speed) |
| **Federation + memory-audit + drift** (router) | Governed cross-machine coordination; provenance-mandatory shared memory; plan-vs-output drift flags | 10/10 suite against an in-memory fake bus between two in-process nodes: first contact refused without consent token, handshake lands both sides at `identified`, policy caps enforced, unprovenanced write throws, revoke-by-provenance removes exactly the teacher's entries, drift case flags at 0.6 divergence. **No live cross-machine run has ever happened** | **UNPROVEN-YET** (correctness proven; performance and live behavior unproven) |
| **SPACE cell** (v0.4.1) | Governed microVM execution: intent audited first, credentials brokered, egress host-controlled | 10/10 suite against a fake implementing SPACE's documented API (real API shape taken from Perplexity's OpenAPI). **No live SPACE host exists yet** — the Linux host (DGX Spark) does not arrive until Oct 23 | **UNPROVEN-YET** (governance proven vs the contract; live unproven) |
| **LittleBrother — boundary** | Solomon build structurally cannot reach full-only methods | 13/13: full module never loaded in solomon mode; bundle physically excludes it; build fails if a forbidden reference survives; every call and refusal hash-chain logged | **EARNS ITS PLACE** (containment is its claim, and containment is measured) |
| **LittleBrother — full methods** | Tap-gated full OSINT capability | Full methods are governed **stubs** by design — they refuse without a founder tap and return marked stub records with one. No live non-public source has ever been wired | **UNPROVEN-YET — by design** (capability awaits a founder act, not a test) |
| **Corpus builder** (training pipeline) | License-clean, deduped, split corpora from Cage-triaged sources | `corpora/tool-use-brains/manifest.json`: input **112,960** rows (glaive-function-calling-v2, apache-2.0, verified clear) → **103,915** deduped, **9,045 duplicates dropped (8.0%)** → train **93,527** / eval **10,388**, seed 42, `solomonSafe: true` | **EARNS ITS PLACE** (yield measured, on disk) |
| **Exhaust harvester** (training pipeline) | Fleet audit chains become labeled training records | 28/28 suite on **synthetic** chains (both log formats, tampered chain refused). Live fleet exhaust harvested to date: **zero records** — the fleet has not run real governed work yet | **UNPROVEN-YET** |
| **Disc / payload discipline** (stack) | Folded stack ships code only; data streams post-install | Byte census (`stack-manifest.json`, 2026-10-20): total stack **code 325,433 B** (router 140,089 · space-cell 51,947 · pipeline 41,687 · littlebrother 37,877 · augmentation 32,497 · stack 21,336). Data 294,131,391 B is 99.9% the tool-use corpus (294,009,909 B) — it never ships in the payload. v0.4.0 install ≈ **29 GB** (measured — it forced deletions on a 512 GB Mac) vs v0.4.1 lean ≈ 10 GB = **DESIGN TARGET** — no 4.1 payload has been built or installed yet | **EARNS ITS PLACE** as discipline (census measured); the ~10 GB figure is **UNPROVEN** until a payload exists |

---

## CUT / WATCH list — no measured live gain yet

Each item: the **one** measurement that proves it.

1. **MTP speculative decoding — CUT CANDIDATE.** Tensor audit: head absent from the shipped artifact. Proving measurement: head recovered as a sidecar + draft acceptance rate measured on the 4-bit weights. Until then it stays out of every plan and tier grade.
2. **Routing bandit (live savings).** Proving measurement: 30 days of live routes — dollars spent vs a flat-frontier baseline, computed from the router's own audit chain.
3. **Lane policy (token savings).** Proving measurement: metered output tokens on live reflex-lane calls vs the pre-policy baseline. The 20–40% figure is an ESTIMATE until then.
4. **Federation.** Proving measurement: one real two-machine session (Mac ↔ Spark) — handshake, trust ladder, one governed task completed across the boundary.
5. **Memory-audit + drift (live).** Proving measurement: one live poisoned-pattern revocation and one real drift flag raised on live work.
6. **SPACE cell (live).** Proving measurement: first governed run against a live SPACE host on the Spark (hardware lands Oct 23).
7. **LittleBrother full methods.** Proving measurement: founder wires one live source; one tap-gated run completes end-to-end with its evidence record on the audit chain.
8. **Exhaust harvester (live).** Proving measurement: first harvest over a real fleet audit chain — gold records out, count > 0.
9. **v0.4.1 lean install (~10 GB).** Proving measurement: built 4.1 payload installed on the 8 GB M3 — installed footprint on disk, no deletions required.

Nothing else is cut. The components marked UNPROVEN-YET are not dead weight — they are unmeasured, which is a different verdict, and each now carries the exact measurement that settles it.

---

## Top-3 measured wins

1. **Condense truth pass.** A 4× KV overstatement (40,960 → 10,240 B/token) is dead, the fp8 cache at full 262K context is exactly 2.5 GiB, and the format byte-model lands within 0.02% of a real shipped artifact. Wrong planner math mis-grades every tier decision downstream; this fix is pure, measured leverage.
2. **Codemod prefilter $0 lane.** Deterministic, test-asserted: the runner is never invoked and cost is exactly $0 for the mechanical-edit class. Every task in that class is a task no model is paid for — forever, at any scale.
3. **Corpus yield.** 112,960 raw rows became 103,915 clean, deduped, license-verified training rows (train 93,527 / eval 10,388, `solomonSafe: true`) — with 9,045 duplicates removed before they could waste a single training step.

*Honorable mention:* the entire folded stack's code is **325,433 bytes** — a third of a megabyte. The disc problem was never the code; it was data riding inside the installer, and the census proves the split.

---

## What this audit could NOT verify

- **Edge0's speed and quality numbers** (14.9–17.7 tok/s decode, OpenCompass 79.2) — vendor claims from the candidate record. Edge0 has never run on Robbie's hardware; its install is blocked behind the 4.1 payload.
- **The 4.1 payload's copy of Edge0** — the tensor audit covers the publisher's HF artifact. No 4.1 payload exists yet to re-index; when one is built, its index gets the same check before signing.
- **MTP acceptance rates** — the head is absent; there is nothing to measure.
- **Every live number** — cross-machine latency, SPACE host behavior, live routing dollars, live token savings: zero live runs exist anywhere in the stack. All correctness results above are test-harness results (fake runners, fake transports, synthetic chains), and this audit has labeled them as such rather than letting "tests pass" impersonate "it performs."
- **Edge0's integrity** — no published hash exists for the artifact (pipeline triage FLAG from Stage 2 stands). The tensor index fetched here is publisher-served metadata, not a signature.
