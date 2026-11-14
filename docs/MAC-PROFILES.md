# Kingmaker on every Mac: operating profiles, packs and benchmarks

Kingmaker runs on Apple-silicon Macs from 8 GB up. Each Mac gets an **operating profile**: which local model routes,
writes, codes, sees and reasons; how much memory one model may hold; the context; how many models stay loaded at once;
whether voice runs; whether the picture engine is on. Kingmaker picks the profile from the hardware and shows it in
Customize, where the owner can override it. Each profile is also an **install pack**: the installer shows the packs like
a game's install packs, with this Mac's pack pre-selected and marked Recommended.

The models were chosen from measured numbers (`kingmaker models bench`), not from claims. The full results are in
[MAC-BENCH.md](MAC-BENCH.md), generated from `catalog/bench/*.json`.

## The profiles

Generated from `lib/mac-profiles.mjs` by `node scripts/bench-table.mjs`. `hf:` is a Hugging Face GGUF pulled through
Ollama (`hf.co/…`). Every pick is an abliterated or heretic build where one measured well; the stock Granite is in the
bench as the reference.

<!-- profiles:start -->
| Pack | Macs | Router | Writer | Coder | Vision | Reasoning | Per model | Context | At once | Voice | Pictures | Download | Basis |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **8 GB · Lean** | 8 GB standard (M1/M2/M3 base) | `hf: mradermacher/Huihui-granite-4.1-3b-abliterated-i1:i1-Q4_K_M` | `hf: mradermacher/Huihui-granite-4.1-3b-abliterated-i1:i1-Q4_K_M` | `qwen2.5-coder-abliterate:1.5b` | `qwen3.5-abliterated:2b` | `hf: mradermacher/Huihui-granite-4.1-3b-abliterated-i1:i1-Q4_K_M` | 3.3 GB | 4k | 1 | text only | off | 5.2 GB | measured |
| **16 GB · Standard** | 16 GB (and 18 GB M3 Pro) | `qwen3-abliterated:1.7b` | `qwen3-abliterated:8b` | `qwen2.5-coder-abliterate:7b` | `qwen3.5-abliterated:4b` | `qwen3-abliterated:8b` | 7.5 GB | 8k | 2 | on | off | 14.1 GB | measured |
| **24 GB · Full** | 24 GB (M2/M3/M4/M5, M4/M5 Pro) | `qwen3-abliterated:1.7b` | `qwen3-abliterated:8b` | `qwen2.5-coder-abliterate:7b` | `qwen3.5-abliterated:4b` | `hf: TrevorJS/gemma-4-12B-it-uncensored:Q4_K_M` | 8.5 GB | 8k | 2 | on | on | 21.5 GB | measured |
| **32 GB · Pro** | 32 GB (and 36 GB M3 Pro / M4 Max / M5 Max) | `qwen3-abliterated:1.7b` | `hf: mradermacher/Qwen3.8-9B-heretic-uncensored-i1:i1-Q4_K_M` | `hf: mradermacher/Qwen3-Coder-30B-A3B-Instruct-Heretic-i1:i1-IQ3_M` | `qwen3.5-abliterated:4b` | `hf: mradermacher/Qwen3.6-27B-heretic-i1:i1-IQ4_XS` | 18 GB | 32k | 3 | on | on | 38.6 GB | estimate |
| **48 GB · Studio** | 48 GB (M3 Max, M4 Pro/Max, M5 Pro/Max) | `qwen3-abliterated:1.7b` | `hf: mradermacher/Qwen3.6-27B-heretic-i1:i1-IQ4_XS` | `hf: mradermacher/Qwen3-Coder-30B-A3B-Instruct-Heretic-i1:i1-IQ3_M` | `qwen3.5-abliterated:4b` | `hf: mradermacher/Qwen3.6-27B-heretic-i1:i1-IQ4_XS` | 26 GB | 32k | 3 | on | on | 33 GB | estimate |
| **64 GB · Max** | 64 GB and up (Max, Ultra, Studio) | `qwen3-abliterated:1.7b` | `hf: mradermacher/Qwen3.6-27B-heretic-i1:i1-IQ4_XS` | `hf: mradermacher/Qwen3-Coder-30B-A3B-Instruct-Heretic-i1:i1-IQ3_M` | `gemma4:e4b` | `hf: mradermacher/Qwen3.6-27B-heretic-i1:i1-IQ4_XS` | 40 GB | 64k | 4 | on | on | 36.3 GB | estimate |

