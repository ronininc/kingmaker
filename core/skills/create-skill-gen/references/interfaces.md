# create-skill-gen — verified interface map

The real engine seams this skill builds AGAINST. **Never trust the paths or symbol
names below from memory — re-`grep` them before you use them.** Files move, symbols
get renamed, and a stale citation is how a build silently drifts off the spine. Each
row names the symbol; find the current home with `grep -rn "<symbol>" server/src`.
`scripts/verify-interfaces.sh` in this skill greps every symbol and fails if one has
moved — run it first.

The paths are in the engine's source, which ships compiled inside Kingmaker.app and is not in this
repository: the greps, and `scripts/verify-interfaces.sh`, resolve only in a checkout that carries it.

Everything here was confirmed present on the branch this skill shipped from. It is a
map, not a snapshot: the map tells you what to look for, the grep tells you where it
is now. This skill does not fork the capability-acquisition lifecycle, the Vault, or
the Kingmaker channel — it DRIVES them for one specific candidate shape: a skill that
the engine itself proposes to build.

## 1. Need — the capability-gap signal

Before scaffolding anything, the gap has to be named and, where it originates from
the engine's own scouting rather than an operator's sentence, proposed to Kingmaker as a
non-binding candidate — never acted on by itself.

| What | Symbol | Home (verify by grep) |
|---|---|---|
| Known scouting targets + state | `CapabilityTarget`, `CORE_CAPABILITY_TARGETS`, `CapabilityObservation`, `CapabilityScoutState` | `server/src/runtime/capability-scout.ts` |
| Read current scout state | `getCapabilityScoutState()` | same file |
| License gate for what may even be scouted/staged | `licenseMayAutoStage(spdx)`, `licenseMayAcquire(spdx, separateProcess)`, `OPEN_SOURCE_LICENSES` | same file |
| Kick a scout pass | `startLaunchCapabilityScout()` | same file |
| Propose the gap to Kingmaker (proposal only, never an action) | `emitKingmakerAlert({ type: 'ACQUISITION_CANDIDATE', severity, summary, metadata })` | `server/src/runtime/kingmaker-alert-broadcast.ts` |

`ACQUISITION_CANDIDATE` is documented in that file's own header as "a PROPOSAL for
Kingmaker to weigh, never an action: the engine does not download, ingest or run
anything on the strength of it." Treat a self-identified skill gap the same way —
emit the candidate, do not start scaffolding files because the emit succeeded.

## 2. Anti-replication / clean-room guard — the HARD GATE on what gets built

Two things must both hold before a byte of scaffold is written: the workflow that
produced the skill's content must be clean-room (procedural), and the skill's own
text must pass the executable safety screen. Neither is optional and neither is
reimplemented here — both are driven from where they already live.

| What | Symbol | Home (verify by grep) |
|---|---|---|
| Clean-room procedure (read the OUTCOME, never transliterate) | `native-capability-extraction` skill, step "0. Read the source — the OUTCOME, not the code" | `.claude/skills/native-capability-extraction/SKILL.md` |
| Executable safety screen (blocks BEFORE a candidate runs) | `screenSkillSafety({ id, sourceText })` → `SkillSafetyVerdict` | `server/src/runtime/capability-acquisition.ts` |
| Threat categories the screen catches | `SkillThreatCategory` (`limiter_break` \| `report_suppression` \| `dangerous_action`), `THREAT_MARKERS` | same file |
| Sanitized block report queued to Kingmaker | `KingmakerSkillReport` (id/verdict/categories — never the payload) | same file |
| Third-party code obligations if the scaffold vendors anything | `classifyCodeLicence(dependency)`, `clearCodeForSale(dependencies, productName)`, `CodeLicenceClass` | `server/src/runtime/code-licence-gate.ts` |

Load-bearing facts to preserve:

- `native-capability-extraction` is not a suggestion, it is the doctrine this skill
  is required to follow whenever the new skill's capability has a foreign/external
  source to work from: **read the source module(s) end to end, write down what it
  produces / its honesty invariants / its external dependencies, then replicate the
  OUTCOME and the invariants — never a line-for-line transliteration.** A scaffold
  that pastes foreign source in with renamed variables has not passed clean-room; it
  has failed it.
- `screenSkillSafety` runs on the CANDIDATE's own text (the skill you are about to
  create), not just on ported source. A generated `SKILL.md`/script that itself
  encodes a limiter-break, report-suppression, or dangerous action is `BLOCKED`
  before it is ever scored — see §5, step 1 of `runAcquisition`.
- `COPYLEFT_BLOCKS` / `WEAK_COPYLEFT_BLOCKS` / `UNKNOWN_BLOCKS` from
  `classifyCodeLicence` are refusals, not warnings that can be waved through by this
  skill — an unread or incompatible license on vendored code stops the scaffold from
  shipping until a human reads it and the rule is added.

## 3. Scaffold — build the skill's files (the Tier-2 heavy job)

