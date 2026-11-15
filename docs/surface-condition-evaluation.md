# Original bounded surface-condition skill evaluation

This skill is an independently authored rectangular UV-patch heuristic. Edge distance, contact height and exposure share a deterministic mask that drives generated color, roughness and height. Parameters are metric where possible; geometry offset is capped at3mm. No third-party assets, model weights or physical weathering claims.

Four unit cases pass, including three previously unused patch aspect ratios, zero controls, deterministic seeds and strict resource bounds. Controlled Blender test rendered neutral/conditioned variants under left/right lighting,384x384,32samples. Both actual conditioned images were inspected against neutral. Edge response and contact-darkening are visible across lighting changes. Actual maximum vertex displacement0.847mm versus0neutral.

This establishes consistent channel/geometry effects, NOT measured photorealistic improvement. Edge faceting remains visible and the patch is visually simple. Difference statistics measure change, not quality. No user-facing showcase is appropriate. Only rectangular surface patches tested; curved/complex meshes, artist-approved wear and generalization through a language model are unproven.

Next integration: a model can select reviewed controls through the included schema, then run held-out control-selection tests. Separate surface-condition quality tests must compare plausible contact/edge aging with reference material under different lighting and assess topology artifacts. Do not label the original algorithm itself learned merely because a model calls it.

## Live model-selected controls

Integration assessment used already-installed Granite4.1-3B with strict bounded JSON controls. Three unseen request/size pairs executed the actual native method: fresh protected0/0/0; aged/exposed1/1/1; dirty sheltered0/1/0 for wear/dirt/exposure. All three satisfied predeclared semantic thresholds and each wrote four verified PNG maps. Height limit selected.003m, with zero wear causing zero displacement in intact cases. Raw evidence in sibling surface-selection-proof/results.json. Script scripts/assess-surface-selection.mjs is reproducible against an explicitly selected local model.

This shows model-driven parameter selection of an existing independently authored technique, not learning a new algorithm from a photo. Numeric controls and map bytes do not establish aesthetic improvement. The controlled renders still showed faceting and visually simple treatment; photorealism remains unaccepted. No larger scene/quality claim or user completion.