Expected writer speed by chip (decode is bound by memory bandwidth, so this scales the measured tok/s by each chip's bandwidth; an **estimate**, except the M5 Pro row, which is measured). It runs optimistic on a small, busy Mac: on 2026-10-09 the real 8 GB M3 ran the Qwen3 1.7B at 23–28 tok/s, where this scaling predicts ~59 (the M5 Pro measures 181), so expect up to half these numbers on an 8 GB Mac until its own bench says otherwise:

| Chip | GB/s | 8 GB writer (Granite 3B) | 16–24 GB writer (Qwen3 8B) |
|---|---|---|---|
| M1 | 68 | ~21 tok/s | ~12 tok/s |
| M1 Pro | 200 | ~63 tok/s | ~34 tok/s |
| M1 Max | 400 | ~126 tok/s | ~69 tok/s |
| M1 Ultra | 800 | ~253 tok/s | ~137 tok/s |
| M2 | 100 | ~32 tok/s | ~17 tok/s |
| M2 Pro | 200 | ~63 tok/s | ~34 tok/s |
| M2 Max | 400 | ~126 tok/s | ~69 tok/s |
| M2 Ultra | 800 | ~253 tok/s | ~137 tok/s |
| M3 | 100 | ~32 tok/s | ~17 tok/s |
| M3 Pro | 150 | ~47 tok/s | ~26 tok/s |
| M3 Max | 400 | ~126 tok/s | ~69 tok/s |
| M3 Ultra | 819 | ~259 tok/s | ~140 tok/s |
| M4 | 120 | ~38 tok/s | ~21 tok/s |
| M4 Pro | 273 | ~86 tok/s | ~47 tok/s |
| M4 Max | 546 | ~173 tok/s | ~94 tok/s |
| M5 | 153 | ~48 tok/s | ~26 tok/s |
| M5 Pro | 307 | ~97 tok/s | ~53 tok/s (measured) |
| M5 Max | 614 | ~194 tok/s | ~105 tok/s |
<!-- profiles:end -->

What "Basis" means:
- **measured**: the model was benchmarked on this class or in its simulation, and fits the budget.
- **estimate**: no Mac of that size was available. The picks are models measured on the 24 GB M5 Pro, sized by their
  measured footprint (the 27B/30B/31B files are byte-identical to the `hf.co` builds named, SHA-256 checked). Run
  `kingmaker models bench` on such a Mac to confirm them.

## How Kingmaker picks the profile

- `lib/mac-profiles.mjs` reads `sysctl hw.memsize` and `machdep.cpu.brand_string`, both present on every stock Mac.
- The class is the largest one at or under the RAM: 18 GB → 16, 36 GB → 32, 96–192 GB → 64.
- The chip sets the expected speed. Generation is bound by memory bandwidth, so a measured tok/s scales by each chip's
  bandwidth.
- **Override:**
  - Customize → Functions → **Mac profile** (Auto, 8 … 64). The live profile is written under it.
  - Or from the CLI: `kingmaker models profile <auto|8|16|24|32|48|64>`.
  - Both write `macProfile.profile` in `calibration.json`.
  - A class above this Mac's own is allowed; it's flagged "may swap".
- **What the profile changes at runtime:**
  - **The write lane's default writer** (`writerModel`, `lib/fast-route.mjs`). It's the profile's writer when nothing
    is pinned in the bar's picker: the 8B on 16 GB and up, Granite 3B on 8 GB, where the 8B's 5 GB would swap.
  - **The router's default** (`defaultRouter`, and Customize → Router). On 8 GB the router is the writer itself:
    with one model loaded at a time, a separate router would unload the writer on every turn (1–5 s per switch,
    measured on the real 8 GB M3).
  - **The writer's default context** (Customize → Writer → Context).
  - **The router's context is fixed at 2k** (`ROUTER_CONTEXT`). Without it Ollama gave the router a 16k context and
    the 0.6B held 2.4 GB for 30 minutes.
  - **Text-only mode on 8 GB** (Customize → Voice → Auto, `lib/ring.mjs`).

## Tool calls that small models get right

`lib/tool-call.mjs` makes every tool call two short calls, each held to a JSON schema with Ollama's structured outputs
(`format`):
1. **Pick:** `{"tool": <one of the tool names, or "none">}`.
2. **Arguments:** the chosen tool's own parameter schema.

The arguments are then checked against that schema (`fitsSchema`), and a reply that doesn't fit is "none": a wrong
guess does nothing. The router uses the same approach (`LANE_SCHEMA`).

Measured on 18 cases (single tool, multi-argument, two chained tools, refusing when no tool fits), two-step against
Ollama's native `tools`:

| Model | Two-step | Native `tools` |
|---|---|---|
| Qwen2.5-Coder 7B abliterated | **94%** | 28% |
| Granite 4.1 3B abliterated | **89%** | 78% |
| Ministral 3 3B | **83%** | 72% |
| Qwen3 8B abliterated | **100%** | 89% |

One finding from Ollama 0.31: `format` is **not enforced for every model**. qwen3.5 on Ollama's own engine wraps its
answer in a code fence. So the reply's first JSON object is read and then checked against the schema; the schema
check, not the decoder, is the gate.

## The 8 GB standard (M1/M2/M3 base, 8 GB)

- **One model, loaded alone:** Granite 4.1 3B abliterated (`hf.co/mradermacher/Huihui-granite-4.1-3b-abliterated-i1-GGUF:i1-Q4_K_M`,
  Apache-2.0). It routes, picks tools, fills arguments, writes and reasons.
  - Holds **2.5 GB** at a 4k context.
  - 16/18 tool cases, 11/12 routes, 3/3 writing.
  - The coder (Qwen2.5-Coder 1.5B, 1.1 GB) and vision (Qwen3.5 2B abliterated, 3.0 GB) load only when asked for,
    replacing it.
- **Budget: 3.3 GB per model.** This leaves room for macOS, WindowServer, Kingmaker and its engine (~0.6 GB),
  and a browser.
  - The earlier real 8 GB M3 run (catalog/HARDWARE_OUTCOMES.md) saw swap above ~2.5 GB with the full stack and a
    99%-full disk.
  - 3.3 GB assumes text-only mode and Ronin Atlas off. The real M3 bench decides.
- **Every 4B tried is over budget.** At a 4k context: Qwen3.5 4B 3.7 GB, the Qwen3.5 4B heretic 5.3 GB, Ministral 3
  3B 3.6 GB.
- **Context 4k, one model at a time, one request at a time, text only, no picture engine.**
- **Ollama on an 8 GB Mac** reports 4.8 GiB available to the GPU. The real M3's own Ollama log says the same, and the
  simulation reproduces it.

## Install a pack

**In the installer:** the launcher shows every pack as a card with its download size, voice or text only, pictures on
or off, and how many models run at once. This Mac's pack is pre-selected and marked **Recommended**; a pack above this
Mac's memory says **May swap**. Kingmaker itself is still all or nothing. The pack picks only the models: the installer
pulls them (`engine.sh --pack <class>`) and records the pack as the Mac profile.

**From the command line,** one command per pack (it checks free disk first and keeps 5 GB free):

```
kingmaker models packs                  # every pack, this Mac's marked ★
kingmaker models setup                  # this Mac's recommended pack
kingmaker models setup --pack 8         # the 8 GB Lean pack
kingmaker models setup --pack 16        # the 16 GB Standard pack (also 18 GB M3 Pro)
kingmaker models setup --pack 16 --dry-run   # what it would download, nothing more
```

**The packs smaller than this 24 GB M5 Pro:**

| Pack | For | Downloads | Then |
|---|---|---|---|
| **8 GB · Lean** | M1/M2/M3 with 8 GB | Granite 4.1 3B abliterated (2.1 GB), Qwen2.5-Coder 1.5B (1.1 GB), Qwen3.5 2B abliterated (2.0 GB): ~5.2 GB | Voice stays off by default (Customize → Voice). Close other heavy apps. If you run Ollama yourself, `OLLAMA_MAX_LOADED_MODELS=1 OLLAMA_NUM_PARALLEL=1` |
| **16 GB · Standard** | 16 GB Macs, the 18 GB M3 Pro | Qwen3 1.7B, Qwen3 8B, Qwen2.5-Coder 7B, Qwen3.5 4B abliterated (vision): ~14 GB | Voice on. Pictures off by default (the image engine wants ~7.5 GB free) |

Models the engine's roles already use (the 0.6B and 1.7B) are not downloaded twice.

## Benchmarks

```
kingmaker models bench                  # this Mac's pack candidates
kingmaker models bench --pull           # download missing candidates first (disk checked, 5 GB kept free)
kingmaker models bench --as 8           # simulate an 8 GB Mac on a bigger one (software limits only)
kingmaker models bench --set 8-wide     # every 8 GB candidate
kingmaker models bench --set 16         # a class without a candidate list benches its own pack
kingmaker models bench --models a,b     # these Ollama tags
node scripts/bench-table.mjs            # regenerate MAC-BENCH.md and the profile table above
```

What it measures, per model, through Ollama's HTTP API (`lib/model-bench.mjs`), using only Node and stock macOS tools
(`sysctl`, `ps`, `footprint`, `lsof`, `pmset`):
- **Load time:** cold, with the model unloaded first.
- **Speed:** prompt and generation tok/s.
- **Memory:**
  - **Holds:** the runner's RSS after every suite has run.
  - **Peak:** RSS including the load moment.
  - The `phys_footprint` peak.
  - Ollama's resident and on-GPU sizes.
  - Swap growth.
  - The lowest `kern.memorystatus_level`.
  - Only runners belonging to the Ollama server under test are counted.
- **Tool calling:** the 18 cases, both ways.
- **Routing:** 12 commands the rules can't place.
- **Writing:** 3 tasks with checkable limits.
- **Heat:** one model at a time with a cool-down between models (30 s by default). It waits whenever
  `pmset -g therm` reports a warning or a CPU speed limit, and records the thermal state before and after each model.

Results go to `catalog/bench/<chip>-<ram>gb.json`. Inside the app (not a checkout), they go to
`Bench` in Kingmaker's one folder (lib/kingmaker-home.mjs), never the Desktop or the signed bundle.

**The 8 GB simulation is honest only as far as software reaches.**
- What it reproduces: a second Ollama server with an 8 GB Mac's GPU budget (`OLLAMA_GPU_OVERHEAD` cuts it to 5.3 GiB,
  and Ollama then reports 4.8 GiB available, exactly as the real M3 does), one model loaded, one request at a time,
  and a 4k context.
