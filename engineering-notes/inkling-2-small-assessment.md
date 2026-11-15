# Inkling 2 Small: requested brain-library candidate

Checked 2026-11-15 against the official Hugging Face model card, config and file tree. User screenshot identified `thinkingmachines/Inkling-2-Small`. Official card lists Apache-2.0. Text and image inputs, text output. This can be evaluated as a reasoning/vision component; it is not an image/video renderer.

## What was done
- Added a metadata-only, disabled candidate in `catalog/model-candidates/inkling-2-small.json`.
- Tested it against the existing admission triage: permissive license passes; missing hashes flag; oversized checkpoint rejects local tiers.
- No runtime route changed, no model admitted, no upstream source/weights cloned, no inference executed, no upstream code installed, no remote service provisioned.

## Exact blockers
Official tree reports approximately 394 GB in 24 safetensors shards; card specifies 594B total parameters, 17B active, native NVFP4 and at least 500 GB aggregated GPU VRAM. These are publisher specifications, not measurements made here. Current Mac has 8 GiB RAM and about 1.5 GiB free disk. Repository transport does not remove model execution requirements.

`lib/brain-library-fetch.mjs` supports HTTP range transport and full GGUF materialization with hash verification before Ollama create/mmap. It explicitly reports `streamedToOllama: false`; `tetherRangeFetcher` is a null stub. It does not execute arbitrary safetensors Inkling2 checkpoints from portions. `lib/model-candidate.mjs` tops out at a 48 GiB weight cap for the 64 GB tier. Neither the staged registry nor installed source inspection found Inkling registered.

The candidate file is a pending inventory record, not automatically consumed by the active model library. Publishing it as available would be false. Raw Hugging Face network access from the selected executor was policy-blocked; the official card/tree/config were read through web retrieval. No missing hashes, immutable revisions or license files were fabricated.

## Completion path
1. Acquire immutable upstream commit, exact file manifests/digests, license and any applicable NOTICE with authorized network access. A metadata-only clone is distinct from acquiring weight blobs.
2. Retain third-party ownership and license/notice files. Apache licensing permits a route to reuse; it does not make those weights Ronin-authored.
3. Select a resource-qualified inference target and test the appropriate Inkling2 runtime, or separately evaluate a compatible converted checkpoint. Do not silently use paid APIs, launch GPU instances, or download enormous artifacts.
4. Preserve the existing approval/integrity gate. Add the tested runtime route and weight portions only after exact hash, disk/memory, model compatibility and end-to-end inference tests pass.
5. Evaluate reasoning/vision quality on held-out tasks before changing defaults. Do not claim photorealistic rendering or native skill synthesis from installing a reasoning model.

Sources: https://huggingface.co/thinkingmachines/Inkling-2-Small ; https://huggingface.co/thinkingmachines/Inkling-2-Small/tree/main ; https://huggingface.co/thinkingmachines/Inkling-2-Small/blob/main/config.json
