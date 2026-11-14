# Build Order: Local Image + Video Generation (Mac 128 GB + DGX Spark)

**Status:** proposed, for review. Nothing here is built yet.
**Replaces:** the "Qwen-Image-2.1-Turbo-Uncensored-GGUF" build order (see §2 for why it was dropped).
**Licences checked:** 2026-10-14, against each repo's Hugging Face `cardData` and, for Qwen-Image-2.1, the LICENSE file itself. Check again on each exact file at download.

## 1. Outcome

Kingmaker makes content-pillar images, and then videos, entirely on the owner's own hardware:

- no cloud generation, no credits, no per-image cost;
- every model licensed for **commercial** output, so what the owner posts or sells is clean;
- light by default and boringly reliable. The owner never has to ask why the $10k system isn't doing its job.

Hardware:

| Machine | Role |
|---|---|
| **Mac, Apple silicon, 128 GB unified memory** | Kingmaker itself (voice, brain, CRM). Image lane through stable-diffusion.cpp on Metal. |
| **NVIDIA DGX Spark (GB10, 128 GB unified, CUDA)** | Heavy lane: video through ComfyUI, plus large image jobs when the Mac is busy. |

## 2. Why the original candidate was dropped

`AtomicChat/Qwen-Image-2.1-Turbo-Uncensored-GGUF` is **not an image model**. It is a Qwen3-VL-8B text encoder with a refusal direction removed (Apache-2.0), used as stable-diffusion.cpp's `--llm`. To draw anything it needs the denoiser `AtomicChat/Qwen-Image-2.1-Turbo-GGUF`, which is a quant of `Qwen/Qwen-Image-2.1-Turbo` under the **Qwen RESEARCH LICENSE AGREEMENT**:

- §1(i): "Non-Commercial" means research or evaluation purposes only.
- §2(b): no commercial use without a separate commercial licence from Qwen.

Other points from its own card:

- **"Uncensored" changes almost nothing.** The image pipeline has no content filter. On the card's 45 sensitive prompts, the encoder edit flipped no outcomes.
- **It has never been run on a Mac**, and the card gives no RAM guidance.

So it fails both requirements: free for commercial use, and proven on our hardware. Kingmaker's licence gate would refuse it, correctly, once §5.A adds it to the registry.

## 3. Model lineup

All rows were checked as **apache-2.0** in `cardData` unless noted otherwise.

### Images: Mac, stable-diffusion.cpp (Metal)

| Role | Model (HF repo) | Licence | Why |
|---|---|---|---|
| **Default, fast** | `Tongyi-MAI/Z-Image-Turbo` (6B) | Apache-2.0 | 8-step turbo, small footprint, strong photoreal. The everyday lane. |
| **Quality / text in the image** | `Qwen/Qwen-Image-2512` (20B) | Apache-2.0 | Best quality that can be used commercially; strongest text rendering (flyers, menus, signs). |
| **Edit an existing image** | `Qwen/Qwen-Image-Edit-2511` | Apache-2.0 | Product shots, background swaps, text fixes. |
| **Fallback** | `black-forest-labs/FLUX.2-klein-4B` | Apache-2.0 | Already in the manifest seed; lightest working option. |

### Video: Spark, ComfyUI (CUDA)

| Role | Model | Licence | Why |
|---|---|---|---|
| **Default** | `Wan-AI/Wan2.2-TI2V-5B` | Apache-2.0 | Text-or-image to 720p video; the light video lane. |
| **Quality** | `Wan-AI/Wan2.2-T2V-A14B`, `Wan-AI/Wan2.2-I2V-A14B` | Apache-2.0 | Best video that can be used commercially with no revenue or territory limits. |
| **Optional, needs sign-off** | `Lightricks/LTX-2.3` | LTX-2 Community License (`other`) | Native audio. Reported free under $10M annual revenue. Read `LICENSE-2` before enabling; the gate needs `COMMERCIAL_REVENUE_CAP` plus acknowledgement. |

### Excluded (gate must refuse)

