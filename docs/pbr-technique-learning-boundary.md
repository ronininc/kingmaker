# PBR technique learning and validation boundary

The new PBR job and trusted Blender importer load actual material images, not a screenshot or flat approximation. A bounded real test imported three 1K Wood Planks JPEG maps from Poly Haven, authored by Amal Kumar, CC0; total1,561,723bytes. Publisher MD5 and local SHA256 verified. Source https://polyhaven.com/a/wood_planks ; license https://polyhaven.com/license . Maps are outside the source repository; no production catalog admission or redistribution performed.

Reopened saved material verifies all three packed1024x1024images, base-color sRGB, scalar/normal Non-Color, and real Principled/NormalMap links. This demonstrates import plumbing only. No photorealistic scene has been rendered or certified.

To turn examples into transferable Kingmaker skills, learning should propose bounded material plans from documented channel semantics and observed map metadata, not copy a source preview or silently activate arbitrary shader code. The trusted implementation enforces the plan. Required evaluation cases: unseen map naming/layout, normal convention conversion, metallic versus dielectric distinction, scale/UV mapping, roughness response under changed lighting, and mismatched/missing maps. Hold out a different material to distinguish recipe reuse from generalization. Source licensing and provenance must remain attached.

Current learned-language path does not yet target this importer, and no training/fine-tuning or generalized photorealistic skill was achieved. Next integration is an explicit reviewed material-plan method producing map-role IDs and normal convention, with independently checked rendering against a material target. Preserve failure states: prepared-not-imported, material-imported, visually-reviewed, and user-accepted are distinct.

Remaining: mesh import, detailed geometry, UV/scale correctness, HDRI or art-directed lighting, geometric displacement, render preset benchmarking, aesthetic/temporal review. Importing maps alone cannot replace these. Proof uses JPEG maps to minimize disk; lossless normal/scalar maps may be preferable for final work.
