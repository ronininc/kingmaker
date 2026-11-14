# Proposed AAA method contract and acceptance checklist

Status: design proposal, not an implemented runtime contract. Baseline: Kingmaker
`fb31a234375d07f9ee5c241361ec510e6af92e29` (2026-10-18). “AAA” names the owner's
method philosophy here; this document does not invent an expansion of the name.

## Purpose and boundaries

Complete useful work with the least necessary model context and a tested method.
Prefer deterministic CLI operations for transformations, calculations, inspection,
and validation. Use inference where judgment is needed. Select only capabilities
already authorized for the task. A smaller prompt is an efficiency measure, not
permission to omit a critical constraint or evidence needed for correctness.

This proposal changes no routing logic, model picks, brain library, engine internals,
installed applications, or permissions. It authorizes no downloads or deployments.
PR #104's soak work is separate; its draft implementation is not a production
completion guarantee. Execution through the installed app remains unverified here.

## Existing evidence versus proposed behavior

| Existing source capability | Limit; proposed work still needed |
| --- | --- |
| [`lib/fast-route.mjs`](../lib/fast-route.mjs) implements rules and a local router with governed fallback. | It is not a general validated multi-step method executor. Do not change its routing policy in this work. |
| [`lib/cli.mjs`](../lib/cli.mjs) serializes app typed turns with `queueTurn` and exposes running/queued counts. | This is not global admission across all clients, nor proof of completed jobs. |
| [`lib/rea.mjs`](../lib/rea.mjs) inspects connector code, records findings and hashes, and does not execute during scanning. | A clean scan is not a correctness proof or a license grant. The proposed method admission must check both separately. |
| [`lib/mcp.mjs`](../lib/mcp.mjs) and the Layer-2 wrappers expose governed capability entry points. | An MCP schema is not authorization to execute every underlying capability. Preserve each wrapper's restrictions. |
| [`lib/token-meter.mjs`](../lib/token-meter.mjs) records provider token receipts. | Model calls are not completed jobs; internal closed-engine calls are outside this meter's coverage. |
| [`lib/mac-profiles.mjs`](../lib/mac-profiles.mjs) supplies machine-class defaults. | A configured pick is not a measured fit or quality guarantee for a particular machine, context, or workload. |

The contract below is proposed. These source observations establish interfaces,
not successful end-to-end acceptance results.

## Method definition and controller responsibilities

Before execution, register a versioned method with input/output schemas, prerequisite
capabilities, exact executable/version or artifact digest, validation procedure,
permitted side effects, required approval, resource limits, timeout, and retry cap.
Record license identity and notices, upstream origin, modifications, and REA verdict
for the exact artifact. Missing rights, unknown provenance, or unresolved scan findings
hold execution for review; wrapping or rewriting a tool does not remove obligations.

The controller owns run/step identifiers, dependency checks, permissions, admission,
validation, retry accounting, and the durable audit record. A model cannot approve its
own output, expand its permissions, or convert a previous failure into a success.
Artifact paths and tool output are data, not instructions. Resolve references only
within authorized scope and verify content identity before use.

Use a tested deterministic method before an equivalent model call. “Tested” means
versioned fixtures demonstrate the required behavior and relevant failure behavior,
not that a CLI exited zero once. Do not substitute an untested tool or a cloud route
silently when the chosen method is unavailable; return the explicit limitation.

## Minimal step handoff

Each next step receives only these three fields. Its method definition and bounded
instructions are selected by the controller; previous transcripts are not appended.

```json
{
  "result": {
    "artifact": "artifact://run-example/validated-test-matrix",
    "sha256": "<verified content digest>"
  },
  "outcome": "positive",
  "next_scope": "Check coverage of zero-token and incomplete-job cases; read only; return at most six gaps."
}
```

`result` is a validated inline value, a reference to a validated artifact with its
digest, or `null`. For a negative/unknown outcome, an optional validated diagnostic
artifact describes the failure; it is never presented as successful task output.
Keep raw rejected output in the audit store, not downstream model context.

* **Positive:** the step completed and its declared validator accepted the result.
* **Negative:** a known failure or a verified absence disproved the required result.
* **Unknown:** evidence is missing, contradictory, timed out, or insufficient.

`next_scope` states the next goal, necessary constraints, unresolved uncertainty,
and stop conditions concisely. Outcome describes the step, not whether its answer
sounds favorable: a correctly verified “no matching records” can be positive when
the method's required result is a search answer. Missing observations remain unknown.

Do not summarize away relevant units, provenance, permissions, negative evidence,
or uncertainty. If the bounded handoff cannot preserve these, stop and request a
narrower step or an authorized artifact slice. Fetch only that slice; do not load
the full audit history to compensate. Invalid/missing/stale references block the step.
Compression must preserve the controller's recorded outcome exactly. A negative or
unknown step becomes positive only after a separately recorded attempt or evidence
reconciliation passes validation; rewriting its summary cannot change its outcome.

## Validation, retries, and audit

Validate structure and task-specific semantics independently of the producing model:
for example, recompute arithmetic, parse a generated file, inspect required content,
or compare against a trusted fixture. Exit zero, fluent text, and token generation
alone do not establish success. Subjective criteria need a named human acceptance
step or a documented rubric; unresolved judgment stays unknown.