| Model | Reason |
|---|---|
| Qwen-Image-2.1 / 2.1-Turbo (any quant, incl. AtomicChat) | Qwen Research License: non-commercial |
| `FLUX.2-klein-9B` | `flux-non-commercial-license` (**the current gate wrongly clears it**, see §5.A) |
| FLUX.1-dev, FLUX.2-dev | Non-commercial (already in the gate) |
| HunyuanVideo-1.5 | `tencent-hunyuan-community`; MAU and reported territory limits. Already refused by default. |
| Stable Diffusion 1.5 | House policy exclusion (already in the gate) |

**Companion files.** Each model needs its text encoder and VAE as separate files. Expected:

- Z-Image: Qwen3-4B encoder + FLUX.1 `ae` VAE
- Qwen-Image: Qwen2.5-VL-7B encoder + Qwen-Image VAE
- Wan 2.2: umt5-xxl encoder + Wan VAE

Confirm each against the model card at download. Each is its own reviewed, pinned artefact, the same rule the FLUX lane already follows: one pinned diffusion file does not vouch for the rest of the set.

## 4. "Run light" reliability contract

These are acceptance requirements, not suggestions.

1. **One heavy job per machine at a time.** This uses the existing heavy-slot / admission door; video renders never sit beside a model load.
2. **Load on demand, unload after.**
   - On the Mac, each sd.cpp job is its own process, so memory returns when it exits.
   - On the Spark, call ComfyUI `POST /free {"unload_models": true, "free_memory": true}` after every job.
   - Nothing stays resident between jobs unless the owner turns that on.
3. **Light model first.** Z-Image-Turbo / Wan2.2-5B by default. The 20B / A14B tiers run only when asked ("high quality", "with text") or when a job is marked final.
4. **Refuse what won't fit.** Admission returns `CONFIG_HOLD` with a reason. A job never starts and then swaps the box.
5. **Offline after install.**
   - Weights are pinned by sha256.
   - `HF_HUB_OFFLINE=1` at runtime.
   - sd.cpp and ComfyUI are pinned to exact commits, and so are the ComfyUI custom nodes.
   - No auto-update of models or nodes. Updates are a deliberate `kingmaker media update`.
6. **Honest status, in plain words.**
   - Spark off: "the video machine is offline. Turn it on or check the cable."
   - A missing weight is named, with its fix line.
   - Never a silent failure and never a placeholder image.
7. **Self-healing services.**
   - ComfyUI on the Spark runs under `systemd` with `Restart=always`.
   - The Mac tunnel (see §5.D) runs under a LaunchAgent with `KeepAlive`.
8. **Disk guard.** Generated media is rotated or archived, with an alarm before the `SOLOMON_DISK_FLOOR_GB` floor. A full disk is the most likely "it stopped working" call.
9. **`kingmaker doctor` covers it.** Each lane (image Mac, video Spark) shows READY or a fix line, using the same style as the ArtCraft rows.

## 5. Code changes in Kingmaker

### A. Licence gate: `solomon/server/src/runtime/media-weights-licence-gate.ts`

- **Bug fix (do first).** `/flux\.?2[-_ ]?klein/i` is `COMMERCIAL_CLEAR` and also matches **FLUX.2-klein-9B**, which is non-commercial on its card.
  - Add a `flux\.?2[-_ ]?klein[-_ ]?9b` → `NON_COMMERCIAL_BLOCKS` rule **before** it, and narrow the clear rule to 4B.
  - Fix the note that says "(4B/9B) — Apache-2.0".
  - Add a test that 9B is refused.
- Add `qwen[-_ ]?image[-_ ]?2(\.\d)?` (2.0 / 2.1 / Turbo) → `NON_COMMERCIAL_BLOCKS`, ordered **before** any Qwen-Image clear rule, since community repacks carry the base name. This is the same lesson as the SkyReels entry.
- Add `qwen[-_ ]?image` (original / `2512` / `Edit-2509` / `Edit-2511`) → `COMMERCIAL_CLEAR`.
- Add `z[-_ ]?image` → `COMMERCIAL_CLEAR`.
- Add `ltx[-_ ]?2` → `COMMERCIAL_REVENUE_CAP`, with the cap stated. The existing `/ltx[-_ ]?video/` rule is for the older OpenRAIL-M LTX-Video.
- **Reviewer decision:** should `uncensored|abliterated` image weights get a `MEDIA_WEIGHT_POLICY_EXCLUSIONS` entry for client-facing installs? This is policy, not licence; see §8.

