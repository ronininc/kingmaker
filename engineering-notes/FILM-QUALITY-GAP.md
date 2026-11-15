# Production-quality target and current evidence

Robbie's target is Cyberpunk 2077-level asset quality or better for Kingmaker's knowledge/skill synthesis. Treat this as an aspirational visual benchmark, not a certification or permission to extract proprietary game assets. Rendering fidelity and general reasoning/skill synthesis are separate capabilities; success in one does not establish the other.

## What is implemented and tested

- `lib/film-production.mjs`: bounded JSON scene validation, explicit executable paths, one-thread Blender calls, frame/duration checks, FFmpeg assembly, persisted SHA-256 artifact receipt, budget enforcement.
- `assets/film/scene-builder.py`: five primitive types, base color/emission with fixed metallic/roughness, fixed two-light setup, one static camera per shot, linear translation/rotation animation. Cycles CPU at eight samples, no texture inputs.
- `catalog/methods/escapement-film-loop.method.md`: asks the injected reasoner for a brief and bounded procedural plan. It does not import production assets, synthesize rigs, run TTS or autonomously judge final visual fidelity.
- Actual Mac proof on 2026-11-15: four 128x128 frames, two-second MP4, desk slab and emissive panel. Verified bytes SHA-256 `636e81d89b317f06d8b1bae158886448a067bc00651c62bf4c3fab8c5e6d9987`; first frame 5.399 seconds, shot 6.507 seconds, whole directory 1.8 MB. This is a pipeline smoke test only.
- Blender previously crashed in Metal startup, later passed unchanged. Reproducibility is not yet established.

## Missing implementation, in dependency order

1. **Explicit request/profile admission.** Preserve the user's fidelity target outside model-generated JSON. The producer now rejects any explicit `qualityTarget` except `procedural-proof`. Runtime callers must pass the requested profile into the producer closure; a model omitting the field must not erase the user's target. The default remains compatible with old proof callers. This is a guard, not a complete end-user routing integration.
2. **Asset registry and import adapter.** Catalog owner-approved or licensed character, environment, props, and motion assets with file digest, provenance, license, dependencies, unit/axis metadata and texture paths. Admit bounded GLB/glTF or another selected data format through a trusted importer. Forbid arbitrary embedded scripts, remote URLs and traversal. This adapter currently accepts no external meshes at all.
3. **Material/look development.** Add explicit bounded PBR texture bindings (base color, normal, roughness, metallic, displacement), correct color spaces, texture budgets, approved HDRI and lights. Add deterministic camera, exposure and color-management settings. Higher resolution or more samples alone will not supply missing art direction or asset detail.
4. **Character and motion pipeline.** Rig compatibility checks, animation clips/retargeting, skinning, facial blendshapes and lip-sync alignment. A seated character addressing camera requires acting, gaze and hand motion, not merely two transform endpoints. Verify topology, deformation and identity consistency across shots.
5. **Audio pipeline.** Select an approved narration source or governed TTS provider, preserve transcript/voice permissions, generate timing cues, align speech and subtitles, mix music/SFX with licensed provenance. Existing audio mixing is not speech synthesis or lip sync.
6. **Render backend and resource admission.** Support a tested production preset with denoising, configurable bounded samples, textures, render layers, compositing and suitable delivery codec. Benchmark first frames of representative *actual* scenes. Queue jobs with cancellation/resume and artifact transfer on approved GPU compute or a suitable local machine. Do not promise full-scene fidelity on the current near-full Mac; no remote upload/payment is authorized by this document.
7. **Visual review and iterative repair.** Preserve a fixed approved reference board, scene brief and shot continuity. Check output frames for missing textures, intersections, deformation, noise, flicker, readable graphics, lip sync and audio clipping. Keep numerical media integrity separate from aesthetic assessment; require review evidence rather than a reasoner self-awarding a score.
8. **Knowledge/skill synthesis evaluation.** Trace which method, corpus evidence, weights/runtime and tools each request actually used. Test held-out briefs, grounding, planning, tool execution, failure recovery and user acceptance independently of the image quality score. A streamed repository/weight path is not evidence that the model used it or reached useful capability.

## Practical next milestone

Use one approved high-quality character and one small approved desk/environment asset set, one locked camera, one short utterance and a few seconds of motion. Validate licenses and files first, implement/import those bounded formats, then compare a first-frame preview and short motion sample to an approved visual reference. Do not download multi-GB asset collections or touch Grok's work without scope and resource checks. The completed primitive proof is diagnostic evidence, not a substitute deliverable.

No Cyberpunk-level quality, general intelligence upgrade, or production readiness is claimed by this change.