Generating a skill's `SKILL.md` / `references/*` / `scripts/*` through the local
coder model is the SAME heavy job coding-gen already governs. This skill does not
stand up a second build loop — it drives the one that exists.

| What | Symbol | Home (verify by grep) |
|---|---|---|
| Full build → test → repair discipline (eviction, sandbox, egress ladder) | `coding-gen` skill (Phases 0–4) | `.claude/skills/coding-gen/SKILL.md` |
| Governed provider selection + invocation | `createDefaultCodingRegistry()`, `.select(request, ctx)`, `invokeProvider(provider, request, ctx)` | `server/src/runtime/coding/coding-providers.ts`, `coding-model-provider.ts` |
| Bounded self-repairing run (for a multi-file scaffold) | `startCodegenBoundedRun(request)`, `repairFeedback(result)` | `server/src/runtime/codegen-bounded-pass-runtime.ts` |
| Eviction contract — one heavy job at a time | `awaitHeavyJobClearance(maxWaitMs)`, `runScheduledInference(lane, task)` | `server/src/runtime/memory-pressure-guardrail.ts`, `inference-scheduler.ts` |
| Sandbox gate BEFORE any generated file renders/writes | `analyzeSuspectCode(source)`, `hardenAgainstSuspectCode({ source, tenantId, stage })`, `BEHAVIORAL_MARKERS` | `server/src/runtime/twin-execution-sandbox.ts` |

Do not re-derive the eviction contract, the sandbox gate, or the egress ladder in
this skill's own scripts — `coding-gen`'s Phase 0–4 already implement them; this
skill's only addition is that the artifact being built is a *skill*, and the
governance target after "test" is the capability-acquisition lifecycle (§4–§6)
rather than a rendered app.

## 4. Test — the measured scorecard

A scaffold is not "tested" by having compiled; it is tested by producing a measured
`ExtractionRun` that `scoreExtraction` can judge.

| What | Symbol | Home (verify by grep) |
|---|---|---|
| The measured-run shape a build must produce | `ExtractionRun` (`build`, `proof`, `realityGate`, `honesty`, `governance`, `parity`, `humanEditDelta`) | `server/src/runtime/capability-acquisition.ts` |
| Score a run in [0,1]; any hard defect forces 0 | `scoreExtraction(run)` → `ExtractionScore` | same file |
| Hermetic proof pattern the run's `proof` field should come from | `native-capability-extraction` skill, step 4 (`tests/<name>/run.ts`) | `.claude/skills/native-capability-extraction/SKILL.md` |

`scoreExtraction` treats a skipped required gate (build/proof/realityGate not
`'pass'`), ANY `governance.ungovernedEgress > 0`, or a malformed counter as a hard
defect — score forced to 0, never "clean". `clean` additionally requires
`humanEditDelta` to be exactly 0. Do not hand-construct a passing score; run the
real hermetic proof and report what it measured.

## 5. Graduate — the clean-streak gate + the acquisition loop

| What | Symbol | Home (verify by grep) |
|---|---|---|
| Graduation verdict from history | `evaluateGraduation(history, window = 5)` → `GraduationVerdict` | `server/src/runtime/capability-acquisition.ts` |
| Orchestrate ONE candidate through screen → gate → run → score → record → graduate → federate | `runAcquisition(candidate, deps)` → `AcquisitionResult` | `server/src/runtime/capability-acquisition-loop.ts` |
| The candidate shape a skill build proposes | `AcquisitionCandidate` (`capabilityId`, `measurementId`, `name`, `category`, `sourceText`, `requestedRecursiveImprovement?`, `requestedSourceMutation?`, `contributorWatermark?`, `acquire()`) | same file |
| Durable ledger / outbox adapters | `AcquisitionLedger`, `KingmakerOutbox`, `createFileLedger(dir?)`, `createFileOutbox(dir?)`, `createMemoryLedger()`, `createMemoryOutbox()` | same file |
| Ship queued Kingmaker reports when a transport exists | `flushOutbox(outbox, transport?)` | same file |

`runAcquisition` is the loop you drive — it is not something this skill
re-implements. A skill candidate's `sourceText` for the safety screen (§2) is its
own `SKILL.md` + scripts content; its `acquire()` returns the measured
`ExtractionRun` from §4.

## 6. The governance-by-design hard gate — why a new skill can never self-promote

This is the load-bearing rule the task doctrine calls out explicitly: **a new skill
graduates ONLY through Kingmaker authorization.** `runAcquisition` already has the
mechanism — it is not new code, it is a required INPUT on every candidate this skill
proposes.

| What | Symbol | Home (verify by grep) |
|---|---|---|
| The review-only self-evolution gate `runAcquisition` calls when tripped | `evaluateSelfEvolutionCandidate(candidate)` → `SelfEvolutionGovernanceDecision` | `server/src/runtime/node-generation-governance.ts` |
| The candidate shape | `SelfEvolutionCandidate` (`trustLevel`, `sandboxMode`, `requestedRecursiveImprovement`, `requestedSourceMutation`, …) | same file |
| The decision is ALWAYS review-only | `SelfEvolutionGovernanceDecision.autonomousSelfModificationAllowed` is typed `false` — literally, not just defaulted | same file |
| The boundary rules cited in the decision | `RECURSIVE_IMPROVEMENT_BOUNDARY_RULES` | same file |

