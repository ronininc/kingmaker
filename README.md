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

## v0.4.0 — Governance Stack + Reflex Layer *(shipping tonight)*

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
