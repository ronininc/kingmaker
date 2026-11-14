# Kingmaker Stack — Integration Map

**One stack, five builds, eleven absorbed components, one integration layer.**
Built 2026-10-19/20; the eleven absorbed 2026-10-20. The five builds keep
their own homes — nothing was moved or copied, with ONE exception
ordered by the founder 2026-10-20: LittleBrother's real code is now
vendored in-stack at `littlebrother/` (it ships in the app payload as
`lib/stack-littlebrother`), and Harness² was folded in alongside it as
a governed native reconstruction at `harness2/`. The eleven (from the
@githubprojects five and the "helps us now" six) live in this directory as
governed registrations: descriptor + contract + tests, no upstream code
vendored anywhere. This directory (`~/workspace/kingmaker-stack/`) holds
the map, the registry, the combined verifier, the seam checks, one
adapter, and the shared governance/audit library the absorbed contracts
run on.

**Verify everything:** `node ~/workspace/kingmaker-stack/verify-all.mjs`
→ 22 suites, 377 checks. Last run: **STACK GREEN (22/22, 377/377)**.

## The components

| # | Component | Home | Role in one line |
|---|-----------|------|------------------|
| 1 | Router Phase 2 | `~/workspace/router-phase2/` | Governed per-task routing: prefilter → bandit → verifier → escalation; federation, audited memory, drift, guardrails, doctor, rollback |
| 2 | LittleBrother | `littlebrother/` (in-stack; build home `~/workspace/littlebrother/`) | Governed OSINT lookups — **INSTALLED as real code 2026-10-20**, ships in the payload; kingmaker build carries tap-gated full methods, solomon build physically excludes them |
| 3 | SPACE cell | `~/workspace/kingmaker-v041/space-cell/` | Sandbox governor for the v0.4.1 microVM layer: intent-first audit, host-side egress, brokered credentials, registered workloads |
| 4 | Training-data pipeline | `~/workspace/training-data-pipeline/` | Audit chains → labeled corpora; HF datasets through Cage triage (hash + license); corpus builder with signed manifests |
| 5 | Edge0 augmentation | `~/workspace/edge0-minicpm-augmentation/` | Condense truth pass (real format/KV math) + think/no-think lane policy for serving |
| 6 | Harness² | `harness2/` | Governed reconstruction of Google Research's recursive harnessing (Apache-2.0 method, arXiv 2610.14224): Propose–Probe–Compose over the 8 harness components; adoption founder-tap-gated + audit-chained (upstream self-adopts ungated); improvement library carries lessons across tasks; the slash-bucket self-configuration mechanism |
| + | **This layer** | `~/workspace/kingmaker-stack/` | STACK.md, stack-manifest.json, verify-all.mjs, seams.test.mjs, lib/harvest.mjs, lib/governance.mjs + lib/audit-chain.mjs (shared by the absorbed contracts) |

## The absorbed eleven (folded in 2026-10-20)

Two audit waves produced these: the @githubprojects five (verdicts +
23-finding problem scan + buff contracts in `~/workspace/githubprojects-scan/`)
and the "helps us now" six (verdicts + problem scan in
`~/workspace/gittrend-now/`). Nothing is installed; every entry is a
registration — a descriptor, a governed contract, and a green suite.
Upstream code is never vendored; binaries and skill files arrive only
through Cage intake against the recorded pins.

| # | Component | Home | Role in one line |
|---|-----------|------|------------------|
| 6 | WordCraft | `wordcraft/` | Document production (docx/PDF render + convert) under the blog/report/book pipeline; MCP confined to both automation roots, run jobs tap-gated |
| 7 | ARTEMIS | `artemis/` | Android device-driving for Kingmaker Mobile; loopback console, hash-pinned helper install (tap), provider allowlist, cloud-proxy + installer commands forbidden |
| 8 | Anatomy | `anatomy/` | **Problem-visualization skill — renders, never diagnoses** (founder ruling: separate seats); figure jobs confined + self-contained; publish actions refused outright |
| 9 | SolidCraft | `solidcraft/` | Parametric CAD for fabrication + renders; job paths confined, GUI refused (updater surface), fork-required minisign key; FreeCAD stays the structural oracle |
| 10 | XERJ | `xerj/` | Local search/memory layer beside ripgrep; loopback + auth pinned, **offline lexical embedder only** (neural download refused), secret-scanned index jobs, field-report tool refused |
| 11 | Unsloth | `unsloth/` | Training lane: tap-gated fine-tune jobs, corpus sha256 in / model sha256 out. Core Apache-2.0 absorbed; **Studio AGPL-3.0 = external record** (loopback only, quick-tunnel refused) |
| 12 | check-if-email-exists | `check-if-email-exists/` | Pre-send list verification: batches open only with provenance + tap + hard allowance; loopback pinned (no upstream auth); provider probes recorded per check |
| 13 | Stop Slop | `stop-slop/` | Anti-slop content skill, pinned by commit + per-file sha256; a drifted staged copy is refused |
| 14 | Humanizer | `humanizer/` | Tell-catalog content skill (v3.1.0), pinned by commit + SKILL.md sha256; complements Stop Slop |
| 15 | ExifCleaner | `exifcleaner/` | **EXTERNAL** (MIT): publishing-hygiene scrubber, operator-driven — driven never linked; only scrubbed outputs cross, via the Cage |
| 16 | Lazy Frames | `lazy-frames/` | **TRIAGE — DO NOT USE.** MIT declared, no LICENSE file exists: a claim, not a grant. Record + tripwires only; clears via LICENSE appearing upstream + its sha256 recorded + founder tap |

