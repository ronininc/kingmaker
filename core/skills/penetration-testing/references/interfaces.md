# penetration-testing — verified interface map

The real engine and Kingmaker seams this skill composes. **Never trust the paths or symbol names below
from memory — re-`grep` them before you use them.** Files move and symbols get renamed; a stale
citation is how a build silently drifts off the spine. Each row names the symbol; find its current
home with `grep -rn "<symbol>" server/src app/src`. `scripts/verify-interfaces.sh` in this skill
greps every symbol and fails if one has moved — run it first.

The paths are in the engine's source, which ships compiled inside Kingmaker.app and is not in this
repository: the greps, and `scripts/verify-interfaces.sh`, resolve only in a checkout that carries it.

Everything here was confirmed present on the branch this skill shipped from, by direct grep against
the symbol's own `export` line (not a usage/import site) unless noted otherwise. It is a map, not a
snapshot: the map tells you what to look for, the grep tells you where it is now.

## 1. RED-action risk classification (why a pentest engagement is always Kingmaker-RED)

| What | Symbol | Home (verify by grep) |
|---|---|---|
| RED/YELLOW/GREEN classifier ("Founder Escalation Law") | `classifyKingmakerRiskClass` | `server/src/runtime/kingmaker-risk-classifier.ts` |
| Risk class type | `KingmakerRiskClass` = `'GREEN' \| 'YELLOW' \| 'RED'` | same file |
| Routing type | `KingmakerRoute` = `'BUILD_QUEUE' \| 'RESEARCH_SCOPE_BRIEF' \| 'FOUNDER_REVIEW_PENDING'` | same file |
| Existing mass-harm pattern list the classifier also checks | `MASS_HARM_CATEGORIES` | `server/src/runtime/dangerous-creation-detector.ts` |

`classifyKingmakerRiskClass` is called from `createTransformationPlan` in
`server/src/runtime/transformation-engine.ts` (~line 307), which audits its own decision via
`appendLedger`. This skill does not need to re-run the classifier — a pentest engagement is RED **by
policy**, routed straight to `FOUNDER_REVIEW_PENDING` (§2) regardless of what the classifier would
independently score it, because the asset list and authorization evidence are exactly the kind of
irreversible/high-blast-radius facts `FOUNDER_REVIEW_PENDING` exists to gate.

## 2. Founder Review — the scope record and its lifecycle (the "arming" state)

"Founder Table" is doctrine wording only — the code-level object is
`FounderReviewItem`.

| What | Symbol | Home |
|---|---|---|
| Status enum | `FounderReviewStatus` = `'PARKED'\|'QUEUED'\|'AUTO_APPROVED_BUILD'\|'UNDER_REVIEW'\|'APPROVED'\|'REJECTED'\|'CLOSED'` | `server/src/storage/operating-system.ts` |
| Review item shape | `FounderReviewItem` (interface) | same file |
| Create a review item (the scope record) | `createFounderReviewItem(input)` | same file |
| Read current state | `getFounderReviewItem(input: { tenantId?; reviewId })` | same file |
| Move status directly (low-level) | `updateFounderReviewStatus(input)` | same file |
| **The arming act** — approve/reject with separation-of-duties enforced | `transitionFounderReview(input: FounderReviewTransitionInput)` | `server/src/runtime/kingmaker-queue-join.ts` |

`transitionFounderReview` is the function this skill actually calls to arm a scope: it reuses
`decideApproval` (§3) for separation-of-duties, and on `APPROVE` it is also the function that would
normally call `createBuildProgram` (`build-program-queue-runtime.ts`) for a build — for a pentest
engagement there is no build to queue, the `APPROVED` status on the `FounderReviewItem` itself IS
the artifact you check. Every branch (not-found, refused, approved, rejected) calls
`appendAuditEvent` (`server/src/storage/db.ts`) internally — no separate audit call needed for the
arm/reject/refuse decision itself.

