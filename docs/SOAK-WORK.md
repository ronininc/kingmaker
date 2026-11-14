# Soak evidence: local work, not just healthy processes

`node scripts/soak-work.mjs --config config.json --json report.json` performs a **read-only preflight**. It returns a failing soak result deliberately: preflight is not inference. Add `--run` only on an idle local Ollama endpoint reserved exclusively for this test. The harness refuses an already-loaded model and never unloads pre-existing work. Do not reserve the live endpoint while another agent/app may use it. The `exclusive` flag is an operator declaration, not a cross-process lock.

Example config for the existing 24 GB profile (verify it against the installed profile and any owner's overrides first; this file changes no picks):

```json
{
  "base": "http://127.0.0.1:11434",
  "healthBase": "http://127.0.0.1:3001",
  "exclusive": false,
  "minJobs": 5,
  "context": 8192,
  "timeoutMs": 90000,
  "maxResidentBytes": 9126805504,
  "models": {
    "router": "huihui_ai/qwen3-abliterated:1.7b",
    "writer": "huihui_ai/qwen3-abliterated:8b",
    "coder": "huihui_ai/qwen2.5-coder-abliterate:7b",
    "vision": "huihui_ai/qwen3.5-abliterated:4b",
    "reasoning": "hf.co/TrevorJS/gemma-4-12B-it-uncensored-GGUF:Q4_K_M"
  }
}
```

No cloud fallback, model pulls, CRM jobs, private logs, keys, personal prompts, or changes to the installed app are involved. Only literal HTTP loopback endpoints are accepted; redirects are refused. Each call is bounded to 256 generated tokens (20 for the router), 90 seconds by default, and 30 seconds of residency. Work is sequential. N is 1–20 (default 5). Aborts still attempt bounded unload of the test's active model. A process kill cannot guarantee cleanup; no report means no pass.

## What the test proves

Each of N synthetic jobs calls **the actual `routeLane()` helper**, using a prompt that needs model routing, and must receive `by: router, lane: write`. Only then does **`localModelTurn()`** write a two-sentence description with checkable content. Both must have successful local Ollama decode receipts plus observed residency of that exact model with positive resident/GPU bytes and the writer must satisfy the task validator. Rules/default routing, nonempty text, failed requests and prompt tokens cannot stand in for local work. One router call plus one writer call count as **one** completed synthetic job.

Coder, vision and reasoning also run real `/api/chat` inference via the existing `chat()` transport. These are **model probes**, not proof that the closed engine dispatches those lanes in production:

- Coder produces a minimal JavaScript addition function. An exact restricted grammar verifies its semantics without executing arbitrary generated code. This is a smoke test, not a coding benchmark.
- Vision must identify both a red and a blue PNG, supplied as actual image bytes with the identical question. A constant answer fails. The PNGs are generated locally without downloads.
- Reasoning must answer and justify a small syllogism. This is a smoke test, not a reasoning benchmark.

The unchanged production router has no separate coder/vision/reasoning dispatch in its direct write lane. Claiming those probes are end-to-end engine jobs would be false. Extending closed-engine coverage requires observable correlated job receipts from that runtime; this PR does not invent them or alter routing.

## Evidence contract (schema 1)

The report is standalone JSON, **not a change to `/admin/metrics`**. Consumers must not combine it with dashboard lifetime counters.

- `runId`, `startedMs`, `endedMs`, `status`, `scope`, `minJobs`, `runtime`, `machine` identify the run. No preflight/aborted run can pass.
- `receipts[]`: unique `id`, `runId`, `jobId`, `lane`, request/response model, context, loopback transport, HTTP status, start/end times, provider `done`/`doneReason`, `generated`, `evalNs`, prompt counts/duration, outcome, output SHA-256, observed `residentModelBytes`/`residentGpuBytes` and task `validated` flag. Only completed, non-truncated provider responses inside this run count.
- `jobs[]`: synthetic job ID, run ID, route decision, validation and completion status. Probe IDs are separate and never inflate job counts.
- `samples[]`: phase, time, Ollama resident bytes, process RSS bytes, device GPU percentage and thermal state. Unknown values stay null.
- `unloads[]`: model, explicit unload acknowledgement, observed absence and settled-memory recovery.
- `result`: `ok`, named `failures`, `localGeneratedTokens`, `localCompletedJobs`, `cloudCompletedJobs`, `attemptedJobs`, `failedCalls`, per-lane calls/tokens/weighted decode speed/baseline comparison, `inferenceMemoryPeakBytes` and `gpuPeakPct`.

The cloud count is restricted to completed synthetic jobs with receipts; the local-only runner never issues a cloud request. It is **not** the Mac's total background cloud job count. Optional cumulative-counter comparisons reject a reset or epoch change; receipt sums remain authoritative. Device GPU usage and aggregate process RSS are contextual samples, not exclusive GPU attribution to one model. Missing sampling fails; zero observed GPU activity fails. `inferenceMemoryPeakBytes` is sampled Ollama residency, not a guaranteed physical-memory high-water mark. Short peaks can be missed.

Health is checked before/after each call and during periodic inference sampling. Crash report names are checked at run end. Thermal warning, unknown thermal state, excess residency or missing required telemetry abort work. After each model, the test requires `done_reason: unload`, disappearance from `/api/ps`, and three consecutive one-second samples with no resident model and RSS within 64 MiB of the initial idle aggregate. The default sampler never runs sysctl or sudo. GPU uses the launcher's non-root `ioreg ... AGXAccelerator` parsing approach.

## Baselines

Use `--baseline catalog/bench/m5-pro-24gb.json`. The runner does not infer hardware from that file or from the chosen model profile. Without a machine observation it reports `BASELINE_UNAVAILABLE` and cannot pass. `--hardware-json <file>` accepts a separately obtained, current `system_profiler -json SPHardwareDataType` export; it retains only chip and RAM, and labels the identity as **provided**, not independently verified. Do not obtain that file by bypassing a denied hardware query. No hardware query is performed by the runner.

Comparison requires matching chip, RAM, exact model, context and Ollama version and an unsimulated measured baseline. A mismatch or unavailable measurement is named and fails the strict result. Matching identities produce measured/actual tok/s and their ratio, **not** a speed-regression verdict: the short smoke prompts differ from the benchmark workload. A future speed gate needs matching workload/length evidence too.

The October 16 M5 Pro file uses 16k contexts. This harness uses the configured context for workers and the production router's 2k context. The 24 GB profile is now 8k. Those differences must not be rounded away or treated as a pass.

## Existing bar soak

`scripts/soak-bar.mjs` retains its existing bar cases, health, process-memory and crash checks, and now requires `--work-config config.json` plus the work phase in the same invocation. `--baseline` and `--hardware-json` pass through. Invalid/empty case selections, interrupted rounds and thermal aborts cannot print an all-passed result. The work phase does not attribute bar-log answers to local models.

The legacy bar cases still interact with the live app (and some network-dependent cases); the new standalone harness is the local-only option. Do not use the bar soak during another person's session. It was not run for this change.

## Tests

`node --test test/soak-evidence.test.mjs` covers evidence accounting and the runner with an injected HTTP server implementation: cloud-only, zero tokens, failed calls, missing lanes, counter resets, stale/duplicate/out-of-window records, completion/truncation, baseline mismatches, thermal abort, busy/missing-model preflight and failed unload. Fixtures are test data, never claimed as real inference results.

## Validation of this change (2026-10-18)

- Isolated source base: private Kingmaker `6921474d67690f571fecda17a467802b2abea47e`. No installed-app or engine changes.
- Full repository test run with local fixture socket permissions: 987 passed, zero failures/skips (107.8 seconds). The original sandboxed run could not bind its fixture servers. Subsequent focused regression additions pass separately.
- Real read-only preflight `15f11c72-4f26-4a85-91eb-ce6c87baff1f`: Kingmaker health 200; Ollama 0.31.1; all five configured models present; model residency empty. **Aborted with `THERMAL_EVIDENCE_MISSING`, zero inference calls.** Non-elevated `pmset` returned an access error; RSS sampling was also unavailable. GPU telemetry was accessible (46% at the observation), which is background device activity, not proof of this soak's work.
- No live bar soak or local inference soak was run. No permission denial was bypassed to gather hardware/thermal/RSS evidence. No cloud calls or model downloads occurred. End-to-end closed-engine job provenance remains outside this harness's demonstrated scope.

Final-source verification: 31/31 focused regressions passed. The full final rerun passed 997/998, with the existing `floor-participant-audio` fake-peer talk-back test receiving zero frames under suite load. Rerunning that file with the repository standard `--test-force-exit` passed 3/3 (6.9 seconds). The final full-suite run is therefore not reported as fully green; the isolated rerun suggests a timing-sensitive audio fixture. No audio code was changed.


## Reservation and warm residency

A loaded model is not evidence of an active request. `admission.inFlight` remains null because the public Ollama residency API does not prove queue emptiness. `admission.residentBefore` records model names and resident bytes; a warm model now fails `PREEXISTING_RESIDENCY_REQUIRES_RESERVATION`, not “busy.” Newly appearing residency between test calls fails `UNEXPECTED_RESIDENCY`.

The router normally keeps its model warm for 30 minutes. Running this cold-load/unload harness against that production endpoint can therefore remain blocked indefinitely even while the router is idle. This is an ownership/admission restriction, not a model-performance failure. We cannot safely unload another client's warm model merely to clear the gate. A harness-only lock would not be honored by existing production clients and cannot provide exclusivity.

Use a dedicated idle local endpoint (`config.base`) with sufficient memory capacity, or coordinate an exclusive production test window in which all clients and background producers are quiesced by their owner. The existing model-bench simulation launcher is not a safe shortcut: its `runBench({asGb})` path unloads the production endpoint first. Do not use it to bypass this gate. The harness does not stop clients or reserve production automatically.

Follow-up read-only observations (2026-10-18 09:49:36–09:49:52 UTC): the router runner's CPU time increased only 0.02 seconds, CPU was 0.1%, and model expiry was unchanged. This is consistent with warm idle residency, but does not establish an empty queue or prevent a new request. The bridge has a running/queued metric, but access requires a private bridge key; it was not read. Real inference and matched-baseline collection remain pending safe test capacity.

Sampling-race regression: timer and post-call checks now await the same in-flight sampling promise. Periodic sampling stops before final validation; pending observations are drained before cleanup. The first sampling failure is retained in the report even if cleanup also fails. Deterministic deferred-health and deferred-thermal tests hold a sample past the successful provider response, then prove the run fails, cleanup completes, and no later job starts. Focused suite: 34/34.


## Host memory admission (2026-10-18)

Model residency is insufficient during cold loading: the dedicated reasoning probe reached approximately 8.98 GB runner RSS while `/api/ps` still returned an empty list. The external host guard aborted it; no reasoning completion was observed.

The harness now requires host memory telemetry from `vm_stat` and physical RAM. Available bytes are free + inactive + speculative pages; active, wired and compressed pages are excluded, and purgeable pages are not double-counted. Before preflight succeeds and before every inference call, available bytes must cover the configured entire model-resident budget, a fixed 1 GiB loading/context allowance, and a 25% physical-RAM reserve. These are conservative admission policies, not measured model peaks or speed baselines. Inference and recovery samples enforce the host reserve even when the model list is empty. Unknown telemetry fails closed. Sampling cannot guarantee protection against a sub-second allocation spike or another process consuming memory after admission.

Named failures: `HOST_MEMORY_TELEMETRY_MISSING`, `HOST_MEMORY_ADMISSION_FAILED`, `HOST_MEMORY_RESERVE_ABORT`. Admission refusal performs no inference or unload. An in-flight failure aborts the owned request and attempts bounded cleanup.

Validation: `node --test test/soak-evidence.test.mjs` passed 37/37. New regressions cover page accounting, missing/insufficient capacity before any mutation, and host pressure with empty residency during inference. Existing thermal, health, cleanup and sampling-race checks remain green.

Real inference evidence from the preceding dedicated-endpoint run remains **failed**: router, writer and coder passed their checks; vision answered Red for both independently decoded red and blue images. Reasoning was separately stopped during loading by the host guard. All attempted unloads were acknowledged and recovered. No passing five-lane soak or matched speed baseline is claimed. The vision fixtures are 64×64 (4096 pixels), below the installed vision projector's reported 8192 minimum pixels; this is a diagnostic lead, not an established root cause or permission to accept the wrong answer. Picks and validators remain unchanged.


Vision transport follow-up: four deterministic regression cases verify canonical base64/PNG signatures, all 4096 RGB pixels for each color, distinct image hashes, unchanged image-bearing messages through the real `chat()` helper (including its thinking-flag retry), and rejection of a constant Red answer for blue. Combined focused suites pass 41/41. Independent Python decoding additionally validates every PNG chunk CRC. Fake-provider checks against the installed helper also preserve both images. Read-only installed model metadata declares vision capability; saved runtime logs show image decoding. No adapter defect or malformed fixture was established. Real request bodies were not retained, so historical wire identity cannot be proved from receipt hashes alone. The unresolved failure may involve model/preprocessing behavior; below-minimum fixture dimensions remain a lead, not a proven cause. No further inference was run under failed memory admission.