### B. Manifest seed: `solomon/server/src/runtime/media-weights-manifest.ts`

Add `PENDING_PIN` entries, each with its own encoder and VAE entries, for:

- Z-Image-Turbo
- Qwen-Image-2512
- Qwen-Image-Edit-2511
- Wan2.2-TI2V-5B
- Wan2.2-T2V-A14B
- Wan2.2-I2V-A14B

The operator pins real files on install (§6). No digest is invented in the seed.

### C. sd.cpp image lane: generalise `open-gen/flux-sdcpp-lane.ts`

- Turn `FLUX_COMPONENTS` into a per-family table with these families:
  - `flux1-schnell`
  - `flux2-klein-4b`
  - `z-image-turbo`
  - `qwen-image`
  - `qwen-image-edit`
- Each family entry holds:
  - its components, with manifest id and sd.cpp flag (`--diffusion-model`, `--llm`, `--vae`, …);
  - its sampling contract: steps, cfg, sampler, `--flow-shift` / `--sigmas` where needed.
- Take the exact flags from stable-diffusion.cpp's `docs/` **at the pinned commit**. Do not copy them from blog posts.
- Keep the rule that every component passes `gatePinnedMediaWeight` before the spawn.
- The memory profile has to know about 128 GB:
  - `docs/SYSTEM-REQUIREMENTS.md` §2.2 stops at 48 GB.
  - `SDCPP_LOWRES_FLOOR = 512` and `SOLOMON_FLUX_MAX_SIDE = 1024` are 8 GB-tier values.
  - Add a ≥ 64 GB tier that generates natively at 1024–1536 and skips the lanczos upscale when it isn't needed.
- Route model choice through `media/image-generation.ts` / `route-dispatch.ts`. The default is `z-image-turbo`, with `qwen-image` on "high quality" or "text" cues, and `qwen-image-edit` when an input image is given.

### D. Remote heavy lane (Spark): `media/video-generation.ts`

- **Gap 1.** `resolveVideoCapability` checks the ComfyUI models directory **on the local disk**. With ComfyUI on the Spark, it always returns `CONFIG_HOLD: ComfyUI is not installed`.
  - Add a remote mode. When the endpoint is the Spark, capability comes from ComfyUI's own API (`GET /object_info`, `GET /models/diffusion_models`) plus a **Spark-side pin report**.
  - The pin report is `media-weights-report.json`, written by a small script on the Spark that runs the same sha256 + bytes as `computeWeightPin`.
  - The licence gate runs on that report.
- **Gap 2 (verify).** `findVideoModel` picks a video model by filename hint and does not appear to run the licence gate. The image path does, via `resolveComfyUiCapability`. Close that gap so video weights get the same manifest → pin → hash → licence chain.
- **Transport.** Keep Kingmaker's loopback doctrine. A LaunchAgent on the Mac holds an SSH (or Tailscale) tunnel that forwards `127.0.0.1:8188` to the Spark's ComfyUI.
  - ComfyUI has no auth, so on the Spark it binds to localhost only and is never exposed on the LAN.
  - `SOLOMON_COMFYUI_ENDPOINT` stays `http://127.0.0.1:8188`.
- Generated files come back over the ComfyUI `/view` API into Solomon's `generated-media` folder, so the existing "open only Solomon's own output" rule still holds.

### E. CLI

Add `kingmaker media status | install [image|video] | pin | test | update`, modelled on `kingmaker craft`:

- `install` downloads the pinned set.
- `pin` writes the operator manifest (`SOLOMON_MEDIA_WEIGHTS_MANIFEST`).
- `test` runs the smoke test in §7 and stores evidence.

### F. Proofs and tests

- Extend `tests/media-weights-licence-gate` with the klein-9B, Qwen-Image-2.x, Z-Image, Qwen-Image-2512 and LTX-2 cases.
- Extend `tests/flux-sdcpp-lane` to cover the per-family table.
- Add `tests/remote-comfy-lane`, using a fake ComfyUI + report, covering:
  - READY;
  - Spark offline → `ENDPOINT_DOWN` with plain words;
  - an unpinned remote weight → refused.

## 6. Install outline (operator)

### Mac

