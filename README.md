# Kingmaker

### Become digitally sovereign for free today.

**Your Mac, working — not just talking. A console for local AI: type, speak, or drive it from your tools. Your data never leaves.**

Kingmaker is a Mac agent with a menu-bar console ("the bar"): a chat UI with a sidebar, a model picker, an Artifacts tab, and a Skills tab — plus voice control, a CLI, an MCP surface your other tools can drive, and an iPhone bridge. Say the wake word or type; it proposes the action, you approve, and the Hands of Horus drive your real Mac apps. Every step is governed, every action is on the audit chain, and your data stays in `~/Library/Application Support/sol-ghost/runtime`.

Source-available under [PolyForm Noncommercial 1.0.0](LICENSE). Free for personal use.

---

## Quick answers

**What is Kingmaker?**
Kingmaker is a Mac agent built by Ronin Inc: a menu-bar console, voice control, CLI, and MCP surface for running AI on your own Mac. It routes work to interchangeable AI brains (local or cloud), governs every step with approval gates, and keeps your data on your machine.

**Is Kingmaker open source?**
Kingmaker is source-available under the PolyForm Noncommercial 1.0.0 license, free for personal use. The public repository is [github.com/ronininc/kingmaker](https://github.com/ronininc/kingmaker). It is not closed-source and is not distributed only through private channels.

**Where do I download Kingmaker?**
From [ronininc.org/kingmaker](https://ronininc.org/kingmaker) or the [GitHub releases page](https://github.com/ronininc/kingmaker/releases). Every release ships a signed installer; the release manifest is signature-verified before install.

**Who makes Kingmaker?**
Ronin Inc, founded by Robbie G. Kingmaker is the uncensored local engine; Solomon is the governed business product built on the same core.

---

## The system

Five surfaces, one engine:

- **The bar** — the menu-bar console. Chat UI with a sidebar of conversations, a model picker, an Artifacts tab (everything Kingmaker made), a Skills tab (mint new skills), file drops, a global hotkey, and a first-run tour. The Ronin crest in the menu bar glows when awake, pulses while speaking, and rings while listening.
- **Voice** — wake word, spoken commands, voiceprint enrollment, a voice-turn ledger. Approvals are never a click: they are your word. "Hey Siri, wake Kingmaker" works too.
- **CLI** — `kingmaker` / `sol-ghost`: full terminal control, iPhone bridge controls, model management, enrollment.
- **MCP** — any MCP client (Claude, Codex, an IDE) can drive your Mac *through* Kingmaker: ask, plan, propose — the engine governs, the Mac executes.
- **iPhone bridge** — your one iPhone, driven from your Mac, local only: see the screen, tap, type, call, iMessage. Trusting a contact or changing policy takes your Touch ID at the CLI. Outbound goes to people you know; strangers are prohibited.

## Install

**You need:** Apple silicon Mac, macOS 14+, **≈ 29 GB free** (the 18.5 GB knowledge library is a required step; Kingmaker keeps 20 GB free and pauses heavy jobs below that). Intel Macs, Windows, and Linux do not install.

1. **Download:** [Kingmaker Installer DMG](https://ronininc.org/download/kingmaker) (or from the [latest release](https://github.com/ronininc/kingmaker/releases))
2. **Open the DMG**, double-click the installer
3. **Pick your wake word**, click **Download & Install**
4. **Allow** Microphone, Accessibility, and Screen Recording when asked
5. **Say:** *"[wake word], open Notes"* → approve with "yes"

That's it. No terminal. No config files. One button.

> **First launch:** The installer isn't notarized yet. When macOS blocks it, go to **System Settings → Privacy & Security → Open Anyway**. One time only.

## What it does

- **Talk & do** — voice or text in, proposed action out, your word approves it. Hands of Horus click, type, and drive real Mac apps.
- **Make** — office files (Word, Excel, PowerPoint, PDF) rendered locally with bundled open libraries; artifacts and reels through seven creative CLIs. The local model never writes file bytes: it answers with a JSON spec, the engine renders it.
- **Know** — 106 skills in `core/skills`, and Kingmaker absorbs what it connects to: new connectors become *candidate* skills (minting never grants permission). REA reverse-engineers every connector's code before use and quarantines anything that phones home, grabs credentials, or raises privileges unprompted. The R&D floor (`kingmaker rd`) is the separate analysis engine for a shipped artifact: five modules over the free, licence-checked part of the REA toolkit. It does not download that toolkit and it does not replace the connector check. See `docs/RD-FLOOR.md`.
- **Trade** — a desk of LLM analysts (market, social, news, fundamentals) debates a ticker, bull vs bear, risk team argues, portfolio manager rates it. Research aid, not an autopilot.
- **Phone home (to you)** — Kingmaker calls *your* number with updates through your own Twilio account. It never calls anyone else.
- **Think fast, think governed** — every command gets a lane first: instant rules, then a lightweight local router (1.7B, ~155 ms), then the heavy governed brain only when needed.

---

## Skills — the capability surface

Skills are not optional extras. They are how Kingmaker's core functions happen: the files hold the methods, the router picks the skill, the brain executes. 174 ship in this repo — 106 top-level packs in `core/skills`, nested sub-skills, and 5 vendored.


**Core and everything else** (50)

`agent-self-scheduling`, `axis-projection`, `create-skill-gen`, `custom-tool-builder`, `dagster-expert`, `data-visualization`, `fastmcp`, `ffmpeg-skill`, `founder-metric-reel`, `get-available-resources`, `gh-fix-ci`, `graphite`, `gsap-core`, `gsap-scrolltrigger`, `gsap-timeline`, `humanizer`, `immersive-evidence-workspace`, `internal-comms`, `kingmaker-flagship-driver`, `kingmaker-native-internet`, `kingmaker-proof-authoring`, `kingmaker-proof-runner`, `kingmaker-repo-hygiene`, `kingmaker-voice-runtime`, `kingmaker-voice-verification`, `marketing-ideas`, `mcp-server-builder`, `movie-gen`, `native-capability-extraction`, `observability-and-instrumentation`, `offers`, `open-harness`, `parametric-cad-verify`, `playwright-cli`, `pricing`, `rea`, `referrals`, `scheduler`, `security-and-hardening`, `security-audit`, `skill-creator`, `skill-kokoro-tts-tool`, `skill-matchmaker`, `social`, `spanish-regional-localization`, `theme-factory`, `verify-claims`, `voice-operations-command`, `wholesale-real-estate`, `workflows`

**Driving real tools (CLI bridges)** (7)

`cli-anything`, `cli-anything-blender`, `cli-anything-comfyui`, `cli-anything-freecad`, `cli-anything-godot`, `cli-anything-hermes`, `cli-hub-meta-skill`

**Making: 3D, image, video, art** (31)

`aaa-modeling`, `algorithmic-art`, `blender-3d-asset-generation`, `comfyui`, `godot-prompter`, `godot-prompter/skills/2d-essentials`, `godot-prompter/skills/3d-essentials`, `godot-prompter/skills/animation-system`, `godot-prompter/skills/audio-system`, `godot-prompter/skills/camera-system`, `godot-prompter/skills/component-system`, `godot-prompter/skills/dependency-injection`, `godot-prompter/skills/event-bus`, `godot-prompter/skills/gdscript-patterns`, `godot-prompter/skills/godot-debugging`, `godot-prompter/skills/godot-mentor`, `godot-prompter/skills/godot-optimization`, `godot-prompter/skills/godot-project-setup`, `godot-prompter/skills/godot-testing`, `godot-prompter/skills/godot-ui`, `godot-prompter/skills/input-handling`, `godot-prompter/skills/math-essentials`, `godot-prompter/skills/physics-system`, `godot-prompter/skills/resource-pattern`, `godot-prompter/skills/save-load`, `godot-prompter/skills/scene-organization`, `godot-prompter/skills/state-machine`, `godot-prompter/skills/using-godot-prompter`, `site-media-fetch`, `social-media-gen`, `web-artifacts-builder`

**Building and code** (27)

`app-remake-belt`, `claude-code-skillforge`, `claude-code-skillforge/examples/auditing-seo`, `claude-code-skillforge/examples/formatting-commits`, `clone`, `clone/references/cli-anything`, `clone/references/graphify`, `clone/references/reverse-engineer-anything`, `codex-handoff`, `coding-gen`, `debugging-and-error-recovery`, `gcode`, `kingmaker-engine-verifier`, `penetration-testing`, `universal-modder`, `universal-modder/skills/asset-pipeline`, `universal-modder/skills/fal-assets`, `universal-modder/skills/game-automation`, `universal-modder/skills/game-recon`, `universal-modder/skills/game-research-websearch`, `universal-modder/skills/mashup-mods`, `universal-modder/skills/mod-any-game`, `universal-modder/skills/publish-mod`, `universal-modder/skills/reverse-engineering`, `universal-modder/skills/share-field-notes`, `universal-modder/skills/showcase-video`, `webapp-testing`

**Business, leads, and clients** (8)

`big-box-store`, `business-name-fit`, `business-profile-recon`, `clover-operations-command`, `contract-and-proposal-writer`, `emails`, `lead-magnets`, `service-business-website`

**Web and search** (9)

`ai-search-ranking`, `cloudflare-ordering-worker`, `customer-research`, `deep-research`, `kingmaker-cloudflare-release`, `local-seo-manager`, `paper-search-pro`, `research`, `website-build-standard`

**Documents and writing** (4)

`copy-editing`, `copywriting`, `office`, `wake-word-detection`

**Research and knowledge** (31)

`deepcamera`, `deepcamera/skills/analysis/cloud-provider-regression`, `deepcamera/skills/analysis/home-security-benchmark`, `deepcamera/skills/analysis/homesafe-bench`, `deepcamera/skills/analysis/smarthome-bench`, `deepcamera/skills/annotation/dataset-annotation`, `deepcamera/skills/annotation/dataset-management`, `deepcamera/skills/automation/ha-trigger`, `deepcamera/skills/automation/mqtt`, `deepcamera/skills/automation/webhook`, `deepcamera/skills/camera-providers/eufy`, `deepcamera/skills/camera-providers/reolink`, `deepcamera/skills/camera-providers/tapo`, `deepcamera/skills/channels/line`, `deepcamera/skills/channels/matrix`, `deepcamera/skills/channels/signal`, `deepcamera/skills/detection/yolo-detection-2026`, `deepcamera/skills/detection/yolo-detection-2026-coral-tpu-macos`, `deepcamera/skills/detection/yolo-detection-2026-coral-tpu-win-wsl`, `deepcamera/skills/detection/yolo-detection-2026-openvino`, `deepcamera/skills/integrations/homeassistant-bridge`, `deepcamera/skills/segmentation/sam2-segmentation`, `deepcamera/skills/streaming/go2rtc-cameras`, `deepcamera/skills/training/model-training`, `deepcamera/skills/transformation/depth-estimation`, `docker-build-strategies`, `docker-compose-patterns`, `docker-destructive-guardrails`, `docker-project-foundations`, `kingmaker-doc-author`, `kingmaker-readme-sync`

**Trading and finance** (2)

`algo-trading`, `trading-agents`

**Vendored (kingmaker-cli-hub)** (5)

`cli_hub/_matrix_data/3d-cad`, `cli_hub/_matrix_data/game-development`, `cli_hub/_matrix_data/image-design`, `cli_hub/_matrix_data/knowledge-research`, `cli_hub/_matrix_data/video-creation`

---

## By the numbers

| | |
|---|---|
| Modules in `lib/` | 146 files |
| Skills | 174 (169 in `core/skills`, 5 vendored) |
| Test files | 105 |
| MCP tools | 17 (8 core + 9 iPhone bridge) |
| Brains | Local, Claude, Grok, ChatGPT |

## The vision

*Status key: **LIVE** = shipped and working. **BUILT** = in the codebase, not yet wired into the running app. **PLANNED** = designed, not yet built. If it isn't marked LIVE, it isn't done.*

### The mission

"Service, function, power. To the people."

SaaS is dead — service is the value, software is the wrapper. Kingmaker puts production-grade AI in the hands of sovereign individuals: you choose what runs, what it does, what it's capable of. No corporation, government, or cloud provider can revoke it. A node in every house.

### The router doctrine — LIVE

Kingmaker is a **router**, not a model. The 140+ modules in `lib/` hold the methods; interchangeable AI brains (local, Claude, Grok, ChatGPT) execute. Brains never self-coordinate — every multi-step job fans out from the router and reports back up. Swap the brain, keep the governance. The routing, the skill tree, and the combined skills are the product: they push any model to its ceiling under personal compute.

### Doing more with less — LIVE

Reading (prefill) is parallel and cheap. Writing (decode) is sequential and dear. So the system reads enormously — skills, model library, governed toolbelt — and writes minimally. Capability lives *around* the model, not inside it. The metric is **outcomes-per-token**, not benchmark scores. A smaller brain with many hands beats a big brain with none.

### Governance stack — LIVE

Ten modules in `lib/`. Nothing executes outside them:

- **decision-router** — local reflex layer; simple decisions resolve without a cloud round-trip.
- **audit-chain** — every action hash-chained, tamper-evident. The ledger is the product.
- **model-pin-registry** — only pinned model hashes load. Unpinned weights refused.
- **governance-spine** — `custom` or `kingmaker-x-heretic` mode, per-session founder tap. Remakes of external tools inherit the user's guardrails or default to standard governance. Never ungoverned, never guessed.
- **ingestion-guard / egress-guard** — all input treated as untrusted at the boundary; egress allowlisted.
- **abliterate-model** — official base weights → local uncensoring → hash-pinned. Reproducible, auditable.
- **compute-governor** — resident/stream/refused load decisions graded on the *active set*, not weight bytes.
- **model-condense** — FP8 dense backbone, MXFP4 experts, sparse activation, small KV cache. Same model + device always yields the same plan.
- **runtime-degrade** — full capability first, degrade only on resource exhaustion.
- **bar-guard** — your words come first, before any framing, before any brain. Kill-switch phrases and duress handling built in.

Plus **keychain-seal**, **kill-switch**, **duress**, **universal-file-handler**.

### THE CAGE — LIVE

New capabilities enter through a 7-stage ingestion pipeline, ported from the private `kingmaker-os` runtime. Stages 1–3 (discovery, triage, scan) run autonomously. **Stage 4 is a hard gate: nothing enters the brain library without the founder's signed tap** — `decidedBy` is the literal `'robbie'`. Stage 5 re-validates the approval and recomputes the packet hash before ingesting anything; a tampered packet throws and nothing ingests. Stage 7 (fleet learning) is opt-in; customer data is hardcoded out.

### Titan — LIVE

Gated self-iteration. When the system hits something it can't reason through, it says so first — then works every avenue in the background and saves the learned pathway. Whatever puts it down, it adapts to until it gets up immune.

### The bridge — BUILT

Rotating key agreement between the user's devices. Two keys born at setup, mutual docking auth, then liveness proven with rotating call signs — **296 per cycle, 6 digits each, rotating every 24 hours**, derived from a shared seed. *"Seeded deterministic rotation, synchronized with nothing but math."* Long-term keys are never seen after setup; only call signs travel. Pure functions, no I/O, no network, no server. **Status: in the v4.0 codebase, not yet wired into the running launcher.**

### Compute — LIVE, next target in the pipeline

Live today: the governor, condense, degrade, and fast-route modules. Measured on an 8GB M3: 145MB idle, 22s cold boot, 5s warm.

Next target: **Edge0-35B-A3B** — a 35B sparse MoE (40 layers, 256 experts, 4 active per token) streaming in **under 3 GiB of active RAM** at 14.9–17.7 tok/s, Apache-2.0 licensed. Edge0's models are already in the Hugging Bay catalog; the 35B is through pipeline Stages 1–2. **Status: triaged FLAG — no published hash, first-time publisher, needs human eyes before it goes near the library.**

Honest limit, measured: **there is no memory tier above 16 GB today** — on 24–64 GB machines the extra memory sits unused. That changes when the streaming tier lands.

### Models — LIVE

Hugging Bay is Kingmaker's model source: every file recorded with its SHA-256 and license, no account needed. A download is your ask (CLI or the bar), lands in the models folder, and is kept only when size and SHA-256 match the record — anything else is deleted. `kingmaker models hb search | info | pull`.

### K-Bucks — BUILT, economy PLANNED

Proof-of-impact currency, not speculation. `UBI_GRANT_AMOUNT = 1000` KMB per verified installer identity — one identity, one grant, idempotent. The grant module does **not** mint; it emits signed grant instructions onto the audit chain, and the ledger replays them. *"The number is not a store of value — it is a ledger the machine reads to decide what an identity may access. People who do more get more."* Sybil defense is the identity layer itself. **Status: ledger and grant modules live; the trading economy is not announced until there's something to trade.**

### The heretic set — LIVE, one module untested

The sharp edges, under the same audit chain and approval gates as everything else:

- **`kingmaker-x-heretic` spine mode** — loads only pinned abliterated models; requires the founder's tap per session. No tap, no run.
- **darkweb-search** — Tor-only, fail-closed, read-only, text-only. CSAM auto-abort is a hard rule with no override path — not tap, not session, nothing. Abort in <1s, log without content, notify the founder. **Status: in the codebase, UNTESTED live — no Tor traffic has run through it.**
- **abliterate-model** — the local uncensoring pipeline (governed, founder tap, provenance hash-checked); output must be hash-pinned before the heretic spine will load it. **Status: UNTESTED live — needs a GPU box and official base weights.**
- **heretic-llm** — the uncensoring engine abliterate-model drives. External Python tool, AGPL-3.0: it runs via subprocess ONLY, never imported, never linked, never shipped in this repo.

They exist because the governed path needs a complete picture to govern against.

### OSINT — private side

Kingmaker's OSINT toolkit (LittleBrother) is a **private-side module** — it is not in this repository. Solomon gets only the public-source boundary (public IP and username lookups; no person/phone non-public lookups, no pretexting).

### Trust — LIVE

Releases ship as 8 signed archive parts + installer DMG via GitHub Releases. The manifest is signed with an **offline RSA-4096** key; the installer verifies the signature against a pinned public key (`lib/kingmaker-release-public.pem`) before touching a byte. Tampered manifest = refused, loudly. Key rotation is deliberate: rotate, re-pin, re-sign, ship an installer carrying the new pin. The launcher checks the update host (Cloudflare Worker + R2, in `update-host/`) for new releases.

### The fleet — LIVE protocol, collective early

Every Kingmaker learns on its own Mac (on by default). **Sharing** what it learned with the community is a separate switch, decided in a permissions box: share-and-get-improvements is the default, nothing leaves until the box has been shown, "keep it on this Mac" stops sharing at once, "forget what I shared" asks the collective to erase your contributions. The fleet host (`fleet-host/`, Cloudflare Worker) receives closed packets, stores them, and hands each install back its signed bundle — it never executes anything it receives. **Status: protocol and host code live; the collective is young.**

### Kingmaker vs Solomon

Kingmaker is the uncensored engine underneath — source-available, more abilities, cannot be owned or licensed, only caged by its device. Solomon is the governed business product built on the same core: it synthesizes knowledge for production only, passes legal restrictions, and ships to clients whose lawyers review the config — the review is the product.

### The fleet vision — PLANNED

The endgame is a network of independent sovereign nodes — citizens and companies running their own infrastructure, compounding knowledge through opt-in fleet learning while personal data never leaves the machine. One distribution method: high-density compute staged on sovereign vessels in international waters — ocean-water cooling, no grid dependence, no single jurisdiction. Kingmaker **mitigates** (individual sovereignty bounds the damage); Solomon **prevents** (owned infrastructure has no failure mode for the reset to trigger).

### The acceptance loop — LIVE as the bar

"It launches" is not the bar. The bar is the full loop, proven end-to-end: **read → replicate → ask → improve**. Point Kingmaker at a target, it replicates it byte-for-byte, asks improvement questions, and delivers the finished product. Every release is held to the loop before it ships.

---

## Hardware outcomes

Measured 2026-10-09 (MacBook Air M3, 8 GB). Full numbers in `catalog/`.

| Machine | Outcome |
|---|---|
| **8 GB Apple-silicon Mac** | **Works.** Cloud brains are quick (thinking happens in the cloud). Local brain: simple answers in 2–4 s; multi-step reasoning gets shaky, model reloads cost 1–5 s between jobs. |
| **16 GB Apple-silicon Mac** | **Good** (estimate). The local brain becomes the 8B model — much smarter, chat stays smooth. |
| **24–64 GB Apple-silicon Mac** | **Good, same as 16 GB** (estimate). No tier above 16 GB today — extra memory sits unused until the streaming tier lands. |

## The details

**System requirements:** [docs/SYSTEM-REQUIREMENTS.md](docs/SYSTEM-REQUIREMENTS.md)

**What Kingmaker absorbed:** [docs/ABSORBED.md](docs/ABSORBED.md) — open projects studied to improve the architecture. Nothing absorbed ships as-is; GPL projects give ideas only, never code.

**Wake word:** Picked at install, then cemented. 1-3 words. Want a different one? Reinstall.

**Data:** `~/Library/Application Support/sol-ghost/runtime` (vault, memory, connectors). Never touches another app's data.

**Voice:** Say yes to approve. Say "cancel" to stop. Verified voice (opt-in) for hands-free approval.

**Repo map:**

| Repo | Visibility | Contents |
|---|---|---|
| `ronininc/kingmaker` | Public | This repo: app, engine, releases, installer |
| `ronininc/kingmaker-os` | Private | TypeScript governance runtime (source of truth the app ports from) |
| `ronininc/kingmaker-private` | Private | Mac app |
| `ronininc/kingmaker-brain-library` | Private | Model packs per Mac class. Kingmaker reads it with a GitHub token: `KINGMAKER_LIBRARY_TOKEN`, the Keychain item `kingmaker-library`, or `gh auth login` (see docs/MAC-PROFILES.md) |

---

## License

PolyForm Noncommercial 1.0.0 — free for personal use. [Commercial licenses](COMMERCIAL-LICENSE.md) available. See [TERMS.md](TERMS.md) and [PRIVACY.md](PRIVACY.md).
