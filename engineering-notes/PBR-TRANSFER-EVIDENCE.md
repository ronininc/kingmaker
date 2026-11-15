# Actual PBR technique transfer assessment

## Tested capability
Synthetic held-out metadata tasks use previously unseen opaque asset IDs and declared semantic roles. Same task/output contract and strict scorer before and after a reusable technique guide. Cases: DirectX normal conversion, OpenGL normal plus metallic/roughness, unsupported glossiness. No test images are passed to the model; this is map-recipe planning, not visual understanding or image-quality generalization.

Guidance independently states correct color-space/normal conventions and current importer limitations. Official references: https://docs.blender.org/manual/en/latest/editors/image/image_settings.html and https://docs.blender.org/manual/en/5.2/render/shader_nodes/displacement/normal_map.html . Data maps require non-color treatment; OpenGL is Blender's default normal convention. No source implementation copied. Existing user-authored methods remain theirs.

## Real local-model measurements
- qwen3:1.7b, initial unstructured JSON contract:0/3baseline,0/3guided. Bad IDs/channel names and unsupported gloss accepted.
- Same qwen model, strict JSON schema:1/3baseline,1/3guided. Guided corrected DirectX flip but invented empty metallic input; gloss still mislabeled.
- Already installed Granite4.1-3B model, identical strict schema/tasks/scorer:1/3baseline,3/3guided. Both valid channel assignments/conventions correct; unsupported gloss refused.

Raw results reside in sibling pbr-transfer-proof: results-unstructured.json,results-structured-qwen.json,results-granite.json. No failed output discarded to inflate score. Each call deterministic temperature0, explicit local model, bounded context/response/time, no downloads; keep_alive0. No default production model changed. Three cases are far too few to establish broad reliability. Guide is contextual knowledge, not weight training or a durable self-improving learner.

## Runtime prevention
`prepareLearnedPBRMaterialJob` validates proposed recipes against separately reviewed semantic labels bound to each manifest SHA256 before calling the real PBR preparation path. It rejects invented/empty map inputs, unsupported gloss/packed channels, wrong color spaces, unknown normal convention and wrong green inversion. Labels are claims requiring source review, not inferred visual truth. An unsupported response never executes. This gate is executable reusable technique knowledge, not a claim the model becomes infallible.

The real importer previously consumed source-cleared CC0Wood Planks and Blender independently reopened three packed1024maps with actual shader links. That proof is real material consumption, separate from transfer results above. No new production-quality visual result follows from either fact. A held-out second source material, actual geometry/shading integration and reviewed image quality are still needed before claiming broader visual synthesis or user goal complete.