## The picture

```
                        ┌─────────────────────────────────────────────┐
   task ───────────────▶│ GOVERNED ROUTER (1)                         │
                        │ prefilter → bandit → VERIFIER → escalate    │
                        │ every stage ─▶ hash-chained audit (JSON)    │
                        └──────┬───────────────────────┬──────────────┘
              lane policy (5)  │                       │ audit chain
        reflex/standard/deep ──┘                       ▼
                        ┌──────────────────┐   ┌───────────────────────┐
                        │  serving / Edge0 │   │ EXHAUST HARVESTER (4) │
                        │  condense plan   │   │ chains ─▶ gold/neg/   │
                        │  corrected by    │   │ unlabeled records     │
                        │  truth pass (5)  │   └──────────┬────────────┘
                        └──────────────────┘              ▼
                                              CORPUS BUILDER (4) ─▶ corpora
                                              (glaive: 103,915 rows,  ─▶ future
                                               apache-2.0, solomonSafe)  fine-tunes

   cell workloads ─────▶┌─────────────────────────────────────────────┐
                        │ CELL GOVERNOR (3) ─▶ SPACE host (Linux)     │
                        │ kinds: cage-eval · digital-twin ·           │
                        │ redhat-darkweb · redhat-abliterate ·        │
                        │ littlebrother-full · kuroko-voice           │
                        └──────────────────┬──────────────────────────┘
                                           │ littlebrother-full runs
                                           ▼
                        ┌─────────────────────────────────────────────┐
                        │ LITTLEBROTHER (2)                           │
                        │ kingmaker: 5 public + 3 full (tap-gated)    │
                        │ solomon:   5 public only — full set absent  │
                        │ every call/refusal ─▶ audit (JSONL) ────────┼──▶ harvester (4)
                        └─────────────────────────────────────────────┘
```

## The seams

### Router (1) consumes lane policy (5) — via an explicit adapter
The vocabularies do **not** share names. Lanes are posture (`reflex`,
`standard`, `deep` — think?, budget, sampling); tiers are price/capability
(`cheap`, `standard`, `frontier`). Only `standard` exists in both. The
adapter lives in `seams.test.mjs` and is asserted bijective, rank-ordered,
and budget-monotone:

| Lane (5) | Tier (1) | Posture |
|----------|----------|---------|
| reflex | cheap | no-think, 256 tok, stop on first tool call |
| standard | standard | no-think, 2048 tok |
| deep | frontier | think, 8192 tok |

Consistency note: the router independently sends guardrail-flagged tasks to
the frontier tier only — which is the deep lane's tier. The two designs
agree without ever having shared a name. Serving applies `generationConfigFor(lane)`
for posture and the router's bandit pick within the mapped tier.

### Cell governor (3) dispatches LittleBrother (2)
The `littlebrother-full` kind names **no methods** — it carries a template,
the `kingmaker-x-heretic` spine requirement, an operator-declared allowlist
(empty by default: creatable, reaches nothing), and the `osint-source-keys`
credential. Resolution runs through LittleBrother's own factory:
`FULL_METHOD_IDS` ≡ `createFullMethods()` keys ≡ the three extra methods on
the kingmaker api (`phoneLookup`, `personLookup`, `breachQuery`) — asserted
by seam (b), together with their total absence from the solomon build.
Red Hat kinds (`redhat-darkweb`, `redhat-abliterate`) follow the same
registry pattern and refuse under the `custom` spine.

### Harvester (4) reads the stack's audit chains
One chain math (sha256 over the entry JSON with `hash` undefined, seq from
0, genesis prevHash = 64 zeroes), three writer implementations:

| Writer | Shape | Home |
|--------|-------|------|
| router-phase2 `audit-chain.mjs` | JSON array file | (1) lib/ |
| littlebrother `audit-log.mjs` | JSONL | (2) lib/ |
| space-cell `audit-chain.mjs` | JSON array — byte-derived copy of (1)'s, per its NOTICE | (3) lib/ |

