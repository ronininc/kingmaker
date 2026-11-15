# Bounded demonstration-to-Blender workflow

`lib/blender-workflow.mjs` compiles a supplied transcript through an injected reasoning adapter into reviewed **data operations**, never source Python. Supported operations: primitive creation, transforms, material values, bevels, camera, area lights, and self-contained GLB import. Input provenance and rights basis are required. Remote tutorials are evidence, not authorization or code.

`executeWorkflow` executes the trusted bundled Python interpreter in Blender background mode, with auto-execution disabled. Each run gets a new directory and editable `project.blend`, bounded `state.json`, hashes and actual CPU/wall/RSS/I/O measurements. An existing locally trusted checkpoint may be reopened for subsequent operations. Do not supply arbitrary untrusted `.blend` files: disabling scripts is not a full parser sandbox. There is no overwritten original project.

GLB inputs require the existing rights/size/hash manifest, must have no external buffer/image URIs or required extensions, and are copied from verified bytes into the execution directory. Attribution is retained. License metadata is a claim requiring independent source review, not a legal certification.

Use `render:false` while assembling, then reopen the checkpoint with `render:true` once ready. No viewport is displayed. AUTO selects available Cycles GPU backend or CPU fallback; GPU utilization is explicitly **not measured**. Wall/CPU/RSS and OS block counters are actual process measurements, not estimates of model reasoning or whole-system consumption. Rendering currently deliberately uses a small 256-square 16-sample validation image, not production quality.

## Verification

`node --test test/blender-workflow.test.mjs`

`node scripts/prove-blender-workflow.mjs /absolute/path/to/existing/proof-directory`

The proof uses the already-installed local qwen3:1.7b model to compile an original synthetic transcript, saves without rendering, reopens and modifies the actual project, then renders. It is not evidence of watching a real tutorial or producing photorealism.

## Remaining gaps

- Video/audio recording and automatic observation-to-transcript/action extraction.
- Broad Blender task vocabulary, arbitrary asset authoring and demonstrated quality transfer.
- Authenticated on-demand retrieval/version verification of the Blender runtime; current caller supplies installed Blender explicitly. Repository streaming does not supply free CPU/GPU/RAM.
- Persistent project routing through the user-facing Kingmaker chat, clickable workflow chart and finished video delivery.
- Production-quality lighting/material/animation/render settings and independently validated photorealism.

This candidate is additive and not deployed to the installed app. Its own module does not mint or publish a global skill.

## Actual local verification on 2026-11-15

The local qwen3:1.7b model returned the expected five validated operations from the original fixture. The subsequent Blender4.2.3 invocation failed with SIGSEGV during Metal backend startup, before Python ran. No editable checkpoint or render was produced by this proof. Retries were paused. The 25 focused module/asset/film tests passed; they are not an end-to-end Blender pass. Existing user projects were not opened or modified.

### Bounded rerun after disk capacity restored

After authorized cache cleanup restored 3.2GiB free, one preparation attempt succeeded, followed by one CPU reopen/transform/render. The original local-Qwen transcript produced a saved editable project (885,764 bytes); reopening preserved its bevel/material and applied the requested Panel transform. The final project was 859,020 bytes; the 256×256 PNG was 52,457 bytes and visually inspected as a plain bevelled blue panel, **not photorealistic asset quality**.

Measured preparation script wall time: 0.00274s, peak process RSS198,180,864 bytes. Reopen/render/save script wall time0.3853s, CPU user0.4347s/system0.0370s, peak RSS355,303,424 bytes; whole subprocess wall time0.851s. CPU mode was explicitly selected, GPU utilization not measured. OS block counters were zero (not evidence of zero I/O); artifact byte counts above record real writes. Earlier native Metal startup crash remains intermittent/unresolved; these two successes do not establish a fix.

Evidence is in the sibling `demo-workflow-proof/prepared-proof.json` and `rendered-proof.json` files. This validates the bounded synthetic-transcript pipeline, not automatic tutorial watching, general workflow learning, or production aesthetic quality.
