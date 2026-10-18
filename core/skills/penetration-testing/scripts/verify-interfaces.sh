#!/usr/bin/env bash
# penetration-testing — interface proof.
#
# Proves this skill is grounded in the REAL repo: every Kingmaker/governance seam the
# workflow composes must still exist. This does NOT prove any engagement works — it proves
# the map is not stale. Run it from the repo root (or anywhere inside the repo).
#
# Honest by construction: it greps for each symbol's own export line and FAILS (exit 1) the
# moment one has moved or been renamed. No symbol is ever assumed present. No-fake-PASS: a
# green here means "all N seams resolved", nothing more.
set -u

# Resolve repo root from git so the script works from any CWD (incl. worktrees).
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT" || { echo "cannot cd to repo root"; exit 2; }

pass=0
fail=0

# check <symbol> <path-glob-root>  — symbol's own export/type line must appear under the root.
check() {
  local symbol="$1" where="$2"
  if grep -rqs --include='*.ts' -E "(export (function|const|type|interface|async function))[^;{]*\b${symbol}\b" "$where"; then
    printf '  PASS  %-40s %s\n' "$symbol" "$where"
    pass=$((pass + 1))
  else
    printf '  FAIL  %-40s %s  (moved/renamed — re-grep and update references/interfaces.md)\n' "$symbol" "$where"
    fail=$((fail + 1))
  fi
}

echo "penetration-testing interface proof @ $ROOT"

echo "── 1. RED-action risk classification ──"
check "classifyKingmakerRiskClass"    server/src/runtime/kingmaker-risk-classifier.ts
check "KingmakerRiskClass"            server/src/runtime/kingmaker-risk-classifier.ts
check "KingmakerRoute"                server/src/runtime/kingmaker-risk-classifier.ts
check "MASS_HARM_CATEGORIES"          server/src/runtime/dangerous-creation-detector.ts

echo "── 2. Founder Review — the scope record + arming act ──"
check "FounderReviewStatus"           server/src/storage/operating-system.ts
check "FounderReviewItem"             server/src/storage/operating-system.ts
check "createFounderReviewItem"       server/src/storage/operating-system.ts
check "getFounderReviewItem"          server/src/storage/operating-system.ts
check "updateFounderReviewStatus"     server/src/storage/operating-system.ts
check "transitionFounderReview"       server/src/runtime/kingmaker-queue-join.ts

echo "── 3. separation-of-duties primitive ──"
check "decideApproval"                server/src/execution/execution-approval-gate.ts
check "buildAttribution"              server/src/execution/execution-approval-gate.ts

echo "── 4. audit trail (flow-scoped hash chain) ──"
check "appendFlagshipAuditEvent"      server/src/flagship/audit-ledger.ts
check "getFlagshipAuditTrail"         server/src/flagship/audit-ledger.ts
check "verifyFlagshipAuditFlow"       server/src/flagship/audit-ledger.ts
check "appendAuditEvent"              server/src/storage/db.ts
check "appendLedger"                  server/src/storage/ledger.ts
check "getLedgerRecord"               server/src/storage/ledger.ts

echo "── 5. sandbox gate before any generated code runs ──"
check "analyzeSuspectCode"            server/src/runtime/twin-execution-sandbox.ts
check "hardenAgainstSuspectCode"      server/src/runtime/twin-execution-sandbox.ts
check "BEHAVIORAL_MARKERS"            server/src/runtime/twin-execution-sandbox.ts
check "runInTwin"                     server/src/runtime/twin-execution-sandbox.ts

echo "── 6. sovereign execution proposal chain ──"
check "createSovereignExecutionProposal" server/src/runtime/sovereign-execution-chain.ts
check "executeSovereignProposal"      server/src/runtime/sovereign-execution-chain.ts
check "getSovereignExecutionProposal" server/src/runtime/sovereign-execution-chain.ts
check "prepareHardenedSecurityAnalysis" server/src/runtime/security-analysis-runtime.ts
check "analyzeInHardenedSandbox"      server/src/runtime/security-analysis-runtime.ts

echo "── 7. Kingmaker alert feed (sanitized, one-way) ──"
check "emitKingmakerAlert"            server/src/runtime/kingmaker-alert-broadcast.ts
check "readKingmakerFeed"             server/src/runtime/kingmaker-alert-broadcast.ts

echo "── 8. scoped-consent precedent ──"
check "assertFrontierEgressConsent"   server/src/runtime/frontier-egress-consent.ts
check "frontierEgressConsentStatus"   server/src/runtime/frontier-egress-consent.ts
check "frontierConsentEnforced"       server/src/runtime/frontier-egress-consent.ts
check "PermissionGrantScope"          server/src/runtime/connector-permission-grants.ts
check "classifyPermissionVoiceResponse" server/src/runtime/connector-permission-grants.ts
check "sharedConnectorPermissionGrantRuntime" server/src/runtime/connector-permission-grants.ts

echo "────────────────────────────────────────────"
echo "  ${pass} resolved, ${fail} moved."
if [ "$fail" -ne 0 ]; then
  echo "  RESULT: FAIL — the interface map is stale. Re-grep the moved symbols before using this skill."
  exit 1
fi
echo "  RESULT: PASS — all seams resolve on this checkout."
