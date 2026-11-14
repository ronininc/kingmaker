# Build Order: Governed Abliteration Method for Kingmaker

## Objective
Wire heretic-llm (automatic refusal-abliteration tool) into Kingmaker as a
governed method — the "can't say no" capability for pen-test/R&D workloads —
with Robbie's governance fully intact. Use REA to map the tool's interface
and CLI-anything to generate the governed wrapper.

## Why this exists
Cloud models refuse offensive-security work. Robbie's red-team methodology
needs a local model that won't refuse. The abliteration step (stripping
refusal tuning from official base weights) is the mechanism. This method
makes it a one-call Kingmaker capability instead of a manual hoop-jump —
but every execution still needs his per-engagement tap.

## Architecture (non-negotiable)

### AGPL boundary (HARD RULE)
heretic-llm is **AGPL-3.0**. It is NEVER imported, vendored, or linked into
Kingmaker's codebase. The method invokes it exclusively via **subprocess**
(`heretic` CLI binary in a separate process). This is the "mere aggregation"
boundary — Kingmaker's proprietary license stays clean. This is Robbie's
standing AGPL rule, not a suggestion.

### Governance chain (HARD RULE)
Every invocation flows: **Intent → Tap → Execute → Audit**.
1. Agent requests abliteration with target model path + justification.
2. **Robbie's per-engagement tap** — no tap, no run. Same gate as all
   offensive methods. Not batchable, not standing approval.
3. Subprocess executes on designated GPU hardware only.
4. Full audit record: who requested, what model, when, what tap authorized it,
   input/output weight hashes, hardware used.

### What REA does here
REA (already spec'd for Solomon, MIT) investigates heretic-llm's CLI surface:
flags, config format, input/output conventions, failure modes, resource
requirements. Understanding the interface — not cloning the tool. Output is
an interface map that CLI-anything consumes.

### What CLI-anything does here
Generates the governed wrapper: a Kingmaker method `abliterate-model` with
the skills-as-methods schema (name, trigger conditions, inputs, outputs,
cost, ref). The wrapper enforces the tap gate, routes to the correct GPU
hardware, validates inputs (official base weights only — no anonymous
pre-abliterated downloads), and writes the audit record.

## Method spec: `abliterate-model`

**Inputs:**
- `model_path`: path to official base weights (hash-verified against upstream)
- `justification`: what engagement this serves (ties to the tap)
- `target_hardware`: GPU box designation (default: Yordi's Spark / Robbie's rig)

**Outputs:**
- `abliterated_path`: path to output weights
- `input_hash` / `output_hash`: SHA256 of weights before/after
- `audit_id`: reference to the audit chain record

**Gates:**
- Robbie's per-engagement tap (blocking, not batchable)
- Input weights must be official base (provenance check — rejects anonymous
  pre-jailbroken weights, same supply-chain rule as the build order)
- GPU hardware must be designated (never runs on shared/cloud infra)

**Cost:** GPU-hours on the designated box, tracked per the gig-profitability rule.

## Build steps
1. **REA pass:** Map heretic-llm's CLI interface (flags, I/O, failure modes).
   Output: interface map document.
2. **CLI-anything pass:** Generate the `abliterate-model` method wrapper from
   the interface map, with tap gate + audit + hardware routing baked in.
3. **Provenance gate:** Implement the official-weights-only check (hash
   verification against upstream releases before abliteration runs).
4. **Audit integration:** Wire execution records into the existing audit chain.
   Every run logged: requester, justification, tap reference, hashes.
5. **Smoke test (governed):** One dry-run against a small test model with
   Robbie's tap, verifying the full chain — tap → subprocess → audit record —
   without touching production weights.
6. **CRM skill index:** Register the method with its governance boundary,
   AGPL tool-only note, and per-engagement tap requirement.

## Constraints
- $0 new spend (hardware already owned/planned).
- heretic-llm NEVER imported or vendored. Subprocess only. AGPL boundary.
- Official base weights only. No anonymous pre-abliterated downloads.
- Never runs on shared or cloud infrastructure. Designated GPU boxes only.
- Robbie's per-engagement tap is blocking and non-batchable.
- The abliterated model's use is still gated per-method (red-team methods
  need their own taps — this method only produces the model, it doesn't
  authorize its use).

## Acceptance
1. `abliterate-model` callable from the methods registry.
2. Without Robbie's tap, invocation is refused with a clear message.
3. With tap: subprocess runs, weights abliterated, audit record written.
4. AGPL boundary verified: no heretic-llm code in Kingmaker's tree or imports.
5. Provenance gate rejects non-official weights.
6. Audit chain shows the full record for the smoke test run.

## Related
- `docs/agent-reach-local-uncensored.md` (the parent build order — Part 2)
- REA integration spec (`claude-prompt-solomon-rea-reverse-engineering.md`)
- Skills-as-methods schema (method registry format)
- Robbie's standing rules: per-engagement tap for offensive methods,
  AGPL tool-only, $0 spend, gig profitability
