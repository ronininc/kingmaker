#!/usr/bin/env bash
# coding-gen — interface proof.
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

# check <symbol> <path-glob-root>  — symbol must appear at least once under the root.
check() {
  local symbol="$1" where="$2"
  if grep -rqs --include='*.ts' -- "$symbol" "$where"; then
    printf '  PASS  %-42s %s\n' "$symbol" "$where"
    pass=$((pass + 1))
  else
    printf '  FAIL  %-42s %s  (moved/renamed — re-grep and update references/interfaces.md)\n' "$symbol" "$where"
    fail=$((fail + 1))
  fi
}

echo "coding-gen interface proof @ $ROOT"
echo "── 1. coder-model provider (Tier-2 heavy job) ──"
check "localModelCodingProvider"        server/src/runtime/coding
check "OLLAMA_FILE_MANIFEST_FORMAT"      server/src/runtime/coding
check "SOLOMON_CODEGEN_KEEP_ALIVE"       server/src/runtime/coding
check "invokeProvider"                   server/src/runtime/coding
check "CodingProviderRegistry"           server/src/runtime/coding
check "createDefaultCodingRegistry"      server/src/runtime/coding

echo "── 2. codegen route + core ──"
check "runGovernedCodeGeneration"        server/src/runtime/codegen-core.ts
check "pickProjectType"                  server/src/runtime/codegen-core.ts
check "resolveGovernedCodegenPreviewFile" server/src/runtime/codegen-core.ts
check "planCodegen"                      server/src/runtime/route-dispatch.ts

echo "── 3. build → test → repair loop ──"
check "startCodegenBoundedRun"           server/src/runtime/codegen-bounded-pass-runtime.ts
check "repairFeedback"                   server/src/runtime/codegen-bounded-pass-runtime.ts

echo "── 4. sandbox before render ──"
check "analyzeSuspectCode"               server/src/runtime/twin-execution-sandbox.ts
check "hardenAgainstSuspectCode"         server/src/runtime/twin-execution-sandbox.ts
check "BEHAVIORAL_MARKERS"               server/src/runtime/twin-execution-sandbox.ts

echo "── 5. eviction / heavy-job scheduler ──"
check "runScheduledInference"            server/src/runtime/inference-scheduler.ts
check "awaitHeavyJobClearance"           server/src/runtime/memory-pressure-guardrail.ts
check "releaseOllamaResidency"           server/src/runtime/ollama-local-provider.ts
check "planResidencyEviction"            server/src/runtime/ollama-residency-cap.ts

echo "── 6. governed provider ladder + egress ──"
check "resolveCodingNetworkBoundary"     server/src/runtime/coding/coding-model-provider.ts
check "assertFrontierEgressConsent"      server/src/runtime/frontier-egress-consent.ts

echo "────────────────────────────────────────────"
echo "  ${pass} resolved, ${fail} moved."
if [ "$fail" -ne 0 ]; then
  echo "  RESULT: FAIL — the interface map is stale. Re-grep the moved symbols before using this skill."
  exit 1
fi
echo "  RESULT: PASS — all seams resolve on this checkout."
