# Photo/video source coverage and native execution boundary

Checked 2026-11-15. This inventory closes the supplied reference list, not asset/license admission or implementation of every referenced capability. No new models, datasets or plugins downloaded. Individual asset rights, revision, digest and runtime requirements must be reviewed before delivery/execution. Source presence is never an execution receipt.

## Executable original built-ins

| Built-in | Actual output | Still missing |
|---|---|---|
| pbr-synthesis | Five deterministic PNG material maps | Artist-grade arbitrary materials; high-resolution measured fidelity |
| lathe-mesh | Original rotational GLB mesh | General modeling, sculpted anatomy, topology repair |
| textured-lathe | GLB with embedded original maps | General asset assembly and shader equivalence |
| usd-lathe | USDA mesh and basic preview material | MaterialX/MDL, physics/SimReady certification |
| camera-orbit | Calibrated pinhole poses/intrinsics JSON | Renderer parity, depth/segmentation/occlusion labels |
| edit-timeline | Frame-exact clip/gap edit decisions JSON | Actual media validation/render, audio mix, transitions, OTIO interoperability |

All six have bounded artifact tests. Methods remain staged, not default admitted. Earlier 35 provider workflow descriptions are reference-only, not native capabilities. The bounded Blender primitive film producer exists separately and is not human/cinematic quality.

## Asset, character and material references

- Blender Studio Base Meshes: reviewed CC0 base-mesh offering; specific version and file provenance required. Independent anatomy/rigging implementation absent.
- MakeHuman/MPFB2: GPL code, bundled CC0 assets, community assets separately licensed; no installed working adapter assumed. Native morph system and deformation rig absent.
- Mixamo: account-based service, commercial outputs permitted under Adobe guidance; raw asset redistribution/training not presumed. Native autorig/retarget absent.
- Poly Haven, ambientCG, 3DTextures.me, cgbookcase: CC0 asset offerings; exact files, origin and integrity still required. Poly Haven API terms separate. cgbookcase DirectX normal green channel conversion needed for OpenGL.
- BlenderKit: CC0 or royalty-free per asset, not blanket raw redistribution.
- Smithsonian 3D: only marked open-access CC0 items. Sketchfab: per-item license; NC/SA/ND not auto-admitted.
- LoopTools, BoolTool, Rigify, Node Wrangler: GPL tool references, not native implementation. Version-specific Blender compatibility required.
- Sanctus Lite: exact Lite entitlement and asset redistribution rights unresolved; hold admission.
- Khronos glTF sample assets: per-model licenses. glTF PBR packing informs original implementation; samples not ingested.
- pmndrs market: advertised CC0 assets; code and individual asset provenance separate.
- AMD GPUOpen MatLib: MaterialX technique reference; specific asset license unresolved, no shader parity claimed.
- Three.js/R3F: MIT framework code; example media rights separate. Babylon: Apache-2.0. PlayCanvas: MIT engine. Needle: product licensing separate. None installed as a native substitute.
- NVIDIA PhysicalAI-SimReady-Materials: official materials/textures MIT-0; preserve dependencies and relative paths. OpenPBR/MaterialX runtime absent; basic USDA is not SimReady.
- Omniverse USD samples: per-pack terms, no blanket license. Objaverse: collection ODC-By and mixed individual licenses, no blanket commercial ingestion.
- Hugging Face: platform is not a license. HSRD-100 official card CC-BY4, static adult human OBJ/PNG scans, not rigged animation; likeness/use scope still matters. Full repository 246GB, no download.

## Additional AAA list supplied in Markdown

Quixel/Fab, 3DScanStore, MetaHuman, Renderpeople, HumanAlloy, KitBash, ArtStation, GrabCAD, Substance, Weta, Disney/Moana, NVIDIA, CitySample, USC Digital Emily, Eisko, Blender Studio are recorded as leads, not blanket-approved libraries. Quixel official November 2026 update says Megascans free again, but precise updated asset/AI terms must bind admission. Moana and CitySample are large production/reference packages, not drop-in native skills. Remaining specific products/assets require direct license/version review. Do not convert the supplied third-party claims into verified rights.

## Procedural, editorial and production sources

Individual JSON records here cover BlenderProc (GPL3), blender-gen (MIT), BlenderSyntheticData (no license visible), OpenTimelineIO (Apache2), MoviePy (MIT), Blender Studio films and CondensedMovies. Studio films generally CC-BY with film-specific exceptions, not CC0. CondensedMovies official dataset terms permit commercial/research CC-BY4 while original video owners retain copyright; no blanket Hollywood footage reuse clearance. No dataset training or external code copying performed.

Next useful implementation: bind owner-cleared media IDs to probed frame counts, then execute the native edit timeline through a bounded trusted renderer with per-shot encoded-frame QC. Follow with renderer-matched camera transforms and real depth/segmentation pass verification. These are missing engineering work, not enabled by reference files.

## Video-model guide findings

Third-party guide: https://dev.to/czmilo/2026-complete-guide-top-text-to-video-models-on-huggingface-49p2
Vendor guide: https://ltx.io/blog/open-source-video-generation-models-guide
Both are leads, not benchmark evidence or authority over model licenses.

- Wan2.2 TI2V5B official Apache2 card: https://huggingface.co/Wan-AI/Wan2.2-TI2V-5B . Official recipe needs 24GB GPU with offloading; A14B recipe80GB: https://github.com/Wan-Video/Wan2.2 . First proposed controlled benchmark, not admitted.
- HunyuanVideo original: custom Tencent license, territorial restrictions and large-service condition; official 720p recipe60GB. HunyuanVideo1.5 official card requires14GB CUDA/offload/Linux: https://huggingface.co/tencent/HunyuanVideo-1.5 . Exact version license must be reviewed independently; do not transfer original terms blindly.
- I2VGen-XL: official MIT metadata conflicts with explicit research/noncommercial intended-use disclaimer. Hold commercial admission: https://huggingface.co/ali-vilab/i2vgen-xl . Requires image input; generic generated HF snippets are not validated recipes.
- LTX2.5: custom LTX2.x terms, revenue threshold and fine-tune-transfer restrictions; not Apache/MIT. https://huggingface.co/Lightricks/LTX-2.5 and https://github.com/Lightricks/LTX-2/blob/main/LICENSE-2_x . Model/text encoder/VAEs/upscaler are distinct dependencies. No proven local memory budget or benchmark.
- CogVideoX1.5-5B: custom model license requires commercial registration and extra license above1M monthly visits. https://huggingface.co/zai-org/CogVideoX1.5-5B/blob/main/LICENSE . Official card reports optimized Diffusers BF16 from10GB/INT8 from7GB on tested NVIDIA systems, with substantial speed tradeoffs. Not validated on this Mac.
- Article GGUF conversions: unofficial artifacts; no specific conversion admitted. File size is not total peak GPU/RAM requirement, and format support is backend-specific.

Architecture proposal: Kingmaker-native planning, conditioning, job scheduling, provenance and verification; explicitly approved GPU inference worker for selected model; small clients stream previews/results. Weight delivery can be chunked and cached only with correct format-aware loader and rights. Existing range-delivery support is not a diffusion backend and does not erase activation memory, computation, storage or network cost. No model integration, trained capability, production quality or near-zero operating cost is claimed.