`// TODO(integrate)`: no `assertPentestScopeArmed(reviewId)` helper exists yet. Mint one, modeled
one-for-one on `assertFrontierEgressConsent` (§6): read `getFounderReviewItem`, throw a named error
(e.g. `PENTEST_SCOPE_NOT_ARMED`) unless `status === 'APPROVED'`. Do not inline this check ad hoc.

## 3. Separation-of-duties primitive (why self-approval is impossible)

| What | Symbol | Home |
|---|---|---|
| Approve/reject with SoD enforced | `decideApproval(input)` | `server/src/execution/execution-approval-gate.ts` |
| Attribution builder used alongside it | `buildAttribution(...)` | same file |

`decideApproval` requires the approver identity to be session-resolved (never taken from a request
body), refuses self-approval and re-approval of an already-decided item, and refuses to let a
capacity-blocked state be overridden. This is the actual "arming" primitive underneath
`transitionFounderReview` — it is reusable and is what makes "operator approves their own pentest
request" structurally impossible rather than a rule this skill has to remember to enforce.

## 4. Audit trail — flow-scoped hash chain (tie every action to the armed scope)

Two audit ledgers exist in the repo; this skill uses the **flow-scoped** one because a pentest
engagement is naturally one flow (one armed scope, many actions), not a tenant-global stream.

| What | Symbol | Home |
|---|---|---|
| Append one event to a flow's hash chain | `appendFlagshipAuditEvent(params)` | `server/src/flagship/audit-ledger.ts` |
| Read a flow's full trail | `getFlagshipAuditTrail(flowId)` | same file |
| Verify the chain is unbroken | `verifyFlagshipAuditFlow(flowId)` → `{ valid: boolean; brokenAt: string[] }` | same file |

Use `flowId = reviewId` (the armed `FounderReviewItem`'s id) so the audit trail and the scope record
are the same identity — every recon/assessment/validation/report action in Phases 2–6 appends here,
and `verifyFlagshipAuditFlow(flowId)` is the exact proof pasted at delivery (Phase 7).

The other ledger — `appendLedger` / `getLedgerRecord` (`server/src/storage/ledger.ts`, per-tenant,
hash-chained, `recordType: 'DECISION'|'REPLAY'|'REVIEW'|'ACTION'`) — is what `transformation-engine.ts`
already uses for its own RED/YELLOW/GREEN routing decisions. Do not duplicate an entry there; it is
not this skill's ledger to write to.

## 5. Sandbox gate — untrusted generated code before it runs (same gate as coding-gen)

| What | Symbol | Home |
|---|---|---|
| Static behavioral analysis (safe, never executes) | `analyzeSuspectCode(source)` | `server/src/runtime/twin-execution-sandbox.ts` |
| Full harden loop | `hardenAgainstSuspectCode(input)` | same file |
| Danger markers | `BEHAVIORAL_MARKERS` | same file |
| Optional live WASM twin (gated OFF by default) | `runInTwin(source, timeoutMs)` (needs `SOLOMON_TWIN_EXEC_ENABLED=1`) | same file |

Any parser/PoC code this skill generates to interpret recon output or validate a finding (Phases 4–5)
is model-written, untrusted output — gate it through `analyzeSuspectCode` before it runs, exactly as
`coding-gen`'s Phase 3 does. A high-severity marker (process exec, dynamic codegen, covert egress,
secret read) is the anti-theft veto surface named in `SKILL.md`.

## 6. Sovereign execution proposal chain (signed authorization → sandboxed execution → audit)

| What | Symbol | Home |
|---|---|---|
| Create a signed execution proposal | `createSovereignExecutionProposal(input)` | `server/src/runtime/sovereign-execution-chain.ts` |
| Execute a proposal under signature verification | `executeSovereignProposal(proposal, authorization, executor)` | same file |
| Read back a stored proposal | `getSovereignExecutionProposal(tenantId, proposalId)` | same file |
| Stage sequence recorded per proposal | `SovereignExecutionStage` = `'INTENT'\|'EVIDENCE'\|'GOVERNANCE'\|'RECOMMENDATION'\|'AUTHORIZATION'\|'EXECUTION'\|'AUDIT'` | same file |