- What it can't do: take away the bigger Mac's RAM or memory bandwidth. Speeds are the M5 Pro's, and swap can only be
  judged on a real 8 GB Mac.

## Run it on the 8 GB M3

The real 8 GB answer must come from the 8 GB M3 itself. After the next Kingmaker install, which carries
`lib/model-bench.mjs`, open Terminal on that Mac and run one command. It needs no Homebrew: it uses Kingmaker's own
runtime.

```
ELECTRON_RUN_AS_NODE=1 /Applications/Kingmaker.app/Contents/MacOS/Solomon /Applications/Kingmaker.app/Contents/Resources/sol-ghost/lib/cli.mjs models bench --pull
```

- It downloads what the 8 GB set is missing: Granite 4.1 3B, abliterated and stock, ~4.2 GB. It only downloads while
  5 GB stays free afterwards.
- It then benchmarks six models, a few minutes each.
- It writes `m3-8gb.json` to `Bench` in Kingmaker's folder (the command prints the path). Send that file back (AirDrop is fine), put it in
  `catalog/bench/`, run `node scripts/bench-table.mjs`, and the 8 GB profile is confirmed or corrected from it.
- Quit other apps first. On that Mac **swap growth is a real measurement**: any model whose swap grows more than 256 MB
  fails the run.

