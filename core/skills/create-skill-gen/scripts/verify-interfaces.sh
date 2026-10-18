#!/usr/bin/env bash
# create-skill-gen — interface proof.
#
# Proves this skill is grounded in the REAL repo: every seam the workflow builds
# against must still exist. This does NOT prove any build works — it proves the
# map is not stale. Run it from the repo root (or anywhere inside the repo).
#
# Honest by construction: it greps for each symbol and FAILS (exit 1) the moment
# one has moved or been renamed. No symbol is ever assumed present. No-fake-PASS:
# a green here means "all N seams resolved", nothing more.
set -u

# Resolve repo root from git so the script works from any CWD (incl. worktrees).
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT" || { echo "cannot cd to repo root"; exit 2; }

pass=0
fail=0

# check <symbol> <path-glob-root> [file-glob]  — symbol must appear at least once under the root.
check() {
  local symbol="$1" where="$2" glob="${3:-*.ts}"
  if grep -rqsF --include="$glob" -- "$symbol" "$where"; then
    printf '  PASS  %-42s %s\n' "$symbol" "$where"
    pass=$((pass + 1))
  else
    printf '  FAIL  %-42s %s  (moved/renamed — re-grep and update references/interfaces.md)\n' "$symbol" "$where"
    fail=$((fail + 1))
  fi
}

# checkfile <path>  — a whole file/skill this skill builds ON must still exist.
checkfile() {
  local path="$1"
  if [ -f "$path" ]; then
    printf '  PASS  %-42s (file present)\n' "$path"
    pass=$((pass + 1))
  else
    printf '  FAIL  %-42s (missing — this skill is built ON it)\n' "$path"
    fail=$((fail + 1))
  fi
}

echo "create-skill-gen interface proof @ $ROOT"

echo "── 1. need — capability-gap signal ──"
check "CORE_CAPABILITY_TARGETS"          server/src/runtime/capability-scout.ts
check "getCapabilityScoutState"          server/src/runtime/capability-scout.ts
check "startLaunchCapabilityScout"       server/src/runtime/capability-scout.ts
check "ACQUISITION_CANDIDATE"            server/src/runtime/kingmaker-alert-broadcast.ts
check "emitKingmakerAlert"               server/src/runtime/kingmaker-alert-broadcast.ts

echo "── 2. anti-replication / clean-room guard (the HARD GATE) ──"
checkfile ".claude/skills/native-capability-extraction/SKILL.md"
check "the OUTCOME, not the code"        .claude/skills/native-capability-extraction/SKILL.md '*.md'
check "screenSkillSafety"                server/src/runtime/capability-acquisition.ts
check "THREAT_MARKERS"                   server/src/runtime/capability-acquisition.ts
check "SkillThreatCategory"              server/src/runtime/capability-acquisition.ts
check "classifyCodeLicence"              server/src/runtime/code-licence-gate.ts
check "clearCodeForSale"                 server/src/runtime/code-licence-gate.ts

echo "── 3. scaffold — the Tier-2 heavy job (driven, not re-implemented) ──"
checkfile ".claude/skills/coding-gen/SKILL.md"
check "createDefaultCodingRegistry"      server/src/runtime/coding
check "startCodegenBoundedRun"           server/src/runtime/codegen-bounded-pass-runtime.ts
check "awaitHeavyJobClearance"           server/src/runtime/memory-pressure-guardrail.ts
check "runScheduledInference"            server/src/runtime/inference-scheduler.ts
check "analyzeSuspectCode"               server/src/runtime/twin-execution-sandbox.ts

echo "── 4. test — the measured scorecard ──"
check "ExtractionRun"                    server/src/runtime/capability-acquisition.ts
check "scoreExtraction"                  server/src/runtime/capability-acquisition.ts

echo "── 5. graduate — clean-streak gate + acquisition loop ──"
check "evaluateGraduation"               server/src/runtime/capability-acquisition.ts
check "runAcquisition"                   server/src/runtime/capability-acquisition-loop.ts
check "AcquisitionCandidate"             server/src/runtime/capability-acquisition-loop.ts
check "createFileLedger"                 server/src/runtime/capability-acquisition-loop.ts
check "createFileOutbox"                 server/src/runtime/capability-acquisition-loop.ts
check "flushOutbox"                      server/src/runtime/capability-acquisition-loop.ts

echo "── 6. the governance-by-design hard gate — review-only self-evolution ──"
check "evaluateSelfEvolutionCandidate"   server/src/runtime/node-generation-governance.ts
check "autonomousSelfModificationAllowed: false" server/src/runtime/node-generation-governance.ts
check "RECURSIVE_IMPROVEMENT_BOUNDARY_RULES" server/src/runtime/node-generation-governance.ts

echo "── 7. federate to Kingmaker for approval ──"
check "buildKingmakerFederationReport"   server/src/runtime/capability-acquisition.ts
check "MailboxEndpoint"                  server/src/runtime/kingmaker-mailbox.ts
check "KingmakerControl"                 server/src/runtime/kingmaker-mailbox.ts
check "CONTROL_ALLOWLIST"                server/src/runtime/kingmaker-mailbox.ts
check "capabilityAcquisitionRouter"      server/src/routes/capability-acquisition.ts
check "requireRoles(['ROOT']" server/src/index.ts

echo "── 8. vault — where an AUTHORIZED graduation lands ──"
check "promoteToVault"                   server/src/runtime/capability-vault.ts
check "canCanonize"                      server/src/runtime/capability-vault.ts
check "reconcileOwnership"               server/src/runtime/capability-vault.ts
check "capabilityVaultRouter"            server/src/routes/capability-vault.ts
check "evaluateGraduation"               server/src/routes/capability-vault.ts

echo "────────────────────────────────────────────"
echo "  ${pass} resolved, ${fail} moved."
if [ "$fail" -ne 0 ]; then
  echo "  RESULT: FAIL — the interface map is stale. Re-grep the moved symbols before using this skill."
  exit 1
fi
echo "  RESULT: PASS — all seams resolve on this checkout."
