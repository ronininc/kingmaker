# coding-gen — verified interface map

The real engine seams this skill builds AGAINST. **Never trust the paths or symbol
names below from memory — re-`grep` them before you use them.** Files move, symbols
get renamed, and a stale citation is how a build silently drifts off the spine. Each
row names the symbol; find the current home with `grep -rn "<symbol>" server/src app/src`.
`scripts/verify-interfaces.sh` in this skill greps every symbol and fails if one has
moved — run it first.

The paths are in the engine's source, which ships compiled inside Kingmaker.app and is not in this
repository: the greps, and `scripts/verify-interfaces.sh`, resolve only in a checkout that carries it.

Everything here was confirmed present on the branch this skill shipped from. It is a
map, not a snapshot: the map tells you what to look for, the grep tells you where it is now.

## 1. Coder-model provider — the Tier-2 heavy job

The local coder model is reached ONLY through the governed provider, never a raw POST.

| What | Symbol | Home (verify by grep) |
|---|---|---|
| The sovereign local coder provider | `localModelCodingProvider` | `server/src/runtime/coding/local-model-provider.ts` |
| Structured multi-file output schema | `OLLAMA_FILE_MANIFEST_FORMAT` | same file |
| Per-artifact output budget | `localCodingNumPredict` | same file |
| Provider interfaces | `CodingRequest`, `CodingResult`, `CodingFileChange`, `CodingProviderContext`, `CodingModelProvider` | `server/src/runtime/coding/coding-model-provider.ts` |
| Run a provider (prefers async) | `invokeProvider(provider, request, ctx)` | same file |
| Registry + selection | `CodingProviderRegistry`, `.select(request, ctx)` | same file |
| Default registry (all lanes) | `createDefaultCodingRegistry()` | `server/src/runtime/coding/coding-providers.ts` |
| Is a local model configured here? | `localCodingModelConfigured(env)` | same file |
| Capability report (mode + boundary) | `getCodingCapabilityReport()` | same file |

Load-bearing facts to preserve:

- The provider posts to Ollama `/api/generate` with **`keep_alive: process.env.SOLOMON_CODEGEN_KEEP_ALIVE ?? '0'`**,
  `think: false`, `temperature: 0`, and `format: OLLAMA_FILE_MANIFEST_FORMAT`. The `'0'`
  keep_alive is the eviction contract: the ~2GB coder is freed after each generation so it
  does not sit resident beside the vision + conductor models on an 8GB box. **Do not pin it
  warm** unless the operator sets `SOLOMON_CODEGEN_KEEP_ALIVE`.
- The reply is grammar-constrained to `{ files: [{ path, content }] }`. A reply that does not
  parse **fails CLOSED** to the caller's honest template — malformed model output is never
  written or rendered.
- `requiresExternalNetwork` is `false` and `usedExternalNetwork` stays `false` for every local
  provider. A local failure is NEVER a hidden fallback to egress.

## 2. Codegen route + core (the build entrypoint)

| What | Symbol | Home |
|---|---|---|
| One-shot governed build/revise | `runGovernedCodeGeneration(request)` | `server/src/runtime/codegen-core.ts` |
| Project-type router | `pickProjectType(prompt)` → `static_site` \| `node_cli` \| `full_stack_app` | same file |
| List built projects | `listGovernedCodegenProjects(tenantId, userId)` | same file |
| Resolve a file to preview/render | `resolveGovernedCodegenPreviewFile(params)` | same file |
| HTTP: build | `POST /execute` → `runGovernedCodeGeneration` | `server/src/routes/codegen.ts` |
| HTTP: live render surface | `GET /preview/:projectId[/:fileName]` | same file |
| Voice/typed dispatch | `case 'codegen'` / `planCodegen` / `codegenNeedsSpec` | `server/src/runtime/route-dispatch.ts` |

The operator's sentence IS the spec — `codegen-core` parses it. Model selection inside
`runGovernedCodeGeneration` is `createDefaultCodingRegistry().select(request, ctx)` +
`invokeProvider(...)` under an `AbortController` time box; any model miss falls back to the
honest template and stamps provenance saying so. **That fallback is the no-fake-PASS spine —
never defeat it.**

## 3. The agentic build → test → repair loop

| What | Symbol | Home |
|---|---|---|
| Start a bounded, self-repairing run | `startCodegenBoundedRun(request)` | `server/src/runtime/codegen-bounded-pass-runtime.ts` |
| Poll a run | `getCodegenBoundedRun(tenantId, userId, runId)` | same file |
| Stop a run | `stopCodegenBoundedRun(tenantId, userId, runId)` | same file |
| HTTP | `POST /bounded-runs`, `GET /bounded-runs/:runId`, `POST /bounded-runs/:runId/stop` | `server/src/routes/codegen.ts` |