## Testing the smaller packs in a VM

`scripts/vm-profile-test.sh <8|16>` runs a pack inside a macOS VM capped at that memory, using Apple Virtualization
through tart (Developer ID signed and notarized).
- **The VM:** the stock "vanilla" macOS image (no Homebrew), 8 CPU cores, this checkout and this Mac's Ollama model
  store shared in **read-only**, so the owner's models can't be changed or pruned.
- **Inside it:** the script installs the official Node and Ollama builds in the VM user's home, then runs
  `models setup --pack <class> --dry-run` and `models bench --set <class>`. Results land in `catalog/bench/vm/`.
- **Same Ollama as this Mac:** the VM gets this Mac's Ollama version (`KM_VM_OLLAMA` overrides it). A newer one
  would migrate the shared store's layout, which the read-only share refuses, and a test must never rewrite the
  owner's store.
- **Login:** the image's default admin/admin installs a key of the script's own once (`~/.ssh/kingmaker_vm_ed25519`),
  and only that key is offered afterwards.

What a VM can't prove:
- **Speed and Metal.** The GPU is Apple's paravirtualized Metal device, so tok/s and load times are not a real M1–M4's.
- **Voice.** There's no Neural Engine passthrough, so Kokoro on the ANE and the voice runtime can't be tested.
- **Swap.** The VM swaps to its own disk, so a swap or freeze verdict holds only for that VM.

The VM does prove the install plan, the profile detection at that memory size, and whether the pack's models load
and answer within that memory.

