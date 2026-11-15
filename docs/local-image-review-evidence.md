# Actual local image-aware review evidence

The installed Ollama inventory declares vision for `huihui_ai/qwen3.5-abliterated:2b`. A read-only bounded pipeline now sends actual PNG bytes to that existing model on loopback, records image SHA256/model digest, requires a structured response, and never executes model output. No model downloads, training, remote image transmission or changes to installed Kingmaker occurred.

Actual test: the model described the hero render as a wooden door with dark metal hinges and brass ring handle, correctly recognizing visible components. For a control image showing only a plain rendered rectangle, it reported a smooth gradient rectangular surface without hinges/handle, but still called it a door. This category inference is not verified fact.

Quality assessment is weak: the hero defects list contained generic observations such as grain variation and shadowing rather than actionable artifact diagnoses. The control returned no defects. This is NOT a reliable photorealistic acceptance gate. No score or acceptance flag is produced. Image observations require independent inspection.

First trial truncated JSON at384tokens and was rejected; concise schema with768token cap completed. Context2048, local model residency reported about1.59GB; keep_alive0 requested unload after calls. Two unit tests verify actual image payload/loopback confinement and refusal of nonvision model inventory. Actual receipts: `kingmaker-451-fixes/image-review-proof/{hero-review,control-review}.json` outside source tree.

Current blocker: no tested local image-generation or quality-judging backend. A vision model can observe pixels but does not provide photorealistic generation by itself. Current authored renderer and bounded skills remain separate; wiring this weak review into automatic success/retry/admission would be misleading. More diverse labeled artifact/realism evaluation is needed before any quality automation. No user-facing result should be called done on this evidence.

## Integration validation

Hardened actual pipeline to bound streamed inventory/review responses before buffering, require a recorded installed model digest, reject wrong-model or length-truncated generation even if its JSON parses, and enforce the requested review field limits. Added missing-boundary tests.

Actual local rerun on hero-detail-v3 (image SHA256 a1b854b5eec14504823bf0e8776797689c851387a5c7aac2b76af567fcd5e714) completed under these checks and correctly described wood, hinges and brass handle. Defect list remained generic (grain variation, surface imperfections, shadowing), not a reliable diagnosis or quality acceptance. Receipt in image-review-proof/hero-review-validated.json. No external transmission, model download or automatic renderer changes.

The remaining blocker is now measured: local image observation exists, but no tested image-generation/backend or reliable visual-quality evaluation loop is available in this pipeline. Ordinary rendering plus an image description cannot be presented as autonomous learned photorealism. Paid remote access remains unselected/disabled and cannot be assumed available as fallback. User completion remains pending.
