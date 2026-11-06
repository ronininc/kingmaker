# Shield layer — Scripture Armor's self-iteration machinery (SPEC: armor-shield-builder)

This directory is the Shield-Builder layer integrated into Scripture
Armor, built to `~/workspace/armor-shield-builder/SPEC.md`. Status, stated
exactly (the spec's copy rule binds this file):

- **B1 — retention layer** (`shield-ledger.mjs`, `shield-collect.mjs`, wired into the
  review/repository/device lanes): an append-only, hash-chained findings
  ledger. Records are collected *before* the sandbox cycle destroys its
  workspace. Contents never survive; testimony always survives.
- **B2 — attempts feed** (`shield-attempts.mjs`, wired into `vaultd.mjs`):
  `scripture-armor.attempts/1` refusal telemetry, recorded at the daemon's
  beacon chokepoint and readable on the owner channel (`{"cmd":"attempts"}`).
- **B3 — corpus aggregator** (`shield-aggregator.mjs`): a disposable unified
  index over the repository corpus, the ledger, verdict linkage, beacon
  events, and attempts entries. Sealed report packages are never opened.
- **B4 — loadable detector rule packs** (`shield-packs/scan-rules-pack.json`,
  `shield-rulepack.mjs`): the scan stage's detector core lives in versioned pack
  data; `../scan.mjs` loads its tables from the baseline pack, and pack
  versions join the record's `engine.rules` lineage.
- **B5 — stage/layer registry** (`shield-registry.mjs`): the attacked spot made
  addressable — `{lane, stage, surface}` — with per-spot layer stack
  manifests, gate receipts, and tamper-evident rollback snapshots.
- **B6 — the loop** (`shield-loop.mjs`, `shield-generator.mjs`, `shield-gate.mjs`, `shield-eval.mjs`,
  `shield-review-harness.mjs`): detection → diagnosis → generation → governance
  gate → deployment → feedback. Generation in this version is
  **deterministic pattern extraction over retained records** — it is
  named as such everywhere, including here. A generated layer goes live
  only through the gate (self-scan + full corpus replay + monotonicity
  check, receipt written to the ledger either way) and may only tighten
  or add, never loosen. Deployment is data writes into a separate
  generated store; the owner's `policy.json` is never machine-edited.
- **B7 — learned models: NOT BUILT.** The spec gates any model-based
  machinery on accumulated retained *real attack* data at a volume that
  does not exist (recorded foreign attacks to date: zero). Nothing in
  this directory is machine learning, and no copy may call it that.

**Core claim status:** the assembled claim — a novel attack is detected,
a retrofit layer is generated, gated, and deployed, and the repeat attack
is then stopped — has **NO VERDICT**. Its components are proven
individually and in full non-attack cycles (see
`test/shield-*.test.mjs`); the live novel-attack battery is a named wall
whose sanctioned vehicle is the owner-directed Little Brother stack
penetration test (ordered 2026-11-05). Until that battery runs and a
real attack is carried through all seven loop steps with its gate
receipt in the ledger, no self-iteration claim may be made for this
product.
