#!/usr/bin/env bash
# movie-gen — interface proof.
#
# Proves this skill is grounded in the REAL repo: every seam the workflow builds
# against must still exist. This does NOT prove any render works — it proves the
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

# absent <symbol> <path> <label> — asserts a KNOWN GAP is still absent (no false "fixed").
# Prints INFO either way; never fails the run — a gap closing is good news, but this
# script's job is proving the CURRENT map, not gating on the engine team's future work.
absent() {
  local symbol="$1" where="$2" label="$3"
  if grep -rqs --include='*.ts' -- "$symbol" "$where"; then
    printf '  INFO  %-42s now present in %s — the %s TODO(integrate) may be closed; re-check SKILL.md\n' "$symbol" "$where" "$label"
  else
    printf '  INFO  %-42s still absent from %s — %s gap confirmed open\n' "$symbol" "$where" "$label"
  fi
}

echo "movie-gen interface proof @ $ROOT"

echo "── 1. brief -> intent ──"
check "parseMediaIntent"                 server/src/runtime/media-intent.ts
check "MediaIntent"                      server/src/runtime/media-intent.ts

echo "── 2. shot list ──"
check "writeSceneSpec"                   server/src/runtime/codegen-scene-spec.ts

echo "── 3. decide-before-render session ──"
check "openSession"                      server/src/runtime/media-production-orchestrator.ts
check "negotiate"                        server/src/runtime/media-production-orchestrator.ts
check "applyAdjustment"                  server/src/runtime/media-production-orchestrator.ts
check "fabricateControls"                server/src/runtime/media-production-orchestrator.ts

echo "── 4. scene graph ──"
check "generateGameWorld"                server/src/spatial/game-world-generator.ts

echo "── 5. scene graph -> Blender objects ──"
check "sceneObjectsFrom"                 server/src/runtime/scene-media-producer.ts
check "produceSceneMedia"                server/src/runtime/scene-media-producer.ts

echo "── 6. deterministic render dispatch (Blender + Godot + ffmpeg) ──"
check "produceTitanMediaArtifact"        server/src/runtime/titan-media-production.ts
check "TITAN_PRODUCIBLE_MEDIA_KINDS"     server/src/runtime/titan-media-production.ts
check "resolveBlender"                   server/src/runtime/titan-media-production.ts
check "renderWithGodot"                  server/src/runtime/godot-render-lane.ts

echo "── 7. the full conductor (canonical media pipeline) ──"
check "runCanonicalMediaPipeline"        server/src/runtime/canonical-media-pipeline.ts
check "CANONICAL_ORDER"                  server/src/runtime/canonical-media-pipeline.ts
check "resolveLocalVideoComputeNode"     server/src/runtime/canonical-media-pipeline.ts
check "verifyCanonicalCommit"            server/src/runtime/canonical-media-pipeline.ts
check "createLocalRenderMeshCluster"     server/src/runtime/render-mesh-local.ts

echo "── 8. optional LTX-2B neural finish (honest CONFIG_HOLD) ──"
check "planVideoProduction"              server/src/runtime/sovereign-video-engine.ts
check "ADAPTER_RESIDENCY_TIERS"          server/src/runtime/sovereign-video-engine.ts
check "VideoConfigHold"                  server/src/runtime/sovereign-video-engine.ts

echo "── 9. eviction / heavy-job scheduler (8GB reality, shared with coding-gen) ──"
check "awaitHeavyJobClearance"           server/src/runtime/memory-pressure-guardrail.ts
check "releaseOllamaResidency"           server/src/runtime/ollama-local-provider.ts
check "runScheduledInference"            server/src/runtime/inference-scheduler.ts

echo "── 10. governed media provider ladder (local-first, NIM non-default) ──"
check "selectGenerativeMediaProvider"    server/src/runtime/inference/generative-media-router.ts
check "runGenerativeMedia"               server/src/runtime/inference/generative-media-router.ts

echo "── 11. media licence gate + eviction cap ──"
check "classifyMediaWeight"              server/src/runtime/media-weights-licence-gate.ts
check "evictOldEvidenceScreenshots"      server/src/runtime/evidence-screenshot-capture.ts
check "SOLOMON_EVIDENCE_MEDIA_MAX_BYTES" server/src/runtime/evidence-screenshot-capture.ts

echo "── known integration gaps (informational — see SKILL.md Phase 3) ──"
absent "awaitHeavyJobClearance" server/src/runtime/titan-media-production.ts "Blender-lane eviction-contract"
absent "runCanonicalMediaPipeline" server/src/routes "canonical-pipeline route-wiring"

echo "────────────────────────────────────────────"
echo "  ${pass} resolved, ${fail} moved."
if [ "$fail" -ne 0 ]; then
  echo "  RESULT: FAIL — the interface map is stale. Re-grep the moved symbols before using this skill."
  exit 1
fi
echo "  RESULT: PASS — all seams resolve on this checkout."