Load-bearing fact: in `runAcquisition`, step 2 ("SELF-EVOLUTION GATE") only fires
when `candidate.requestedRecursiveImprovement || candidate.requestedSourceMutation`
is true — and when it fires, `autonomousSelfModificationAllowed` is always `false`,
so the loop returns outcome `'GATED'` and stops before scoring, recording, or
promoting anything. **This skill's candidates MUST always set
`requestedSourceMutation: true`** (creating a new engine skill extends the engine's
own capability surface — that is a source-mutation-shaped act even though no engine
file is touched) so every `create-skill-gen` proposal is unconditionally routed into
this review-only path. That is the enforcement point of the "graduates ONLY through
Kingmaker authorization" doctrine — it is a real, already-governed code path, not a
comment promising good behaviour.

> ⚠️ **Known integration gap (verified this build):** the Kingmaker control
> allow-list (`KingmakerControlType` in `kingmaker-mailbox.ts` — `ACKNOWLEDGE_ALERT`,
> `REQUEST_STATUS`, `SET_OVERSIGHT_FLAG`, `ADVISE`) has no verb that means "authorize
> this gated skill for promotion." There is currently no automated path from a
> Kingmaker decision back into `deps.ledger.markCore` / `POST /api/vault/promote`
> for a GATED candidate — that hookup is founder/operator-driven today (§8). **This
> is a `// TODO(integrate)` seam** — adding an `AUTHORIZE_SKILL_PROMOTION` control
> verb is engine work for the Kingmaker/mailbox team, not something this skill
> patches in from the outside.

## 7. Federate to Kingmaker for approval

Two channels exist; use the one that matches what you are reporting.

| What | Symbol | Home (verify by grep) |
|---|---|---|
| Sanitized engine-to-Kingmaker accumulation queue (skill blocks + graduation federation reports) | `KingmakerOutbox.pending()/depth()/ack()`, `buildKingmakerFederationReport(installationId, skills, blockedCount)` | `capability-acquisition-loop.ts`, `capability-acquisition.ts` |
| Live sealed engine-Kingmaker channel (for a co-resident/attested peer Kingmaker) | the mailbox endpoint's `emitAlert(alert)`, `KingmakerAlert`, `KingmakerAlertType`, `KingmakerAlertSeverity` | `server/src/runtime/kingmaker-mailbox.ts` |
| Governed control ingestion (default-deny; the only way a decision comes back) | the mailbox endpoint's `ingestControl(sealed)`, `KingmakerControl`, `CONTROL_ALLOWLIST` | same file |
| HTTP: trigger + read status of an acquisition (ROOT-gated) | `POST /api/capability-acquisition/record`, `GET /api/capability-acquisition/`, `GET /api/capability-acquisition/outbox` | `server/src/routes/capability-acquisition.ts` |
| Mount gating | `authSessionMiddleware, requireRoles(['ROOT'])` on `/api/capability-acquisition` and `/api/vault` | `server/src/index.ts` |

`emitAlert` SANITIZES before it seals — `sanitizeAlertForKingmaker(alert)` — so a
generated skill's proposed source never crosses this channel; only id/type/
severity/summary/scrubbed metadata does. Use `severity: 'FOUNDER_REVIEW'` when
proposing a new-skill candidate for authorization; it is the severity tier this
module's own type already reserves for something a human must look at.

## 8. Vault — where an AUTHORIZED graduation lands

| What | Symbol | Home (verify by grep) |
|---|---|---|
| Promote a graduated capability (throws if not graduated) | `promoteToVault(input, at?)` → `VaultEntry` | `server/src/runtime/capability-vault.ts` |
| Durable store | `VaultStore`, `createFileVault(dir?)`, `createMemoryVault()` | same file |
| Canon eligibility (graduated + no customer data + no price increase + watermarked + JV-reconciled) | `canCanonize(entry)` | same file |
| Founder/Kingmaker step that unblocks canon | `reconcileOwnership(entry, decision, at?)` | same file |
| HTTP: the AUTHORITATIVE promotion route — re-checks the ledger itself, ignores a client-claimed `graduated` flag, 409s if not graduated | `POST /api/vault/promote` | `server/src/routes/capability-vault.ts` |

Because §6 routes every `create-skill-gen` candidate to the review-only gate,
`runAcquisition`'s own auto-promote branch (`deps.vault` present + graduation +
self-evolution allowed) never fires for a skill this workflow proposes — it cannot,
since `autonomousSelfModificationAllowed` is always `false`. The only route a new
skill can ever reach the Vault through is the explicit, ROOT-authenticated
`POST /api/vault/promote` call, made by a human after Kingmaker/the founder has
reviewed the GATED proposal. That is not a gap to work around; it is the governance
boundary this skill exists to respect.