1. Build stable-diffusion.cpp at the pinned commit with Metal. Install to the `SOLOMON_SDCPP_BIN` path.
2. Download the image set with `hf download` into `<Kingmaker data>/models/image/…`.
3. Run `kingmaker media pin` on each reviewed file. This records sha256 + bytes in the operator manifest.
4. Set the lane env in Kingmaker's install config:
   - `SOLOMON_SDCPP_BIN`
   - `SOLOMON_MEDIA_WEIGHTS_MANIFEST`
   - the per-family weight dirs

### Spark

1. Install ComfyUI with NVIDIA's DGX Spark ComfyUI playbook. It keeps NGC PyTorch; don't let pip replace it.
2. Pin the ComfyUI commit and custom-node commits.
3. Download the Wan 2.2 set into `ComfyUI/models/…`.
4. Run the pin-report script.
5. Bind ComfyUI to `127.0.0.1` and run it under `systemd` with `Restart=always`.
6. **Watch out:** the NVIDIA playbook is built around Wan 2.1. Community reports show Wan 2.2 on Spark taking 15–30+ minutes for a 5 s clip, plus OOM crashes, when run outside ComfyUI or misconfigured. Measure before promising anything to the owner.

### Both

1. Run `kingmaker media test` (§7).
2. Run `kingmaker doctor`: both lanes must show READY.

## 7. Acceptance criteria

- [ ] Gate tests pass, and the gate **refuses**:
  - Qwen-Image-2.1-Turbo
  - the AtomicChat repack
  - FLUX.2-klein-9B
  - FLUX.1-dev
- [ ] The gate **clears** these once they are pinned:
  - Z-Image-Turbo
  - Qwen-Image-2512
  - Qwen-Image-Edit-2511
  - FLUX.2-klein-4B
  - Wan 2.2
- [ ] A voice request on the Mac ("make an image of …") produces a 1024² Z-Image-Turbo PNG. Record the measured time; don't use a promised one.
- [ ] "High quality …, with the words 'Grand Opening'" routes to Qwen-Image-2512 and the text is legible.
- [ ] A voice request for a 5 s video renders Wan2.2-TI2V-5B 720p on the Spark and the file lands in the Mac's `generated-media`. Record the measured time.
- [ ] With the Spark powered off, the owner hears the plain-words offline message with the fix. No hang, no fake file.
- [ ] Memory returns to baseline after each job on both machines (Activity Monitor / `nvidia-smi`).
- [ ] The network log shows **zero** outbound calls in the media path after install.
- [ ] Soak test: 24 h of mixed jobs (≥ 50 images, ≥ 10 videos) with no crash and no manual restart.

## 8. Open questions for the reviewer

1. **LTX-2.3:** is the business licensee under the LTX-2 revenue cap? If yes, enable it as the audio-video tier with acknowledgement. If no, leave it out.
2. **Uncensored / abliterated weights:** Kingmaker's LLM tier already uses abliterated Qwen models. For *image* weights on a client's box, should house policy exclude them? The AtomicChat card itself lists prohibited uses (sexual content involving minors; intimate images of real people without consent). The client system needs its own policy here either way.
3. **Spark link:** SSH tunnel (no new software) or Tailscale (survives IP changes)?
4. **Commercial Qwen-Image-2.1:** if Qwen ever grants a commercial licence, it can be added through the manifest + a registry entry with no code change. Until then, it stays refused.

## Sources

- AtomicChat encoder card: https://huggingface.co/AtomicChat/Qwen-Image-2.1-Turbo-Uncensored-GGUF
- AtomicChat denoiser (`license: other / qwen-research`): https://huggingface.co/AtomicChat/Qwen-Image-2.1-Turbo-GGUF
- Qwen-Image-2.1-Turbo LICENSE: https://huggingface.co/Qwen/Qwen-Image-2.1-Turbo/blob/main/LICENSE
- Qwen-Image-2512 / Edit-2511, Z-Image-Turbo, FLUX.2-klein-4B / 9B, Wan2.2, LTX-2.3, HunyuanVideo-1.5: their Hugging Face model pages (`cardData.license`, read 2026-10-14)
- NVIDIA DGX Spark ComfyUI playbook: https://build.nvidia.com/playbooks/comfyui/video-gen-workflow
- Spark Wan 2.2 community reports: https://forums.developer.nvidia.com/t/image-to-video-generation-using-the-spark-vs-pc/370077