This is the existing pattern for "prove intent, get it authorized, execute under signature
verification, hash-chain the whole thing" — `server/src/runtime/security-analysis-runtime.ts`
(`prepareHardenedSecurityAnalysis` → `analyzeInHardenedSandbox`) already uses it to run untrusted
code analysis inside a network-**DENY** sandboxed worker (`HARDENED_CONTAINER`/
`CLOUDFLARE_SANDBOX` via `executeDistributedJob`). A Phase 5 validation step that actually executes
something against a scoped target should use this same proposal→execute shape.

> ⚠️ **Known gap (verified this build):** `security-analysis-runtime.ts`'s sandbox worker only
> supports `networkMode: 'DENY'`. There is no scoped-ALLOW mode (allowlist = the armed asset list)
> for a validation step that legitimately needs to reach the target. This is a real gap — see
> `SKILL.md` Phase 5 for how to handle it (operator sign-off per step, still audited) until the
> engine team adds one. Do not work around it by loosening `networkMode` from this skill.
>
> Also verified: `tests/security-analysis-runtime/run.ts` exists and passes standalone, but is
> listed in `tests/aggregate-gate-coverage/known-dark.txt` — it is **not** wired into
> `tests/run-all.ts` / `package.json`'s governance gate. Its PASS is a point-in-time fact, not a
> continuously-enforced guarantee.

## 7. Kingmaker alert feed (sanitized, one-way, upward reporting only)

| What | Symbol | Home |
|---|---|---|
| Emit a sanitized alert into the feed | `emitKingmakerAlert(...)` | `server/src/runtime/kingmaker-alert-broadcast.ts` |
| Read the feed | `readKingmakerFeed(sinceCreatedAt?)` | same file |

Alerts are scrubbed via `egress-firewall.ts` before persist — never raw payloads, targets, or
findings detail, only category/severity/summary. This skill may emit a CRITICAL confirmed finding
here (Phase 6) but never treats the feed as a channel for anything beyond that sanitized summary.

**Important framing to preserve:** Kingmaker (the isolated executive program) does not exist as
running code in the engine — what exists is the engine's side of the contract with it (this classifier,
review queue, alert feed, and a sealed mailbox stub in `kingmaker-mailbox.ts` for a future co-resident
or remote process). `app/src/dashboard/components/KingmakerBoundaryCard.tsx` carries an explicit,
proof-checked disclaimer (`tests/kingmaker-ui-convergence/run.ts` greps for it) that Kingmaker is "a
separate future master/admin program that I do not control and does not claim completion of." Any
report this skill produces must preserve that same framing — report to Kingmaker, never claim to
operate or complete its review on its behalf.

## 8. Scoped-consent precedent (why this skill's gate isn't a new invention)

| What | Symbol | Home |
|---|---|---|
| Fail-closed consent check, default-on | `assertFrontierEgressConsent({ tenantId, connectorId })` | `server/src/runtime/frontier-egress-consent.ts` |
| Current status of that consent | `frontierEgressConsentStatus(...)` | same file |
| Whether enforcement is on | `frontierConsentEnforced()` | same file |
| Grant scope enum (extend, don't fork, if a new scope is ever needed) | `PermissionGrantScope` | `server/src/runtime/connector-permission-grants.ts` |
| Ambiguous-response handling (propose→confirm) | `classifyPermissionVoiceResponse(text)` | same file |
| Shared runtime instance (check/grant/revoke) | `sharedConnectorPermissionGrantRuntime` | same file |

`assertFrontierEgressConsent` is the direct precedent for `// TODO(integrate) assertPentestScopeArmed`
in §2: fail closed by default, throws a named error, a token/request alone never satisfies it. It is
cited here as the pattern to imitate, not a function this skill calls directly — the scope-arm gate
composes `FounderReviewItem` + `decideApproval` (§§2–3), which is the closer-fitting existing
mechanism for an irreversible, high-blast-radius, human-approved action.
