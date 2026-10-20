# Kingmaker

**Your Mac, voice-driven. Local AI, no cloud. Your data never leaves.**

Kingmaker is a headless, voice-driven agent for Apple silicon Macs. Say the wake word, tell it what to do, approve the action — done. It runs uncensored local models, governs every step with approval gates, and your data stays on your machine.

Source-available under [PolyForm Noncommercial 1.0.0](LICENSE). Free for personal use.

---

## Quick answers

**What is Kingmaker?**
Kingmaker is a headless, voice-driven AI agent for Apple silicon Macs, built by Ronin Inc. Say the wake word, tell it what to do, approve the action — done. It runs uncensored local models, governs every step with approval gates, and your data never leaves the machine.

**Is Kingmaker open source?**
Kingmaker is source-available under the PolyForm Noncommercial 1.0.0 license, free for personal use. The public repository is [github.com/ronininc/kingmaker](https://github.com/ronininc/kingmaker). It is not closed-source and is not distributed only through private channels.

**Where do I download Kingmaker?**
From [ronininc.org/kingmaker](https://ronininc.org/kingmaker) or the [GitHub releases page](https://github.com/ronininc/kingmaker/releases). Every release ships a signed installer; the release manifest is signature-verified before install.

**Who makes Kingmaker?**
Ronin Inc, founded by Robbie G. Kingmaker is the uncensored local engine; Solomon is the governed business product built on the same core.

---

## Install (one click)

**You need:** Apple silicon Mac, macOS 14+, ~25 GB free.

1. **Download:** [Kingmaker Installer DMG](https://ronininc.org/download/kingmaker) (or from the [latest release](https://github.com/ronininc/kingmaker/releases))
2. **Open the DMG**, double-click the installer
3. **Pick your wake word**, click **Download & Install**
4. **Allow** Microphone, Accessibility, and Screen Recording when asked
5. **Say:** *"[wake word], open Notes"* → approve with "yes"

That's it. No terminal. No config files. One button.

> **First launch:** The installer isn't notarized yet. When macOS blocks it, go to **System Settings → Privacy & Security → Open Anyway**. One time only.

---

## What it does

- **Voice control** — "Hey Kingmaker, open Safari" → it proposes the action, you say yes, it clicks
- **Local models** — abliterated (uncensored) models run on-device via Ollama. No API keys, no cloud, no subscription
- **Approval gates** — nothing happens without your word. Every action is proposed first, you approve or cancel
- **Your data stays put** — `~/Library/Application Support/sol-ghost/runtime`. Never uploaded, never shared
- **Hands of Horus** — clicks, types, and drives real Mac apps (not screenshots — actual automation)

---

## Measured (8 GB M3, 2026-10-07)

| | Desktop app | Kingmaker |
|---|---|---|
| UI processes | 417 MB (GPU + renderer) | none |
| Idle memory | 434 MB | 145 MB |
| Boot to ready | — | 22s cold, 5s warm |

The engine runs headless — no window, no Dock icon, no Electron renderer. Just a menu bar icon.

---

## The vision

*Status key: **LIVE** = shipped and working. **BUILT** = in the codebase, not yet wired into the running app. **PLANNED** = designed, not yet built. If it isn't marked LIVE, it isn't done.*

### The mission

"Service, function, power. To the people."

SaaS is dead — service is the value, software is the wrapper. Kingmaker puts production-grade AI in the hands of sovereign individuals: you choose what runs, what it does, what it's capable of. No corporation, government, or cloud provider can revoke it. A node in every house.

### The router doctrine — LIVE

Kingmaker is a **router**, not a model. The 140+ modules in `lib/` hold the methods; interchangeable AI brains (local or cloud) execute. Brains never self-coordinate — every multi-step job fans out from the router and reports back up. Swap the brain, keep the governance. The routing, the skill tree, and the combined skills are the product: they push any model to its ceiling under personal compute.

### Doing more with less — LIVE

Reading (prefill) is parallel and cheap. Writing (decode) is sequential and dear. So the system reads enormously — skills, model library, governed toolbelt — and writes minimally. Capability lives *around* the model, not inside it. The metric is **outcomes-per-token**, not benchmark scores. A smaller brain with many hands beats a big brain with none.

### Governance stack — LIVE

Ten modules in `lib/`, verified in the codebase. Nothing executes outside them:

- **decision-router** — local reflex layer; simple decisions resolve without a cloud round-trip.
- **audit-chain** — every action hash-chained, tamper-evident. The ledger is the product.
- **model-pin-registry** — only pinned model hashes load. Unpinned weights refused.
- **governance-spine** — `custom` or `kingmaker-x-heretic` mode, per-session founder tap. Remakes of external tools inherit the user's guardrails or default to standard governance. Never ungoverned, never guessed.
- **ingestion-guard / egress-guard** — all input treated as untrusted at the boundary; egress allowlisted.
- **abliterate-model** — official base weights → local uncensoring → hash-pinned. Reproducible, auditable.
- **compute-governor** — resident/stream/refused load decisions graded on the *active set*, not weight bytes.
- **model-condense** — FP8 dense backbone, MXFP4 experts, sparse activation, small KV cache. Same model + device always yields the same plan.
- **runtime-degrade** — full capability first, degrade only on resource exhaustion.
- **universal-file-handler**, **keychain-seal**, **kill-switch**, **duress** — also in the tree.

### THE CAGE — LIVE

New capabilities enter through a 7-stage ingestion pipeline, ported from the private `kingmaker-os` runtime. Stages 1–3 (discovery, triage, scan) run autonomously. **Stage 4 is a hard gate: nothing enters the brain library without the founder's signed tap** — `decidedBy` is the literal `'robbie'`. Stage 5 re-validates the approval and recomputes the packet hash before ingesting anything; a tampered packet throws and nothing ingests. Stage 7 (fleet learning) is opt-in; customer data is hardcoded out. The code calls it THE CAGE, and it means it.

### The bridge — BUILT

`lib/bridge-keys.mjs`: rotating key agreement between the user's devices. Two keys born at setup, mutual docking auth, then liveness proven with rotating call signs — **296 per cycle, 6 digits each, rotating every 24 hours**, derived from a shared seed. *"Seeded deterministic rotation, synchronized with nothing but math."* Long-term keys are never seen after setup; only call signs travel. Pure functions, no I/O, no network, no server. **Status: in the v4.0 codebase, not yet wired into the running launcher.**

### Compute — LIVE, next target PLANNED

Live today: the governor, condense, and degrade modules above. Measured on an 8GB M3: 145MB idle, 22s cold boot, 5s warm.

Next target: **Edge0-35B-A3B** — a 35B sparse MoE (40 layers, 256 experts, 4 active per token) streaming in **under 3 GiB of active RAM** at 14.9–17.7 tok/s, Apache-2.0 licensed. **Status: candidate discovered (Stage 1), triaged FLAG — no published hash, first-time publisher, needs human eyes before it goes near the library.**

### K-Bucks — BUILT, economy PLANNED

Proof-of-impact currency, not speculation. `UBI_GRANT_AMOUNT = 1000` KMB per verified installer identity — one identity, one grant, idempotent. The grant module does **not** mint; it emits signed grant instructions onto the audit chain, and the ledger replays them. *"The number is not a store of value — it is a ledger the machine reads to decide what an identity may access. People who do more get more."* Sybil defense is the identity layer itself. **Status: ledger and grant modules live; the trading economy is not announced until there's something to trade.**

### The heretic set — LIVE, one module untested

The sharp edges, under the same audit chain and approval gates as everything else:

- **`kingmaker-x-heretic` spine mode** — loads only pinned abliterated models; requires the founder's tap per session. No tap, no run.
- **darkweb-search** — Tor-only, fail-closed, read-only, text-only. CSAM auto-abort is a hard rule with no override path — not tap, not session, nothing. Abort in <1s, log without content, notify the founder. **Status: in the codebase, UNTESTED live — no Tor traffic has run through it.**
- **abliterate-model** — the local uncensoring pipeline; output must be hash-pinned before the heretic spine will load it.

They exist because the governed path needs a complete picture to govern against.

### Trust — LIVE

Releases ship as 8 signed archive parts + installer DMG via GitHub Releases. The manifest is signed with an **offline RSA-4096** key; the installer verifies the signature against a pinned public key (`lib/kingmaker-release-public.pem`) before touching a byte. Tampered manifest = refused, loudly. Key rotation is deliberate: rotate, re-pin, re-sign, ship an installer carrying the new pin. The launcher checks a Cloudflare Worker + R2 bucket for updates.

### Kingmaker vs Solomon

Kingmaker is the uncensored engine underneath — source-available, more abilities, cannot be owned or licensed, only caged by its device. Solomon is the governed business product built on the same core: it synthesizes knowledge for production only, passes legal restrictions, and ships to clients whose lawyers review the config — the review is the product.

### The fleet — PLANNED

The endgame is a network of independent sovereign nodes — citizens and companies running their own infrastructure, compounding knowledge through opt-in fleet learning while personal data never leaves the machine. One distribution method: high-density compute staged on sovereign vessels in international waters — ocean-water cooling, no grid dependence, no single jurisdiction. Kingmaker **mitigates** (individual sovereignty bounds the damage); Solomon **prevents** (owned infrastructure has no failure mode for the reset to trigger).

### The acceptance loop — LIVE as the bar

"It launches" is not the bar. The bar is the full loop, proven end-to-end: **read → replicate → ask → improve**. Point Kingmaker at a target, it replicates it byte-for-byte, asks improvement questions, and delivers the finished product. Every release is held to the loop before it ships.

---

## v0.4.0 — Governance Stack + Reflex Layer *(shipped 2026-10-19)*

Nine new modules, measured:

- **Decision router** — local reflex layer routes simple decisions without cloud round-trip (<100ms on M5)
- **Audit chain** — every action hash-chained, tamper-evident
- **Model pin registry** — only pinned model hashes load; unpinned weights refused
- **Governance spine** — `custom` or `kingmaker-x-heretic` mode, per-session tap
- **Ingestion guard** — all input treated as untrusted at the boundary
- **Egress guard** — allowlisted hosts only, Tor-only mode for darkweb
- **Darkweb search** — Tor-only, read-only, per-session approval, CSAM auto-abort (no override)
- **Abliteration pipeline** — official base weights → local uncensoring → hash-pinned
- **Universal file handler** — encounters unknown file types, converts locally via system tools
- **Model ingestion pipeline** — deterministic discovery → triage → scan → your tap → ingestion → fleet distribution; Edge0 streaming MoE runs 35B-class models in ~3GB RAM
- **K-Bucks UBI** — every install carries a pre-loaded grant; one verified identity, one grant, signed and audited
- **Compute governor** — 10th governance module: resident/stream/refused load decisions graded on the active set, not weight bytes
- **Model condense** — points the compute program at the model: FP8 dense / MXFP4 experts, expert residency, KV budget
- **Runtime degrade** — try full, fall back on resource exhaustion only; lazy residency, maximum throughput

Full changelog with benchmarks ships with the release.

---

## The details

**System requirements:** [docs/SYSTEM-REQUIREMENTS.md](docs/SYSTEM-REQUIREMENTS.md)

**Wake word:** Picked at install, then cemented. 1-3 words. Want a different one? Reinstall.

**Data:** `~/Library/Application Support/sol-ghost/runtime` (vault, memory, connectors). Never touches another app's data.

**Voice:** Say yes to approve. Say "cancel" to stop. Verified voice (opt-in) for hands-free approval.

**For developers:** `./install.sh` → `kingmaker doctor` → `kingmaker start`

---

## License

Source-available under [PolyForm Noncommercial License 1.0.0](LICENSE). Free for personal use. Commercial use requires a license.

**The deal:** The code is open. The hashes are private (anti-spoofing). You can audit everything, build it yourself, and verify it does what it claims.

---

*"Service, function, power. To the people."*
