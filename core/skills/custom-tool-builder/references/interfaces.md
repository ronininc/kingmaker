# custom-tool-builder — verified interface map

The real engine seams this skill builds AGAINST. **Never trust the paths or symbol names below
from memory — re-`grep` them before you use them.** Files move, symbols get renamed, and a stale
citation is how a build silently drifts off the spine. Each row names the symbol; find the current
home with `grep -rn "<symbol>" server/src contracts`. `scripts/verify-interfaces.sh` in this skill
greps every symbol and fails if one has moved — run it first.

The paths are in the engine's source, which ships compiled inside Kingmaker.app and is not in this
repository: the greps, and `scripts/verify-interfaces.sh`, resolve only in a checkout that carries it.

Everything here was confirmed present on the branch this skill shipped from. It is a map, not a
snapshot: the map tells you what to look for, the grep tells you where it is now.

## 1. Tool registry — survey before you assume a gap

Two real layers, one static/hand-curated, one runtime/mutable. Neither is "the" registry alone —
survey both.

| What | Symbol | Home (verify by grep) |
|---|---|---|
| Static membership/entitlement tool contract | `CORE_ORB_TOOL_REGISTRY`, `OrbRegisteredTool` | `contracts/orb-tool-registry.ts` |
| Tool category / status / execution-type unions | `OrbToolCategory`, `OrbToolConnectionStatus`, `OrbToolAdapterStatus`, `OrbToolExecutionType` | same file |
| Membership tier + entitlement check | `OrbMembershipTier`, `ORB_MEMBERSHIP_TIER_WEIGHT`, `isTierEntitled(userTier, requiredTier)` | same file |
| One-call availability check for a tool id | `getOrbToolAvailability(membership, tool)` → `{ available, entitled, connected, adapterReady, reasonPlain }` | same file |
| Runtime execution-adapter registry (mutable, in-process) | `OrbAdapterRegistry` class, `orbAdapterRegistry` singleton | `server/src/orb/adapter-registry.ts` |
| Register / unregister / list an adapter | `.register(adapter)`, `.unregister(adapterId)`, `.list()` | same file |
| Resolve a tool+capability to an adapter | `.resolve({ toolId, capabilityId })` → `AdapterResolutionResult { adapter, found, ready, summaryPlain }` | same file |
| Adapter health snapshot | `.health()` → `AdapterHealthSnapshot[]` | same file |
| Execution adapter contract a registered adapter must satisfy | `OrbExecutionAdapter` (`id`, `toolId`, `supportedCapabilityIds`, `status`, `localCapable`, `externalDependency`, `describe()`), `OrbExecutionAdapterStatus` | `contracts/orb-execution-adapter.ts` |
| Doctrine requiring a registry at all | "Tool Registry Requirement" section (tool id, display name, category, membership tier, connection status, local availability, external dependency, supported actions, governance action mapping, adapter status, approval/audit requirements) | `SOLOMON_ORB_TOOL_ORCHESTRATION.md` |

Load-bearing facts to preserve:

- `CORE_ORB_TOOL_REGISTRY` is a **hand-curated array**, not a runtime write surface. Adding a new
  tool's membership-tier entry there is a `// TODO(integrate)` for whoever owns that contract file
  — this skill surveys it, never edits it to register a freshly built tool.
- `orbAdapterRegistry` IS a real, mutable, in-process registry meant for exactly this: a freshly
  built execution adapter is registered here so the next `.resolve(...)` call finds it.
- `isTierEntitled` compares `ORB_MEMBERSHIP_TIER_WEIGHT` — a customer entitlement tier
  (`DEFAULT`…`LOCAL_DEPLOYMENT`). This is unrelated to the informal "Tier-2 heavy job" language in
  §5 below; there is no repo-wide `Tier-1`/`Tier-2` symbol (confirmed absent by grep) — that phrase
  is coding-gen's own informal language for the eviction scheduler, carried into this skill for the
  same reason, not a shared contract.

## 2. On-demand adapter generation — the real "build the missing tool" precedent

