# Hero-detail visual review, iteration 3

Actual PNG inspected: `pbr-import-proof/hero-detail-v3/hero-door.png` (integration workspace), 768x768,96sample CPU render. This is an assistant-authored material/geometry study, not autonomous Kingmaker generation.

## Diagnosed and corrected

- Black upper-jamb rectangles were overlapping coplanar jamb/lintel faces, not a GPU limitation. Shortened jamb geometry to terminate at lintel underside.
- Cross-board texture seams came from projecting an entire multi-plank texture across separate geometry and then allowing longitudinal UV wrapping. Each physical board now samples an interior source strip without wrapping over its endpoints. Actual iteration3 image no longer shows the black corners or horizontal seam grid.
- Added bounded procedural roughness variation to metal/plaster instead of a single constant. Existing Cycles lighting visibly casts cyan grazing illumination and highlights hardware.

## Real-photo comparison

Inspected a real antique-door photo from Historische Baustoffe, not used as a texture, training input or copied design:
https://www.historische-baustoffe.de/de/die-haendler/haendlerverzeichnis/dieter/

The photo shows irregular age-related color variation, worn/chipped edge geometry, uneven plank surfaces, mottled iron patina and accumulated contact dirt within an authentic surrounding wall. Our image lacks that multi-scale, spatially correlated wear. Hardware remains too regular and clean; flat wood geometry plus image maps does not reproduce deep weathering. Studio framing/lighting is intentional but does not substitute for those surface/geometry cues.

## Assessment

Artifact fixes: pass by inspection. Material integration: pass (real texture roles and geometry influence image). Photorealistic quality: not accepted. Generalized learned creation: unproven. Full saloon/game scene: not attempted.

The fundamental present blocker is capability/content and art-direction evaluation, not a demonstrated inability of the M3 to render the still. A useful next engineering task is a bounded surface-condition model that links geometry wear, roughness, pigment/oxidation and dirt to edges/exposure/contacts, evaluated on held-out material/lighting conditions. Repeatedly hand-authoring increasingly attractive scripts does not establish that Kingmaker learned this behavior. No user delivery or quality certification is warranted yet.