The worker loop (`workRun`) runs a pass, records `failedChecks` / `blockedReasons` from the
result's `validationChecks`, checks the acceptance contract (`isComplete`), and if not complete
feeds `repairFeedback(result)` back into the next pass — with a no-progress backoff. **This is
the loop you drive; do not re-implement it.** Each pass is real: it either passes its acceptance
checks or it reports exactly which checks failed.

## 4. Sandbox — gate generated source BEFORE it renders

| What | Symbol | Home |
|---|---|---|
| Static behavioral analysis (safe default) | `analyzeSuspectCode(source)` | `server/src/runtime/twin-execution-sandbox.ts` |
| Full harden loop | `hardenAgainstSuspectCode({ source, tenantId, stage })` | same file |
| Danger markers | `BEHAVIORAL_MARKERS` | same file |
| Optional live WASM twin (gated OFF) | `runInTwin(source, timeoutMs)` (needs `SOLOMON_TWIN_EXEC_ENABLED=1`) | same file |
| Wrapper used by security lane | `prepareHardenedSecurityAnalysis`, `runHardenedSecurityAnalysis` | `server/src/runtime/security-analysis-runtime.ts` |

`analyzeSuspectCode` is STATIC — it never executes the code. `BEHAVIORAL_MARKERS` catches
`child_process`, dynamic `require`/`import()`, `process.env` reads, outbound `fetch`/network,
filesystem writes, `eval`/`new Function`, prototype pollution, and infinite-spin loops.

> ⚠️ **Known integration gap (verified this build):** `codegen-core.ts` and the `/preview`
> route do NOT currently pass model-generated source through `analyzeSuspectCode` /
> `hardenAgainstSuspectCode` before writing or rendering it. The sandbox exists and is used by
> the security + capability-download lanes, but the CodeGen render path is not yet wired to it.
> **This is a `// TODO(integrate)` seam, not something to patch into engine internals from this
> skill.** Until it is wired, your workflow performs the sandbox check itself (Phase 3) and
> refuses to render source that trips a high-severity marker without an operator decision.

## 5. Eviction / heavy-job scheduler (the 8GB reality)

One heavy job at a time; the coder is heavy.

| What | Symbol | Home |
|---|---|---|
| Single-instance inference queue (live preempts background) | `runScheduledInference(lane, task)`, `acquireInferenceSlot(lane)`, `MAX_CONCURRENT_INFERENCES` | `server/src/runtime/inference-scheduler.ts` |
| Free the resident coder now | `releaseOllamaResidency(timeoutMs)` | `server/src/runtime/ollama-local-provider.ts` |
| Honor `OLLAMA_MAX_LOADED_MODELS` on the server | `enforceOllamaResidencyCap(...)`, `parseResidencyCap`, `planResidencyEviction(...)` | `.../ollama-residency-cap.ts` + `ollama-local-provider.ts` |
| Memory-pressure heavy-job gate | `isUnderMemoryPressure`, `engageHeavyJobDeferral`, `heavyJobsDeferred`, `awaitHeavyJobClearance(maxWaitMs)` | `server/src/runtime/memory-pressure-guardrail.ts` |
| Host-derived context window | `hostDerivedNumCtx()` | `server/src/runtime/ollama-local-provider.ts` |

Rules: only ONE heavy job (a coder generation, a render) runs at a time. Before launching a
component's generation, `await awaitHeavyJobClearance()` so you don't stack heavy work under
memory pressure. A live voice turn is admitted ahead of a queued background codegen — never
starve the operator's voice for a build.

## 6. Governed provider ladder + zero-egress cap

| What | Symbol | Home |
|---|---|---|
| External-lane classification | `classifyExternalCodingLane(...)`, `resolveCodingNetworkBoundary(env)` | `server/src/runtime/coding/coding-model-provider.ts` |
| Frontier egress consent (default-ON) | `assertFrontierEgressConsent({ tenantId, connectorId })`, `frontierEgressConsentStatus`, `frontierConsentEnforced` | `server/src/runtime/frontier-egress-consent.ts` |

The external coding lane is `DISABLED_BY_DEFAULT` and `DISABLED_BY_POLICY` when offline — a
provider token alone NEVER enables it. Escalation to a frontier/NIM provider requires an
approved `external_llm` consent grant via the propose→confirm loop, and only non-sensitive
payloads may leave. `registry.select()` already encodes the ladder: deterministic-local first →
frontier only when the lane is `AVAILABLE_OPTIONAL` → local model as sovereign fallback.