This is the ONE place in the repo where "if we don't have it, build it, then register it" already
runs end to end in production code — scoped to login/credential-backed connectors, not arbitrary
CodeGen tools. Model Phase 2's connector path on this exactly; do not reimplement it.

| What | Symbol | Home |
|---|---|---|
| Read the credential vault + auto-register available services, generating an adapter for anything not official | `registerVaultServicesIntoRegistry(options?: { service?, generateMissing? })` (default `generateMissing: true`) | `server/src/runtime/vault-service-registry-bridge.ts` |
| Origin tag distinguishing a shipped connector from an auto-built one | `ConnectorOrigin = 'OFFICIAL_CONNECTOR' \| 'GENERATED_ADAPTER'` | same file |
| Read back what's registered | `listRegisteredVaultServices()`, `getRegisteredVaultService(serviceId, account?)`, `availableRegisteredServiceIds()` | same file |
| The actual on-demand generator invoked when no official connector exists | `ensureConnectorDescriptor(service, loginUrl, opts)`, `generateConnectorDescriptor(service, loginUrl, opts)` | `server/src/runtime/universal-connector-descriptor.ts` |
| Persist / read back a generated descriptor | `registerConnectorDescriptor(descriptor)`, `getConnectorDescriptor(service)`, `hasConnectorDescriptor(service)`, `listConnectorDescriptors()`, `removeConnectorDescriptor(service)` | same file |

Load-bearing facts to preserve:

- This bridge **never reads a secret** — it works from `listCredentialMetadata()` (masked) only,
  never `getCredentialForInjection()`. No registered connection carries a plaintext credential.
  Preserve this boundary if you extend the pattern; it is a hard invariant, not a convenience.
- A generated adapter is `READY_TO_CONNECT`, never `ACTIVE` — activation follows a real governed
  login/test in the live lane, it is not assumed at generation time.

## 3. CodeGen build path — for any missing tool that is NOT a login/credential connector

Reused verbatim from `coding-gen`; do not duplicate its map here beyond the entrypoints this skill
calls directly. Full detail — the coder provider, the eviction contract, the zero-egress ladder —
lives in `.claude/skills/coding-gen/references/interfaces.md`; re-read it before driving a build.

| What | Symbol | Home |
|---|---|---|
| Governed provider selection + invocation | `createDefaultCodingRegistry()`, `.select(request, ctx)`, `invokeProvider(provider, request, ctx)` | `server/src/runtime/coding/coding-providers.ts`, `coding-model-provider.ts` |
| One-shot governed build/revise | `runGovernedCodeGeneration(request)` | `server/src/runtime/codegen-core.ts` |
| Self-repairing bounded run (multi-pass) | `startCodegenBoundedRun(request)`, `repairFeedback(result)` | `server/src/runtime/codegen-bounded-pass-runtime.ts` |

## 4. Sandbox — gate a synthesized tool BEFORE it is registered or called

Identical seam to coding-gen, same known integration gap; this skill performs the check itself
rather than assuming either build path (§2 or §3) already ran it.

| What | Symbol | Home |
|---|---|---|
| Static behavioral analysis (safe default, never executes) | `analyzeSuspectCode(source)` | `server/src/runtime/twin-execution-sandbox.ts` |
| Full harden loop | `hardenAgainstSuspectCode({ source, tenantId, stage })` | same file |
| Danger markers | `BEHAVIORAL_MARKERS` | same file |

> ⚠️ **Known integration gap (verified this build, same as coding-gen §4):** neither
> `codegen-core.ts` nor `universal-connector-descriptor.ts` passes generated output through
> `analyzeSuspectCode` before it is written, registered, or rendered. **This is a
> `// TODO(integrate)` seam, not something to patch into engine internals from this skill.** Until
> it is wired, this workflow performs the sandbox check itself before Phase 4 (register) and
> refuses to register/use source that trips a high-severity marker without an operator decision.

## 5. Eviction / heavy-job scheduler — the CodeGen build step is a heavy job

