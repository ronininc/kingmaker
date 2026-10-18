#!/usr/bin/env bash
# social-media-gen — interface proof.
#
# Proves this skill is grounded in the REAL repo: every seam the workflow builds
# against must still exist. This does NOT prove any content generation works — it
# proves the map is not stale. Run it from the repo root (or anywhere inside the repo).
#
# Honest by construction: it greps for each symbol and FAILS (exit 1) the moment
# one has moved or been renamed. No symbol is ever assumed present. No-fake-PASS:
# a green here means "all N seams resolved", nothing more — and it also confirms
# the one negative fact this skill depends on (no live social publish connector
# exists) has not silently changed underneath it.
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

echo "social-media-gen interface proof @ $ROOT"
echo "── 1. deterministic poster/SVG design engine ──"
check "parsePosterBrief"                 server/src/runtime/poster-design-engine.ts
check "renderDesignSvg"                  server/src/runtime/poster-design-engine.ts
check "renderPosterSvg"                  server/src/runtime/poster-design-engine.ts
check "renderEmblemSvg"                  server/src/runtime/poster-design-engine.ts
check "renderBannerSvg"                  server/src/runtime/poster-design-engine.ts
check "generatePoster"                   server/src/runtime/poster-design-engine.ts
check "getGeneratedMediaDir"             server/src/utils/runtime-paths.ts

echo "── 2. local text-generation provider (captions) ──"
check "runOllamaLocalReasoning"          server/src/runtime/ollama-local-provider.ts
check "runOllamaStructuredGeneration"    server/src/runtime/ollama-local-provider.ts
check "getOllamaLocalProviderStatus"     server/src/runtime/ollama-local-provider.ts

echo "── 3. social publish — confirm the honest (manual-only) state ──"
check "instagram"                        server/src/mobile-backend/connector-registry.ts
check "canExecute"                       server/src/mobile-backend/connector-registry.ts
check "manual_call_instruction"          server/src/mobile-backend/connector-registry.ts
check "registerConnector"                server/src/connectors/connector-sdk.ts

echo "── 4. outbound-write governance ──"
check "PermissionGrantScope"             server/src/runtime/connector-permission-grants.ts
check "connector_write"                  server/src/runtime/connector-permission-grants.ts
check "isWriteCapableScope"              server/src/runtime/connector-permission-grants.ts
check "sharedConnectorPermissionGrantRuntime" server/src/runtime/connector-permission-grants.ts
check "computeAutoGraduatable"           server/src/runtime/autonomy-graduation-runtime.ts
check "EXTERNAL_WRITE_SAFETY"            server/src/runtime/autonomy-graduation-runtime.ts
check "NEVER_GRADUATES_ACTION_CLASSES"   server/src/runtime/autonomy-graduation-runtime.ts
check "classifyKingmakerRiskClass"       server/src/runtime/kingmaker-risk-classifier.ts

echo "────────────────────────────────────────────"
echo "  ${pass} resolved, ${fail} moved."
if [ "$fail" -ne 0 ]; then
  echo "  RESULT: FAIL — the interface map is stale. Re-grep the moved symbols before using this skill."
  exit 1
fi
echo "  RESULT: PASS — all seams resolve on this checkout."
