# Kingmaker on the lowest class of Mac (8 GB): layout and weight streaming

Owner's ruling, 2026-11-23/24. Written up by the Claude seat for the Codex seat. This is how Kingmaker functions on the 8 GB class. Every class above it downloads weights locally.

## The rule

1. **Local models are stored on the SD card**, not on the internal disk.
2. **Open-JEV, and anything that pulls the way JEV pulls (the Weight Hunter), sits on the laptop's internal disk.** JEV is there because it processes a large amount of information near-instantly; it must not wait on card reads.
3. **The model weights a task requires are streamed from the Brain Library on GitHub** as needed. They are not pre-downloaded to the internal disk.
4. **One median model plus Open-JEV** is the working pair on this class. The method files carry the capability; the model stays small.
5. **Every class above 8 GB downloads its weights locally.** This layout is the 8 GB class only.

The two-model pair is a rotation, not a concurrency promise. On the 8 GB class only one heavyweight model may remain resident: record the median turn, unload it, score through internal Open-JEV, then reload the median for the next turn. The 2026-11-24 concurrent proof grew swap by 1,239.3 MiB in one JEV turn and tripped the 768 MiB free-disk guard; grading that configuration as usable would be unsafe.

## Card configuration

Kingmaker uses the card store when the host reports at most 8 GiB of physical memory. Mount the card as `/Volumes/KINGMAKERSD` or set `KINGMAKER_MODEL_CARD` to its absolute mount path before starting Kingmaker. The path must be a mounted volume. A leftover directory at that path, a symlink, or a changed mount triggers an error.

The managed Ollama process uses `<card>/ollama-models` and listens on `127.0.0.1:11437`. The Brain Library assembly root for general-purpose models is `<card>/models/library`. The internal Ollama endpoint and Open-JEV's existing internal storage stay separate. Weight Hunter code and Kingmaker's state directory stay internal. A model selected by Weight Hunter uses the model's own storage lane.

If the card is missing, startup and card-backed downloads report where Kingmaker expected it. Insert the card and retry. A conflicting listener on port 11437 is reported before requests can write weights there. On machines above 8 GiB, the normal Ollama and Brain Library paths continue to apply.

## What was measured on the owner's 8 GB Mac (Mac15,3, Ollama 0.34.4)

Raw rows are in `catalog/bench/k4-8gb-*.jsonl`; the tables are in `catalog/HARDWARE_OUTCOMES.md`.

- Ollama pulls to, verifies on, and loads from the SD card (32 GB, FAT32, volume `KINGMAKERSD`).
- Cold load from the card: about 7 s for a ~1 GB model (1.6 s from the internal disk); 15 s in the paired run. After load, speed is the same as internal.
- Median model `qwen3-abliterated:1.7b` from the card: 64–71 tok/s, stays resident.
- FAT32 cannot hold a file over 4 GB. Every 8B model is excluded from such a card.
- A 3.4 GB model (`granite-code:3b`) swapped over 1 GB and froze the Mac. Not an 8 GB model.
- **Open-JEV does not load.** See the order below.

## Brain Library transport and remaining gaps

- **How a library pull lands.** `materializeLibraryModel` in `lib/brain-library-fetch.mjs` downloads the release parts, verifies each part and the assembled GGUF against its SHA-256, and requires about twice the model size in free space on the assembly volume.
- **Streaming is not live for model weights.** `docs/STREAMING-AND-EXTERNAL-DRIVES.md` says the running app does not call the streaming layer (`lib/brain-library-access.mjs`), and that the model server loads the complete model file. Today "streamed from the Brain Library" means: downloaded in parts, verified, assembled into a whole file, then loaded.
- **JEV's weights are not in the Brain Library's format.** They sit in `ronininc/weights` as 127 ten-megabyte files in the git tree (`jev/parts/`), pushed by a driver that hit GitHub's rate limit twice. The library path expects release assets with a parts manifest.
- **Two exceptions on this Mac.** `huihui_ai/qwen3-abliterated:8b` (5.0 GB) and `qwen2.5-coder-abliterate:7b` (4.7 GB) are on the internal disk. They are not JEV, and they are over the FAT32 limit, so they cannot go to this card. Owner has not ruled on them.

## Orders for the Codex seat

### 1. Rebuild Open-JEV so it loads (blocking)

- File: `open-jev-2b-merged-q4_k_m.gguf`, sha256 `3fd8cc381e77cb3bf2722757825d1f46be6b689b45516796bee72f8a1eda336f` (the 2026-11-14 build, transfer verified).
- Failure on Ollama 0.34.4, every attempt: `error loading model: check_tensor_dims: tensor 'blk.0.ssm_beta.weight' not found`.
- The registry's `qwen3.5:0.8b` loads on the same Ollama, so the runtime handles the family; this file's layout does not match it.
- `jev-housing` grades the GGUF targets "proven at weight level" only. This was the first load attempt.
- Done means: re-converted against a llama.cpp matching the serving runtime; **loads** on the owner's Mac; returns a **score** through the head (`jev-housing/head/`), not just text. The reflex-layer doc names Ollama >= 0.35.0 for the scoring endpoint.
- Publish the rebuilt file as a release asset with a parts manifest, not as git-tree files.

### 2. Make the 8 GB class layout the default on that class

- On the 8 GB class, the model store and the library assembly directory are on the card; JEV and the Weight Hunter stay internal.
- Above 8 GB, behaviour is unchanged: weights download locally.
- If the card is absent, say so plainly and do not silently fill the internal disk.

### 3. Stream required weights from the Brain Library

- Weights for the model a task needs come from the library on demand, verified by pin, onto the card.
- State in the docs what "streamed" means at each step; today it is download-then-load.

### 4. Then re-run the paired bench

- Same script and rows as `catalog/bench/k4-8gb-pair-20261124.jsonl`: median model from the card, JEV from the laptop, six alternating turns, recording what stays loaded, load time and swap.

## Not decided here

- Whether the card should be reformatted (exFAT or APFS lifts the 4 GB limit; it erases the card, which currently holds signing material).
- The 8B and 7B models on the internal disk.
- Which model is the median model once Qwen 3.5 2B/4B and Gemma 4 are measured. Tonight's only clean candidate is `qwen3-abliterated:1.7b`.
