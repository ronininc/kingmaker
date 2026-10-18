#!/usr/bin/env bash
# custom-tool-builder — interface proof.
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
    printf '  PASS  %-38s %s\n' "$symbol" "$where"
    pass=$((pass + 1))
  else
    printf '  FAIL  %-38s %s  (moved/renamed — re-grep and update references/interfaces.md)\n' "$symbol" "$where"
    fail=$((fail + 1))
  fi
}

# checkfile <path> — a non-.ts doctrine file must simply exist.
checkfile() {
  local path="$1"
  if [ -f "$path" ]; then
    printf '  PASS  %-38s %s\n' "(doc exists)" "$path"
    pass=$((pass + 1))
  else
    printf '  FAIL  %-38s %s  (moved/renamed — update references/interfaces.md)\n' "(doc exists)" "$path"
    fail=$((fail + 1))
  fi
}

echo "custom-tool-builder interface proof @ $ROOT"
echo "── 1. tool registry (static contract + runtime adapter registry) ──"
check "CORE_ORB_TOOL_REGISTRY"           contracts/orb-tool-registry.ts
check "OrbRegisteredTool"                contracts/orb-tool-registry.ts
check "getOrbToolAvailability"           contracts/orb-tool-registry.ts
check "isTierEntitled"                   contracts/orb-tool-registry.ts
check "OrbAdapterRegistry"               server/src/orb/adapter-registry.ts
check "orbAdapterRegistry"               server/src/orb/adapter-registry.ts
check "OrbExecutionAdapter"              contracts/orb-execution-adapter.ts
checkfile "SOLOMON_ORB_TOOL_ORCHESTRATION.md"

echo "── 2. on-demand adapter generation (the real 'build the missing tool' precedent) ──"
check "registerVaultServicesIntoRegistry" server/src/runtime/vault-service-registry-bridge.ts
check "GENERATED_ADAPTER"                server/src/runtime/vault-service-registry-bridge.ts
check "ensureConnectorDescriptor"        server/src/runtime/universal-connector-descriptor.ts
check "generateConnectorDescriptor"      server/src/runtime/universal-connector-descriptor.ts
check "listConnectorDescriptors"         server/src/runtime/universal-connector-descriptor.ts

echo "── 3. CodeGen build path (reused from coding-gen) ──"
check "createDefaultCodingRegistry"      server/src/runtime/coding
check "runGovernedCodeGeneration"        server/src/runtime/codegen-core.ts
check "startCodegenBoundedRun"           server/src/runtime/codegen-bounded-pass-runtime.ts

echo "── 4. sandbox before register/use ──"
check "analyzeSuspectCode"               server/src/runtime/twin-execution-sandbox.ts
check "hardenAgainstSuspectCode"         server/src/runtime/twin-execution-sandbox.ts
check "BEHAVIORAL_MARKERS"               server/src/runtime/twin-execution-sandbox.ts

echo "── 5. eviction / heavy-job scheduler ──"
check "awaitHeavyJobClearance"           server/src/runtime/memory-pressure-guardrail.ts
check "releaseOllamaResidency"           server/src/runtime/ollama-local-provider.ts
check "planResidencyEviction"            server/src/runtime/ollama-residency-cap.ts

echo "── 6. the Vault (graduation-gated persistence) ──"
check "scoreExtraction"                  server/src/runtime/capability-acquisition.ts
check "evaluateGraduation"               server/src/runtime/capability-acquisition.ts
check "runAcquisition"                   server/src/runtime/capability-acquisition-loop.ts
check "AcquisitionDeps"                  server/src/runtime/capability-acquisition-loop.ts
check "promoteToVault"                   server/src/runtime/capability-vault.ts
check "VaultEntry"                       server/src/runtime/capability-vault.ts
check "canCanonize"                      server/src/runtime/capability-vault.ts

echo "────────────────────────────────────────────"
echo "  ${pass} resolved, ${fail} moved."
if [ "$fail" -ne 0 ]; then
  echo "  RESULT: FAIL — the interface map is stale. Re-grep the moved symbols before using this skill."
  exit 1
fi
echo "  RESULT: PASS — all seams resolve on this checkout."