Identical seam and identical language to coding-gen §5 — carried here unchanged because the build
step in Phase 2 (§3 above) is the same coder-model invocation, not a separate resource class.

| What | Symbol | Home |
|---|---|---|
| Single-instance inference queue (live preempts background) | `runScheduledInference(lane, task)` | `server/src/runtime/inference-scheduler.ts` |
| Memory-pressure heavy-job gate | `awaitHeavyJobClearance(maxWaitMs)`, `isUnderMemoryPressure`, `engageHeavyJobDeferral` | `server/src/runtime/memory-pressure-guardrail.ts` |
| Free the resident coder now | `releaseOllamaResidency(timeoutMs)` | `server/src/runtime/ollama-local-provider.ts` |
| Honor `OLLAMA_MAX_LOADED_MODELS` | `planResidencyEviction(...)`, `parseResidencyCap` | `server/src/runtime/ollama-residency-cap.ts` |

Rule: only ONE heavy job (a coder generation, a render) runs at a time. `await
awaitHeavyJobClearance()` before launching a tool's generation. A live operator turn is admitted
ahead of a queued background tool-build — never starve the operator's voice for a synthesis job.

## 6. The Vault — persistent home for a tool that GRADUATES, not every tool built

A freshly built tool is registered (§1) so it is reusable this session; it earns a place in the
durable Vault only after it clears the same graduation gate `native-capability-extraction` uses.

| What | Symbol | Home |
|---|---|---|
| Score a build/use run for graduation eligibility | `scoreExtraction(run: ExtractionRun)` → `ExtractionScore` | `server/src/runtime/capability-acquisition.ts` |
| Decide graduation from score history | `evaluateGraduation(history, window?)` → `GraduationVerdict { graduate, consistency, cleanStreak, reason }` | same file |
| Screen a candidate tool for safety before scoring/graduating | `screenSkillSafety({ id, sourceText })` → `SkillSafetyVerdict { safe, blockers, report }` | same file |
| Sanitized report to Kingmaker (never source, never customer data) | `buildKingmakerFederationReport(installationId, skills, blockedCount)` | same file |
| End-to-end acquire → (optionally) promote-to-vault wiring | `runAcquisition(candidate, deps)`, `AcquisitionDeps { ledger, outbox, installationId, window?, vault? }` | `server/src/runtime/capability-acquisition-loop.ts` |
| Promote a GRADUATED capability into the Vault (lands `STAGED`) | `promoteToVault(input: PromoteInput)` → `VaultEntry`; throws `VaultPromotionError` if `graduated` is not `true` | `server/src/runtime/capability-vault.ts` |
| Vault status lifecycle | `VaultStatus = 'STAGED' \| 'APPROVED' \| 'CANON' \| 'RELEASED' \| 'DEPRECATED'` | same file |
| Origin tag for an engine-built tool | `VaultOrigin` incl. `'SOLOMON_ACQUIRED'` | same file |
| Gate before CANON (ownership + JV reconciliation, out of scope for this skill) | `canCanonize(entry)` → `{ ok, blockers }`, `reconcileOwnership(entry, decision)` | same file |
| Durable store | `VaultStore { add, list, countByStatus }`, `createFileVault(dir?)`, `createMemoryVault()` | same file |

Load-bearing facts to preserve:

- `promoteToVault` **throws `VaultPromotionError`** if `graduated !== true` — there is no path to
  the Vault that skips `evaluateGraduation`. A one-off tool built for a single outcome does not
  need to graduate; say so plainly rather than forcing every build through this gate.
- A promoted entry lands `STAGED`, never `CANON`. `canCanonize` additionally requires
  `ownership.reconciledWithJV === true` (a founder/Kingmaker step via `reconcileOwnership`) — out
  of scope for this skill; report a `STAGED` promotion as exactly that, not as "canonized".
- `customerDataIncluded` is hard-typed `false` and `noPriceIncreaseFromContribution` hard-typed
  `true` on every `VaultEntry` — these are compile-time invariants of the Vault, not something a
  caller can override.