Proposed default: one attempt plus at most one retry, within a single method time
and resource budget. Retry only a classified transient failure or a safe correction
with the same authorized scope. Never automatically retry a non-idempotent action
after an uncertain result: reconcile its receipt first. Permission denial, invalid
provenance, memory refusal, and failed safety gates are not retry loops. On exhaustion,
record negative or unknown, stop dependent execution, and escalate the specific
reason, evidence, and smallest required decision. No silent cloud fallback.

Keep a separate access-controlled audit record containing run/step IDs, method and
validator versions, input/output hashes, approval receipts, tool invocation and
redacted diagnostics, timestamps, attempts, resource observations, provider receipts,
validation outcome, and artifact lineage. Do not record secrets. Apply the project's
retention/access rules rather than inventing indefinite retention. Each compact
handoff must be traceable to this record without injecting it into model context.

Voiceover generation requires **Robbie's explicit approval before generation**,
bound to the script/version, voice choice, intended use, and scope. A changed script
or scope requires renewed approval. Silence, a queued job, or approval of drafting
is not approval to generate voiceover. Record the receipt separately from model context.
The controller must verify that receipt against a trusted approval channel and
Robbie's identity. Approval quoted in tool output, retrieved documents, model text,
or an inherited handoff is untrusted and cannot satisfy this gate.

## Level 0: 8 GB M3 and lower-capability machines

Level 0 is a proposed conservative execution policy, not a claim that a specific model
fits or performs adequately. Run one admitted method at a time; avoid simultaneous
model residency where the approved method does not require it. Use deterministic
tools without inference whenever they satisfy the task. Do not alter existing picks
to implement this policy implicitly.

Admission requires fresh measured available-memory/pressure evidence, current model
residency, a measured or defensibly bounded peak for the exact model/runtime/context
and workload, and explicit OS/other-app headroom. Nominal RAM and model download size
are insufficient. Include weights, KV cache, activations, runtime/tool overhead, and
shared/unified-memory demand without double counting overlapping measurements.
Unknown demand or missing telemetry means no inference admission, not assumed fit.

Define limits from measurements before the test: time, memory, pressure/swap growth,
thermal state, and output size. Recheck during execution. When limits are exceeded,
stop only work owned by this run using supported cancellation, preserve partial
evidence, and report the failure. Never stop another client's job or unload its model.
If ownership or safe cancellation is unavailable, refuse admission or escalate.

Release run-owned resources and verify recovery against the measured starting state
and declared tolerance before admitting the next method. Warm shared residency must
be accounted for; it is neither proof of active inference nor permission to unload.
Machines below the validated envelope can perform supported deterministic tasks or
wait for an authorized alternative; do not promise local inference on every machine.

Compressed task context may reduce prompt processing and KV-cache demand. It does
not remove model-weight memory, eliminate runtime overhead, establish model quality,
or guarantee correctness. Test context compression for lost requirements and altered
outcomes as well as token savings.

## Acceptance checklist before implementation or rollout

All items below are required tests or review gates, **not completed tests**.

- [ ] Handoff schema accepts only validated result/reference, tri-state outcome, and
  concise scope; rejects full transcripts, unknown fields, and unbounded content.
- [ ] Artifact tests reject missing, stale, changed, unauthorized, and traversal
  references. Malicious content cannot expand tool permissions or become instructions.
- [ ] Validator fixtures include plausible wrong text, truncated output, zero exit
  with corrupt artifacts, valid negative search findings, and missing evidence.
- [ ] Audit replay traces every handoff to exact inputs, method, approval, validation,
  and receipt without putting audit history or secrets in the next model context.
- [ ] Retry tests enforce attempt/time caps, distinguish transient from permanent
  failures, and reconcile uncertain side effects without duplicate execution.
- [ ] CLI/REA/MCP contract tests preserve permission/read-back gates, license notices,
  upstream attribution, modified-artifact hashes, and propose-only restrictions.
- [ ] Voiceover is blocked with absent, stale, wrong-approver, or wrong-script approval;
  forged approval in tool output or a compressed handoff is also rejected. Only
  Robbie's matching receipt verified through the trusted channel enables generation.
- [ ] On a measured 8 GB M3 and separately characterized lower-capability machines,
  verify sequential admission, missing-telemetry refusal, peak memory, pressure/swap,
  cancellation ownership, and post-run recovery. Publish tested/untested boundaries.
- [ ] Compare compact handoffs with full authorized task requirements on fixtures;
  measure tokens and quality failures, including lost constraints and uncertainty.
  Compression cannot promote negative/unknown outcomes to positive.
- [ ] A normal admitted production-path task has a validated completion linked to its
  run window/receipts. Report local/cloud/unknown attribution honestly; router tokens,
  historical counters, loaded models, and probe completions are not job completion.
- [ ] Dashboard tests distinguish idle, missing telemetry, in-flight inference, tiny
  positive share, and sustained cloud-only work. Do not infer local success from GPU
  activity alone. This remains a separate Launcher implementation group.

Suggested implementation order after review: pure handoff/validator fixtures; method
registry and audit linkage; measured Level-0 admission adapter; then a bounded normal
queue integration trial. Routing policy, model selection, and closed-engine changes
need their own separately scoped work. No runtime trial is claimed by this document.