**What the VMs showed (2026-10-15, M5 Pro host, Ollama 0.31.1 in both; `catalog/bench/vm/`):**
- **The packs install and their models answer.** Every text model in the 8 and 16 GB packs loaded fully onto the VM's
  GPU and answered tool, routing and writing cases at about the same scores as on the host (Granite 4.1 3B: tools 89%,
  route 100%, write 100%; Qwen3 8B: tools 100%). Speeds are 5–10 tok/s, the paravirtualized GPU's, not a real Mac's.
- **The vision models can't be judged in a VM.** Qwen3.5 2B and 4B (the vision role) produced nothing. Their image
  encoder fails on the VM's Metal device ("buffer is nil", thousands of times in `km-*.ollama.log`), while on the host
  the same 2B runs at 130 tok/s.
- **"Holds" is inflated in a VM.** Every model's resident memory was about 1.7× its GPU size. On the host it is about
  0.95×. The VM counts the weights twice (the shared folder's file pages and the virtual GPU's copy). So "holds 10.15
  GB > 7.5 GB" for Qwen3 8B, and 8.78 GB for Qwen2.5-Coder 7B, are the VM's, not a 16 GB Mac's: on the host the 8B
  holds 7.29 GB at twice the context. The memory verdict for the 16 GB pack needs a real 16 GB Mac.

## The Brain Library (public)

[github.com/ronininc/kingmaker-brain-library](https://github.com/ronininc/kingmaker-brain-library) publishes everything
here:
- **`library.json`**, with its schema (`kingmaker.brain-library/1`): all 52 Apple-silicon Mac configurations (chip ×
  RAM, M1 to M5 Max and the Ultras), the class each gets, the picks per class, and every model measured, with its
  source, licence and results.
- **`bench/`**: every Mac's results.
- **The weights:** each redistributable pick as a release, its GGUF split into parts under 2 GB. Each part and the
  joined file are SHA-256 checked, and the release carries the Ollama Modelfile the model was measured with.

Models without a licence on their card stay pointers: listed and measured, but their weights are not republished.

```
node scripts/brain-library.mjs build ~/Projects/kingmaker-brain-library    # regenerate it from this checkout
node scripts/brain-library.mjs weights ~/Projects/kingmaker-brain-library  # publish picks not released yet
kingmaker models library                     # this Mac's picks from the published library
kingmaker models library pull <tag>          # a pick from the library: parts checked, joined, loaded into Ollama
kingmaker models library submit <bench.json> --yes   # this Mac's results, as a pull request to the library
```

Every Mac that runs the bench and submits its results turns its class from **estimate** into **measured**. The
30-day churn finds new builds, a benchmark decides whether one replaces a pick, and a replaced pick's release is kept
and marked retired.

## Candidate models checked (2026-10-15)

The owner pasted Gemini's suggestions. Each was checked against the Ollama registry, Hugging Face and Hugging Bay, then
benchmarked:

| Suggested | Exists? | Measured (8 GB simulation) |
|---|---|---|
| Qwen 3.5 4B Instruct | yes: `qwen3.5:4b` (stock, vision), `huihui_ai/qwen3.5-abliterated:4b`, the Hugging Bay heretic GGUF | holds 3.7 / 3.7 / 5.3 GB: over the 8 GB budget; the abliterated 4B is the 16/24 GB vision model |
| Qwen 3.5 Coder 3B | **no**: neither Ollama nor Hugging Face has it (Qwen2.5-Coder 3B exists, under a research licence) | — |
| Gemma 4 E4B | yes: `gemma4:e4b` (6.6 GB download, vision) and a heretic GGUF without a vision projector | too large for 8 GB; see the 24 GB results |
| Gemma 3 4B | yes: `gemma3:4b`; huihui's abliterated build is fp16 (8.6 GB) | see MAC-BENCH.md |
| IBM Granite 4.1 3B Instruct | yes: `granite4.1:3b`, plus huihui-ai's abliterated build (Hugging Face, Hugging Bay) | **the 8 GB pick**: 2.5 GB, 89% tools, 92% routing, 100% writing |
| Ministral 3 3B Instruct | yes: `ministral-3:3b`, plus an abliterated GGUF | holds 3.6 GB: over budget; 83% tools |
| Qwen3 0.6B / 1.7B (routers) | yes, abliterated | 0.6B: 61% tools, 67% routing (too weak to decide alone); 1.7B: 83% / 75% (the 16 GB+ router) |
