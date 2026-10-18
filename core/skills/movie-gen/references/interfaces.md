# movie-gen — verified interface map

The real engine seams this skill builds AGAINST. **Never trust the paths or symbol
names below from memory — re-`grep` them before you use them.** Files move, symbols
get renamed, and a stale citation is how a build silently drifts off the spine. Each
row names the symbol; find the current home with `grep -rn "<symbol>" server/src`.
`scripts/verify-interfaces.sh` in this skill greps every symbol and fails if one has
moved — run it first.

The paths are in the engine's source, which ships compiled inside Kingmaker.app and is not in this
repository: the greps, and `scripts/verify-interfaces.sh`, resolve only in a checkout that carries it.

Everything here was confirmed present on the branch this skill shipped from by direct
grep, not by recollection. It is a map, not a snapshot: the map tells you what to look
for, the grep tells you where it is now.

## 1. Brief → intent — parsing the creative brief

Any subject/style brief ("a Mirror's Edge-style parkour short", "a product reel of
Vito's calzones", "a 3d model of a bracket") is parsed into ONE agnostic intent, never
a privileged per-genre route.

| What | Symbol | Home |
|---|---|---|
| Parse transcript → intent | `parseMediaIntent(transcript)` | `server/src/runtime/media-intent.ts` |
| Intent shape | `MediaIntent` (`subject`, `format`, `treatment`, `archetype`, `merchant`, `products`) | same file |
| Output shape enum | `MediaFormat` = `'motion' \| 'video' \| 'still' \| 'model3d'` | same file |
| Feel/genre enum | `MediaTreatment` = `'cinematic' \| 'promo' \| 'game' \| 'documentary' \| 'explainer'` | same file |
| Scene-geometry hint | `SceneArchetype` = `'parkour' \| 'arena' \| 'showroom'` | same file |

`intent.subject` is the whole meaningful prompt and is NEVER demoted to a placeholder
— a parkour short's subject stays "a person free-running across Manhattan rooftops",
not "This business". `archetype` only fires on a known geometry hint (parkour / arena
/ showroom courtesy of `game-world-generator.ts` below); anything else renders through
`showroom` rather than refusing.

## 2. Shot list — turning the brief into an adjustable scene spec

| What | Symbol | Home |
|---|---|---|
| Draft a scene spec from the request | `writeSceneSpec(request, options)` | `server/src/runtime/codegen-scene-spec.ts` |
| Draft shape | `SceneSpecDraft` | same file |
| Surface material options | `SURFACE_OPTIONS` | same file |

`writeSceneSpec` is CodeGen's half of the three-engine split documented in
`media-production-orchestrator.ts` (§3): it authors the scene script — title, logline,
**beats** (the shot list), and the parameters that will become adjustable controls —
before anything renders.

## 3. Decide before you render — the parameter/session engine

The whole point of this seam: **iteration happens on a surface that costs nothing,
and the expensive render runs exactly once.** Do not re-render per note; negotiate
the spec, then render.

| What | Symbol | Home |
|---|---|---|
| Shared scene contract | `SceneSpec` (`title`, `logline`, `beats`, `parameters`, `provenance`) | `server/src/runtime/media-production-orchestrator.ts` |
| Parameter shape | `SceneParameter`, `ParameterKind`, `ParameterStage` | same file |
| Turn spec → live controls | `fabricateControls(spec)` → `ControlSurface` | same file |
| What a renderer can actually honour | `RendererCapability`, `GODOT_FORWARD_PLUS` | same file |
| Validate spec against renderer BEFORE any control is shown | `negotiate(spec, capability)` → `NegotiationResult` | same file |
| Open a decide-then-render session | `openSession(request, spec, now?)` → `ProductionSession` | same file |
| Apply one adjustment (no render) | `applyAdjustment(spec, parameterId, value)` → `AdjustmentResult` | same file |
| Which constraints have settled | `settledConstraints(session)` | same file |
| Cost accounting (renders avoided vs. paid) | `accountFor(session)` → `CostAccount` | same file |

`provenance` marks each field `SPOKEN \| DERIVED \| DEFAULT` — a value the operator
stated must never be silently overwritten by a default. `ProductionSession` is the
pure decision-state object; it does not itself call Titan (§6) — the caller renders
once, after `negotiate`/`applyAdjustment` settle, and records the result at
`finalArtifactPath`.

> ⚠️ **Verified this build:** no route or dispatch case in `server/src/routes/` or
> `route-dispatch.ts` calls `openSession`. The engine is real and typed but sits
> unconnected to any entrypoint — see the Phase-3 TODO(integrate) in SKILL.md.

## 4. Scene graph — deterministic geometry from the brief

| What | Symbol | Home |
|---|---|---|
| Generate a game-world scene graph | `generateGameWorld(request)` → `GeneratedGameWorld` | `server/src/spatial/game-world-generator.ts` |
| Archetype enum | `GameWorldArchetype` = `'parkour' \| 'arena' \| 'showroom'` | same file |
| Manifest shape (seeded, deterministic) | `GameWorldManifest` | same file |

Seeded from `seedFrom(seed, environmentId)` — the same request produces the same
layout, so a re-render for a note is reproducible, not a re-roll.

## 5. Scene graph → Blender objects (the agnostic composer)

| What | Symbol | Home |
|---|---|---|
| Map a world graph → Blender worker object list | `sceneObjectsFrom(worldObjects)` | `server/src/runtime/scene-media-producer.ts` |
| One-call intent → real local artifact | `produceSceneMedia(intent, opts)` → `TitanMediaProductionResult` | same file |

`sceneObjectsFrom` is exported specifically so `canonical-media-pipeline.ts` (§7) and
this composer use the SAME object mapping — one lane, one truth, never a duplicated
scene-to-geometry translation that could drift.

## 6. Deterministic render dispatch — Blender + Godot + ffmpeg (the small-hardware base)

Zero neural weights. This is the base that fits an 8GB box by SEQUENCING, not by
being lower-quality by design.

| What | Symbol | Home |
|---|---|---|
| Producible kinds | `TITAN_PRODUCIBLE_MEDIA_KINDS` (`scene_preview_png`, `cinematic_still_png`, `reference_capture_png`, `video`, `3d_model`, `baked_glb`, `rebake`, `animation_sequence`) | `server/src/runtime/titan-media-production.ts` |
| Refused kinds (named gap, not a bare no) | `TITAN_UNSUPPORTED_MEDIA_KINDS` | same file |
| Single dispatch entrypoint | `produceTitanMediaArtifact(request)` → `TitanMediaProductionResult` | same file |
| Request/result shapes | `TitanMediaProductionRequest`, `TitanMediaArtifact`, `TitanMediaQualityReport` | same file |
| Resolve the Blender binary | `resolveBlender()` | same file |
| Resolve the bounded Blender worker script | `resolveBlenderWorker()` | same file |
| Blender still/video/3D/bake lane | `produceBlenderArtifact(request, kind)` (internal; reached via `produceTitanMediaArtifact`) | same file |
| Blender→Godot round-trip re-bake (up to 4K) | `produceBlenderRebake(request)` (internal) | same file |
| Godot Movie Maker → real h264 mp4 | `produceGodotAnimation(request)` (internal) → `renderWithGodot` | same file → `server/src/runtime/godot-render-lane.ts` |
| Godot render entrypoint | `renderWithGodot(request)` → `GodotRenderResult` | `server/src/runtime/godot-render-lane.ts` |

Load-bearing facts to preserve:

- `produceTitanMediaArtifact` is the ONE dispatch point — build against it, never call
  `runBlender`/Blender args or Godot CLI flags directly from this skill's workflow.
- Every produced artifact is independently re-verified from the bytes on disk
  (`verifyBlenderArtifact`, `verifyProducedPng`) — dimensions, sha256, container —
  never trusted from the worker's own stdout claim.
- `animation_sequence` runs through Godot's real Movie Maker mode + ffmpeg mux
  (`renderWithGodot`), proven at 45 frames of 1280×720, ffprobe-verified. `--headless`
  cannot capture frames on this stack; the lane uses a real windowed Metal context.
- The evidence dir enforces a shared **2GB media cap** across every kind — see §9.

> ⚠️ **Known integration gap (verified this build, grep-confirmed):**
> `godot-render-lane.ts`'s `renderWithGodot` calls `releaseOllamaResidency()` and
> `awaitHeavyJobClearance()` before spawning (the eviction contract, §8). The Blender
> lane (`produceBlenderArtifact`, `produceBlenderRebake` — cinematic_still_png, video,
> 3d_model, baked_glb, rebake) does **NOT** — `grep -n "awaitHeavyJobClearance\|
> releaseOllamaResidency" server/src/runtime/titan-media-production.ts` returns
> nothing. Blender is spawned as a heavy synchronous child process with no admission
> check. **This is a `// TODO(integrate)` seam for the engine team, not something to
> patch into engine internals from this skill.** Until it is wired, YOUR workflow
> calls `awaitHeavyJobClearance()` itself before requesting any Blender-lane kind.

## 7. The full conductor — the actual movie-gen entrypoint to drive

This is the built, tested, end-to-end production pipeline: intent → evidence → scene
graph → Blender⇄Godot round-trip → video → neural finish (optional) → sealed commit.
**Drive this, do not hand-roll the sequencing yourself.**

| What | Symbol | Home |
|---|---|---|
| Run the full pipeline | `runCanonicalMediaPipeline(request)` → `CanonicalMediaResult` | `server/src/runtime/canonical-media-pipeline.ts` |
| Request/result shapes | `CanonicalMediaRequest`, `CanonicalMediaResult`, `PipelineStage`, `PipelineStageName` | same file |
| The fixed stage order (asserted by proof) | `CANONICAL_ORDER` | same file |
| Resolve this host's real video compute node | `resolveLocalVideoComputeNode()` → `VideoComputeNode` | same file |
| Independently re-verify a sealed commit | `verifyCanonicalCommit(result)` | same file |
| Blender⇄Godot round-trip cluster (the multi-stage sequencing primitive) | `createLocalRenderMeshCluster()` → `RenderMeshCluster` | `server/src/runtime/render-mesh-local.ts` |

Load-bearing facts to preserve:

- The pipeline is **non-throwing**: every stage is guarded, so one engine failing is
  reported per-stage (`DONE \| DEGRADED \| SKIPPED \| FAILED`) and the conductor still
  seals a commit of whatever really ran. `ok` is true only when a real artifact
  (video or round-trip glb) was actually delivered — never inferred from stage count.
- `resolveLocalVideoComputeNode()` derives `materializedAdapters` from real
  `.ready` marker files under `data/worker-node/models/`, not a hardcoded claim — a
  box with LTX-2B weights actually present reports `READY`; a box without reports
  `CONFIG_HOLD` from the exact same code path (§8).
- `verifyCanonicalCommit` recomputes `sha256(JSON.stringify(sealedManifest))` and
  compares — a REAL check, not a format regex. Use it in Phase 5 proof, not a
  hand-rolled hash comparison.

> ⚠️ **Known integration gap (verified this build, grep-confirmed):** no file under
> `server/src/routes/` and no case in `server/src/runtime/route-dispatch.ts` calls
> `runCanonicalMediaPipeline` — `grep -rn "runCanonicalMediaPipeline" server/src/routes
> server/src/runtime/route-dispatch.ts` returns nothing. The conductor is built and has
> a passing proof (`tests/canonical-media-pipeline/run.ts`) but is not reachable from
> any operator-facing surface. **This is a `// TODO(integrate)` seam** — wiring an
> HTTP route or a voice/typed dispatch case is engine-team work, not an edit this
> skill makes from the outside.

## 8. Optional LTX-2B neural finish — PREVIEW tier, honest CONFIG_HOLD

The one finisher safe to default-declare on the primary 8GB node. Everything else
(Wan-VACE, CogVideoX-Fun, AnimateDiff+ControlNet) is mesh-only or retired — see
`ADAPTER_RESIDENCY_TIERS` below; do not default-declare them on a single 8GB box.

| What | Symbol | Home |
|---|---|---|
| Adapter id | `SovereignVideoAdapterId` (`'LTX_VIDEO' \| 'WAN_VACE' \| 'COGVIDEOX_FUN' \| 'ANIMATEDIFF_CONTROLNET'`) | `server/src/runtime/sovereign-video-engine.ts` |
| Quality tier | `VideoQualityTier` = `'PREVIEW' \| 'BALANCED' \| 'FINAL'` | same file |
| Task/node shapes | `SovereignVideoTask`, `VideoComputeNode` | same file |
| Where each adapter is allowed to live by default | `ADAPTER_RESIDENCY_TIERS` (LTX_VIDEO = `PRIMARY`; Wan-VACE = `MESH_ONLY`; the rest `RETIRED`) | same file |
| Score/select an adapter | `selectSovereignVideoAdapter(task, node)` → `AdapterDecision` | same file |
| Non-throwing planner (the seam to call) | `planVideoProduction(task, node)` → `VideoProductionPlan` | same file |
| Honest deferral shape | `VideoConfigHold` (`state:'CONFIG_HOLD'`, `produced:false`, no fabricated model profile) | same file |
| Resolve real cached weights → adapters | `materializedAdaptersFromCachedModels(cachedModels)` | same file |

Load-bearing facts to preserve:

- `planVideoProduction` returns `{ state: 'READY', ...proposal }` **only** when
  `videoAdapterWeightsPresent` confirms real weights are materialized on the node;
  otherwise a `VideoConfigHold` with no `modelProfile` — never a fabricated readiness.
- On an 8GB Apple-Silicon box (`gpuKind==='MPS'`, `memoryGb>=8`), `LTX_VIDEO` at
  `qualityTier:'PREVIEW'` is the one policy-eligible adapter; `FINAL` tier on the same
  box requires `memoryGb>=64` — an 8GB box asking for `FINAL` correctly fails closed
  to `CONFIG_HOLD` rather than silently downgrading the tier it reports.
- `task.allowNetwork` is typed `false` — the sovereign video task itself cannot
  request egress; any escalation goes through the governed media provider ladder
  (§10), never through this planner.

## 9. Eviction / heavy-job scheduler — the 8GB reality (shared with coding-gen)

Same contract coding-gen builds against: only ONE heavy job at a time. A Blender or
Godot render IS a Tier-2 heavy job exactly like a coder-model generation.

| What | Symbol | Home |
|---|---|---|
| Anti-swap bounded wait before a heavy job | `awaitHeavyJobClearance(maxWaitMs)` | `server/src/runtime/memory-pressure-guardrail.ts` |
| Memory-pressure detection | `isUnderMemoryPressure`, `engageHeavyJobDeferral`, `heavyJobsDeferred` | same file |
| Free the resident local model before a render | `releaseOllamaResidency(timeoutMs)` | `server/src/runtime/ollama-local-provider.ts` |
| Honor `OLLAMA_MAX_LOADED_MODELS` | `enforceOllamaResidencyCap`, `planResidencyEviction` | `server/src/runtime/ollama-residency-cap.ts` + `ollama-local-provider.ts` |
| Single-instance inference queue (live preempts background) | `runScheduledInference(lane, task)`, `MAX_CONCURRENT_INFERENCES` | `server/src/runtime/inference-scheduler.ts` |

`godot-render-lane.ts` already calls `releaseOllamaResidency` then
`awaitHeavyJobClearance` before spawning Godot (verified — see the comment at the
call site: "PHASE-5 (8GB density)"). §6's gap note is that the Blender lane does not
yet do the same — your workflow closes that gap procedurally until it is wired.

## 10. Governed media provider ladder + zero-egress cap

Local-first, zero-egress by default; NIM is a free, non-default, non-sensitive-only
fallback — the same shape as coding-gen's provider ladder, for media instead of code.

| What | Symbol | Home |
|---|---|---|
| Task/selection shapes | `GenerativeMediaTask`, `MediaProviderSelection`, `MediaProviderTier` (`'local' \| 'nim'`) | `server/src/runtime/inference/generative-media-router.ts` |
| Select local vs. NIM (never defaults to egress) | `selectGenerativeMediaProvider(task, localNode?)` | same file |
| Run the selected provider | `runGenerativeMedia(task, localNode?)` → `GenerativeMediaResult` | same file |

Load-bearing facts to preserve:

- Tier 0 (local GPU, materialized weights) is preferred whenever possible — zero
  egress, zero tokens.
- A task that asserts it may carry protected/customer data is refused NIM outright,
  even with egress otherwise permitted (`sel.tier === null`) — local-only, no
  exception.
- NIM is Tier 1 fallback ONLY: no protected data, egress permitted, and local
  genuinely cannot (no weights / no GPU). It never fires by default.

## 11. Media licence + eviction caps (commercial-output and disk-bound safety)

| What | Symbol | Home |
|---|---|---|
| Licence-gate a diffusion/video weight for commercial output | `classifyMediaWeight({id,name,licence})` | `server/src/runtime/media-weights-licence-gate.ts` |
| ComfyUI generative-image capability (computed, not hardcoded) | `resolveComfyUiCapability()` → `ComfyUiCapability` | `server/src/runtime/titan-media-production.ts` |
| Auto-scaling media tier from real probed memory | `resolveMediaModelTier(memBytes)`, `resolveLocalMediaTierFromGpu(probe?, systemMemBytes?)` | same file |
| Shared evidence-dir media cap (2GB default, bytes not count) | `evictOldEvidenceScreenshots(dir)` + `SOLOMON_EVIDENCE_MEDIA_MAX_BYTES` env | `server/src/runtime/evidence-screenshot-capture.ts` |
| Evidence dir paths | `getEvidenceScreenshotsDir()`, `getEvidenceScreenshotWorkDir()` | `server/src/utils/runtime-paths.ts` |

`evictOldEvidenceScreenshots` runs in a `finally` block after EVERY
`produceTitanMediaArtifact` attempt (verified in `titan-media-production.ts`) so the
cap holds regardless of which producer wrote — a movie-gen run that emits many shots
across a sequence never grows the evidence dir unbounded.