Seam (c) proves reader↔writer agreement with **real** modules on both
sides: a chain written by the actual governed router harvests to a gold
routing-decision; a chain written by LittleBrother's log (and the real
on-disk artifact at `littlebrother/audit/littlebrother-audit.jsonl`)
harvests to gold/unlabeled task-outcomes. A chain that fails verification
is refused wholesale — poisoned exhaust never enters a corpus.

**Record semantics worth knowing:** on tier escalation the router does not
log a fresh `route.decision`; the harvest therefore records `decision` =
the bandit's *initial* pick and `output.model` = the model that finally
served (from `route.outcome` meta). Training on these records teaches
first-pick quality and escalation cost separately — by design, not by
accident. Also: the structural verifier treats output ending without a
closing boundary (no terminal punctuation) as truncation — serving layers
emitting reflex-lane text into the router must end outputs cleanly.

### Corpus (4) feeds future fine-tunes
`corpora/tool-use-brains` (glaive-function-calling-v2, Apache-2.0 verified
against HF's published hash; 112,960 → 103,915 deduped; train 93,527 /
eval 10,388; `solomonSafe: true`) is the seed corpus for the Edge0
specialist fine-tune sequenced in the augmentation spec (tier corpus
L0–L4 → two-phase SFT → RLVR → OPD). Fleet exhaust joins it as chains
accumulate — the harvester is wired and tested; live volume is what grows.

### Truth pass (5) corrects the condense planner
`condenseWithTruthPass` wraps the planner by composition: it adds the
`affine-int4-g64` format Edge0 actually ships (0.5625 B/param, validated
against MiniCPM5's real MLX artifact to 0.02%), pins MoE gate tensors at
fp8 (21M params, 9.21 MB on Edge0), and applies `kvLayerFraction` (Edge0
carries KV on 10 of 40 layers — the naive planner overstated KV 4×; true
cache at full 262K context is 2.5 GiB fp8). Port target is the app's
`model-condense` when the workspace builds fold into the release.

## Reconciled mismatches (found by the seam checks, not papered over)

1. **Lane ↔ tier naming** — two vocabularies, one shared word. Resolved
   by the explicit `LANE_TO_TIER` adapter in `seams.test.mjs` (above).
2. **`harvestFile` drops its documented `format` field** — the pipeline's
   doc comment promises `{ records, dropped, chainOk, format }`;
   `harvestChain` returns no `format` (detection happens inside
   chain-verify but is never surfaced). Parsing itself is correct for
   both shapes. Minimal adapter: `kingmaker-stack/lib/harvest.mjs`
   (`harvestFileWithFormat`) re-attaches the field using the pipeline's
   own `detectFormat`, so stack consumers get the documented surface
   without touching the component.

### The absorbed eleven bind at the registry (seam d)
The eleven are governed the same way the stack governs everything: the
claim lives in the descriptor, the enforcement lives in the contract,
and `seams.test.mjs` section (d) checks the two agree — manifest
license posture == descriptor for all eleven; lazy-frames is the only
`unverified` entry and its tripwire module refuses render/capture/
remote-skill jobs as-shaped; exifcleaner is the only `external`-class
entry and its specifier guard throws; Unsloth Studio's posture is
external-only in the descriptor AND its launch-config builder refuses
tunnels and wide binds; XERJ's governed server config comes out with
`embedder.kind === 'lexical'` while neural-from-hub refuses; Anatomy's
descriptor states the renders-never-diagnoses seat and its gate's
forbidden-action list carries publish; both content skills' descriptor
pins equal their modules' pins byte-for-byte; the shared audit chain
(`lib/audit-chain.mjs`) the new contracts log through verifies under
independent recomputation; and no absorbed `.mjs` file carries a bare
import — zero dependencies, zero upstream code.

## Operations

- **Health:** `doctor` (1) — stable check IDs across config/audit/bandit/
  prefilter/memory/federation/guardrails; exit 1 on any failure.
- **Recovery:** `rollback` (1) — signed, hash-pinned snapshots;
  verify-then-copy, fail-closed.
- **First contact between machines:** federation (1) refuses without the
  founder's consent token; trust promotion is consent-gated too.
- **Registry:** `stack-manifest.json` — components, entry modules, test
  suites, version stamps (file mtimes; component homes carry no git), and
  a **byte census** (`byteCensus`, via `census.mjs`): code vs data per
  component. Headline: the whole stack is **463,664 bytes of code**
  (325,433 before the absorbed eleven); the only data present is the
  294 MB tool-use corpus — which streams post-install under the 4.1
  rule, like the library and the models.
- **Drop:** `~/workspace/kingmaker-v041/kingmaker-stack-code-v041.zip` —
  the code-only bundle for the sol-ghost payload, regenerated with the
  absorbed eleven (contracts + descriptors + shared lib) included.
