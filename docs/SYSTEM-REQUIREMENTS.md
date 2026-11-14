# System requirements: Kingmaker

> Notes marked **(upstream)** come from a third-party project's own docs, not from this repo.
>
> **Measured on 2026-10-09** against Kingmaker `main` @ `c2bfa4a`.

Kingmaker is a headless Mac agent. It runs its engine's server with no window, plus a menu-bar app and a CLI.

## 1. Platform support at a glance

| Platform | Kingmaker |
|---|---|
| macOS, Apple silicon | **Supported**. This is the only target |
| macOS, Intel | **Not supported**. The installer refuses anything that isn't arm64 |
| Linux x64 | Unsupported as a product. The CLI and server run (§3) but can't control apps |
| Linux arm64 | Unsupported |
| Windows x64 | **Unsupported** (the launcher is `sh`; the installer and app are macOS-only) |

## 2. macOS

### 2.1 macOS version

| Component | Minimum | Source |
|---|---|---|
| Kingmaker.app, Kingmaker Installer | 14.0 | Kingmaker: `lib/release-manifest.mjs` `MIN_MACOS`, `app/Info.plist`, `installer/Info.plist` (`LSMinimumSystemVersion`), the preflight in `installer/engine.sh`, `scripts/build-installer.sh` (`-target arm64-apple-macos14.0`); all held equal by `test/macos-minimum.test.mjs` |
| Kokoro-on-Neural-Engine voice server | 14.0 | the engine's voice server package (`.macOS(.v14)`) |
| Ollama (current releases) | 14.0 **(upstream**: 0.12.4 dropped 12 and 13) | Kingmaker: `scripts/release-parts.mjs` pins the latest `ollama/ollama` release |
| Peekaboo, the "Hands of Horus" (clicks and typing) | 15.0 **(upstream)** | Kingmaker: `scripts/release-parts.mjs:33` |

**Effective minimum:** macOS **14** for local models and voice, **15** for app control. Recommended: **macOS 15+**.
On macOS 14 the installer leaves Peekaboo out and says so (`BREW_TOOLS` `minMacos: '15.0'`); everything else installs.

### 2.2 Apple silicon memory tiers

| RAM | Kingmaker models (`lib/profile.mjs`, sizes from registry.ollama.ai on 2026-10-09) |
|---|---|
| **8 GB** | `huihui_ai/qwen3-abliterated:1.7b` 1.11 GB, `:0.6b` 0.40 GB, `qwen3.5-abliterated:2b` 1.95 GB, `qwen2.5-coder-abliterate:1.5b` 1.12 GB = **4.57 GB** |
| **16 GB** | brain becomes `qwen3-abliterated:8b` 5.03 GB, coder becomes `qwen2.5-coder-abliterate:7b` 4.68 GB, so **13.17 GB** in total (`LARGE_*_MIN_GB = 16`) |
| **24 GB** | same as 16 GB |
| **48 GB** | same as 16 GB |

- A headless server does **not** pick the engine's **lean** mode (models load on demand) on its own. Set `SOLOMON_RUNTIME_PROFILE=lean` (see §6).

### 2.3 Intel Macs
- The Kingmaker installer stops with "needs an Apple silicon Mac" (`installer/engine.sh:203`).
- The engine's voice, guardrails and Northstar runtimes are built for and checked as arm64 only.

### 2.4 Permissions (TCC)

| Permission | Kingmaker | Source |
|---|---|---|
| Microphone | required for voice; not needed with `--no-voice` | Kingmaker: `app/Info.plist` |
| Accessibility | requested at launch; needed to control apps | Kingmaker: `app/Kingmaker.swift:478`, `lib/health.mjs` |
| Screen Recording | needed by Peekaboo | Kingmaker: README §Hands; Peekaboo docs **(upstream)** |
| Automation (Apple Events) | needed to open and control apps | `NSAppleEventsUsageDescription` in `app/Info.plist`; `com.apple.security.automation.apple-events` entitlement |
| Event Synthesizing | optional (Peekaboo background typing) | **(upstream)** |

- Kingmaker keeps bundle id `com.ronininc.solghost`, so macOS privacy grants made before the rename carry over (`app/Info.plist` comment).
- In a dev launch from a terminal, the grants belong to that terminal app.

### 2.5 Signing
- **Kingmaker Release certificate (no Apple account needed).** One self-signed certificate signs every Kingmaker
  (`lib/release-identity.mjs`, made once with `node scripts/kingmaker-release-identity.mjs create`):
  - **Why:** macOS ties an owner's Microphone, Accessibility and Screen Recording grants to it, so the grants survive
    every update on every Mac, with nothing installed or trusted there.
  - **The pin:** its public fingerprint is pinned in `lib/release-identity.json`. Builds sign with it, the installer
    installs only an app signed by it, and an update runs only an installer script it signed (`engine.sh.sig`).
  - **Where the pin comes from:** during an update, from the Kingmaker already installed, never from the download.
  - **The private key:** it stays in the release Mac's keychain, with an encrypted backup in the vault
    (`~/.solomon-secure/kingmaker-release/`) and one offline copy. Never in the repo or a build.
  - **What it doesn't do:** it isn't notarization. Gatekeeper still asks each owner once ("Open Anyway").
- Kingmaker.app and Kingmaker Installer are self-signed or ad-hoc signed and **not notarized**, so another Mac needs "Open Anyway" once, or `xattr -dr com.apple.quarantine`.
- Developer ID and notarization are already wired up: `KINGMAKER_SIGN_IDENTITY`, `KINGMAKER_NOTARY_PROFILE`, `release-parts.mjs --notarize`.
- Source: Kingmaker README §Gatekeeper.

## 3. Linux: not a product, but the engine runs

- `kingmaker --version`, `kingmaker doctor` and `kingmaker start --no-voice` work on Node 24 in fork mode.
- The hands report `UNSUPPORTED: macOS control needs macOS`.
- Data still goes to `~/Library/Application Support/sol-ghost`.
- `doctor` prints a `sysctl vm.swapusage` error.
- The installer depends on macOS-only tools: `plutil`, `sw_vers`, `ioreg`, `scutil`, `shasum`, BSD `stat -f`/`tail -r`, `cp -c`, `ditto`, `codesign`, `xattr`, `osascript`, `softwareupdate`, `installer`, `open` (Kingmaker: `installer/engine.sh`).

## 4. Windows
- **Kingmaker: unsupported.**

## 5. Node, disk and external dependencies

### 5.1 Node.js

| | Minimum | Recommended | Source |
|---|---|---|---|
| Kingmaker CLI | 22 (`bin/kingmaker:21` refuses lower; the engine needs **22.13.0** for `node:sqlite`) | **24**: Kingmaker's own tests are fully green only on 24 and 26 (§8) | Kingmaker: `package.json`, the engine server's `package.json` |

Node 20 installs with `EBADENGINE` warnings and compiles. Every runtime and test then fails with `node: bad option: --experimental-sqlite`.

### 5.2 Disk

| Install | Disk | Source |
|---|---|---|
| Kingmaker Installer, Mac with < 16 GB RAM | ≈ **29 GB**: app ~4 GB + knowledge library 18,486 MB (23 corpora) + models 4.57 GB + 2 GB margin. Add the release archive parts (kept until commit), CLT, Homebrew, Ollama and SearXNG on top | Kingmaker: `installer/engine.sh:283-298`, README §Install; the engine's corpus bootstrap (`TIER1`) |
| Kingmaker Installer, 16 GB+ | ≈ **38 GB** (models 13.17 GB) | same |
| Kingmaker lean headless checkout (§6) | ≈ **1.4 GB**, measured on Linux: the engine server's `node_modules` 1.2 GB, checkout with .git 92 MB, fresh data folder 6.6 MB | measured |
| Running free-space floor | 20 GB (`SOLOMON_DISK_FLOOR_GB`, `0` = off). Below it, heavy jobs pause | the engine's disk-floor guard |

### 5.3 External dependencies

| Dependency | Needed for | Source |
|---|---|---|
| Xcode Command Line Tools, Homebrew | building and installing tools on macOS | Kingmaker: `installer/engine.sh` step 3 |
| Ollama | local models (optional with a cloud brain) | Kingmaker: `installer/engine.sh`, `install.sh` |
| `peekaboo` (`openclaw/tap/peekaboo`); fallback ghost-os (`ghostwright/ghost-os`) | app control | Kingmaker: `scripts/release-parts.mjs:33`, `install.sh` |
| `sox` (or ffmpeg) | microphone capture | Kingmaker: `lib/voice.mjs:469` |
| Python ≥ 3.10 (`python@3.12`) + SearXNG | private web search | Kingmaker: `scripts/release-parts.mjs:35`, `installer/engine.sh` step 4 |
| Google Chrome + unpacked extension (`kingmaker chrome`) | browser lane | Kingmaker: `lib/chrome.mjs` |
| Claude Code CLI (`claude`, subscription sign-in) / Codex CLI (`codex login`) / Grok Build CLI (`grok login`) | cloud brain lanes; provider API keys are stripped on purpose | Kingmaker: `lib/claude-brain.mjs`, `lib/chatgpt-brain.mjs`, `lib/grok-brain.mjs` |
| Rust/cargo | optional ArtCraft apps (`kingmaker craft install`) | Kingmaker README §ArtCraft |
| Kronos (Python ≥ 3.10, `~/.solomon/kronos/Kronos`, `pip install -r requirements.txt ccxt yfinance`) | trading forecasts relay | the engine's Kronos relay |
| Twilio account | phone lane | Kingmaker: `lib/phone.mjs` |
| Keys (optional): `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OLLAMA_API_KEY`, `SEARCH_API_KEY/PROVIDER`, `OPERATOR_API_KEY`, `PGPASSWORD`; key handoff for `crm`, `github`, `ronin-crm`, `stripe` | connectors | the engine server's `.env.example` and API-key handoff catalog |

### 5.4 Network endpoints

| Endpoint | Used by |
|---|---|
| `github.com`, `api.github.com` | release downloads (private repo: `gh auth login` or `KINGMAKER_GITHUB_TOKEN`), Ollama and Homebrew pins, corpora |
| Cloudflare Worker `kingmaker-updates` (R2 `kingmaker-releases`, KV `DEVICES`) | Kingmaker enrollment and updates (Kingmaker: `update-host/wrangler.jsonc`, `installer/engine.sh:301-327`) |
| `registry.ollama.ai` | model pulls and digest pins |
| `dumps.wikimedia.org`, `kaikki.org`, `en-word.net`, `archive.org`, `projects.blender.org`, `www.govinfo.gov`, `databank.worldbank.org`, `www.gutenberg.org` | knowledge library |
| Hugging Face | the engine's embeddings |
| Wikipedia, Bing, DuckDuckGo, Marginalia, Mojeek, Google News | web research lane (`SOLOMON_INTERNET_ACCESS=0` turns it off) |
| `api.twilio.com` | phone lane |
| your CRM's address (only once you connect one) | CRM |
| Anthropic / OpenAI / xAI (through the Claude Code, Codex and Grok Build CLIs) | cloud brain |
| local `127.0.0.1:3001` (server), `:8890` (SearXNG), `:11434` (Ollama) | local services |

## 6. Lean 8 GB headless profile (reference machine: an 8 GB M3 MacBook)

Goal: Kingmaker headless with a **cloud brain**, **no local Ollama models** and **no knowledge library**.

**Kingmaker Installer.app can't do this today.** `installer/engine.sh` is everything-or-nothing (lines 2-3): it always pulls the models, the 17 GB library and SearXNG. Use the **git checkout in fork mode** instead.

```bash
# prerequisites: Xcode CLT (git), Node 24 (brew install node@24), and one signed-in cloud CLI (claude, codex login, or grok login)
git clone https://github.com/ronininc/Kingmaker.git && cd Kingmaker
./install.sh                      # no --yes: it only checks; links ~/.local/bin/kingmaker, runs npm ci for the engine's server
kingmaker brain claude            # or: chatgpt | grok   (same as SOL_GHOST_BRAIN=claude)

export SOLOMON_HEADLESS_SERVICES=0   # no local SearXNG, no Ollama supervisor
export SOLOMON_RUNTIME_PROFILE=lean  # a headless server runs "full" unless told
export SOL_GHOST_GODS_EYE=0          # Ronin Atlas off entirely (Kingmaker: lib/profile.mjs:116,127)
export KRONOS_RESIDENT=0             # only if trading: per-pass Kronos worker (already the default at ≤ 8.5 GiB)
kingmaker start --no-voice           # this terminal is the owner console; no mic, no voice runtime
```

| Component | Lean profile | Source / switch |
|---|---|---|
| Kingmaker.app (~4 GB: knowledge runtime 2 GB, voice runtime 1 GB) | **skip**; fork mode runs the engine from source | Kingmaker: `lib/fork.mjs` |
| Ollama + models (4.57 GB) | **skip**. Optional: `huihui_ai/qwen3-abliterated:0.6b` (0.40 GB) as the reflex/classifier tier. Without Ollama, startup warns "local answers will degrade" and the server still serves | measured |
| Knowledge library (18,486 MB) | **skip** | installer-only |
| SearXNG + Python | **skip** (`SOLOMON_HEADLESS_SERVICES=0`) | whether web research still works through the public sources is **unverified** |
| Voice runtime, `sox`, Microphone grant | **skip** (`--no-voice`) | Kingmaker: `lib/cli.mjs:4,353` |
| Guardrails (NeMo) runtime | absent without an installed Kingmaker.app to borrow it from; `doctor` shows ✗, the server still starts | measured |
| Peekaboo + Accessibility/Screen Recording | only if app control is wanted (macOS 15) | §2.1 |
| Ronin Atlas | off (`SOL_GHOST_GODS_EYE=0`); its prewarm would hold ~670 MB for ~20 min | Kingmaker: `lib/profile.mjs:116`, README §Ronin Atlas |
| Kronos relay (trading only) | **~1.5 GB per pass** (Torch + MPS + Kronos, measured on the 8 GB M3 on 2026-10-05). At ≤ 8.5 GiB each pass runs in a worker that exits, so the memory goes back between passes. `KRONOS_INTERVAL` defaults to 1800 s; `KRONOS_RESIDENT=1` keeps it loaded (don't on 8 GB) | the engine's Kronos relay |
| Still required | Node 24, git, the checkout, a cloud-brain CLI, your CRM's token, if you connect a CRM; Chrome + extension if you use the browser lane | |

For installed-app background operation, `kingmaker background enable` registers `Kingmaker.app` through Apple's `SMAppService` Login Item API. Headless Host Mode holds a process-scoped `caffeinate -s` assertion for the full Kingmaker lifetime: on AC power, system sleep is inhibited while display sleep remains allowed. The supported default is a plugged-in MacBook with its lid open and built-in display asleep/off. Kingmaker does not claim to bypass normal closed-lid sleep; docks, external monitors, dummy displays, and wake-on-LAN are optional recovery arrangements, not requirements.

**Disk:** ≈ **1.4 GB** for Kingmaker (measured), compared with ≈ 29 GB for the full installer on an 8 GB Mac. Node, CLT and the cloud CLI come on top and weren't measured. Keep the 20 GB runtime floor free, or lower `SOLOMON_DISK_FLOOR_GB`: swap shares the disk.

**Memory**, measured 2026-10-09 on Linux x64 with Node 24.21: fork mode, `--no-voice`, `SOLOMON_HEADLESS_SERVICES=0`, no Ollama, sampled every 5 s.

| Phase | All Node processes (RSS) | Largest process (server) |
|---|---|---|
| Boot, TypeScript compiled on the fly (first ~105 s) | peak **709 MB** (4 processes) | 539 MB |
| Steady idle | **525 MB** | 355 MB |
| After light typed input | 544-550 MB | 375-380 MB |
| During a 7-suite test run (ACCEPTANCE, SYNTHETIC, DETERMINISM, ENDURANCE-SOAK, TENANCY, SECURITY, RECOVERY) | max **689 MB** | max 363 MB |

At idle the processes split into the server (via tsx) ~355-375 MB, `cli.mjs start` 94 MB, the tsx wrapper 61 MB and esbuild 18 MB.
- For comparison on macOS: fork mode on the 8 GB M3 measured 446 MB across 3 processes, and app mode a 16 MB launcher plus a 129 MB server (Kingmaker README §Measured).
- Linux RSS is not macOS memory footprint.
- The cloud-brain CLI (Claude Code / Codex / Grok Build) runs on top and isn't measured here. The README notes agent tooling, not Kingmaker's engine, is what fills 8 GB.

## 7. Known requirement gaps (to fix)
- ~~The plists and installer say macOS 13~~ **Fixed 2026-10-15:** every declared minimum is 14, the preflight refuses
  13 in plain words, and Peekaboo (15) is left out on 14 instead of failing the install.
- ~~An installer could ship stale or unable to update~~ **Fixed 2026-10-15:** `scripts/build-installer.sh` refuses to
  build a DMG from a manifest without packs or the Ronin Launcher, below the macOS floor, of another version than
  `package.json`, or without `KINGMAKER_ENROLL_URL`/`_CODE` (installed Macs would never update). `--draft` builds one
  anyway, named `…-DRAFT.dmg`, for a look on this Mac.
- **Still the owner's:** an Apple Developer ID (signing and notarization), and a public release to download from.
  `dist/Kingmaker-Installer-v0.2.0.dmg` is the old v0.2.0 build: rebuild it from a fresh `release-parts.mjs` manifest.
- The installer has no lean or component switches (§6).
- No GitHub release exists yet, so the installer has nothing to download.

## 8. Test matrix (2026-10-09, Linux x86_64, Docker 26.1.5, non-root, 6 GB cap)

Commit: Kingmaker `c2bfa4a`.

**Kingmaker unit tests** (`npm test` = `node --test test/*.test.mjs`, 217 tests)

| Node | Pass | Fail | Cancelled | Skip | Note |
|---|---|---|---|---|---|
| 20.20.2 | 195 | 1 | 2 | 19 | `bin/kingmaker` refuses Node < 22 (by design) |
| 22.13.0 / 22.23.3 | 196 | 0 | 2 | 19 | `test/announcements.test.mjs:122,141` cancelled every run ("Promise resolution is still pending…") |
| 24.21.0 | **198** | 0 | 0 | 19 | green |
| 26.11.1 | **198** | 0 | 0 | 19 | green |

Skipped: 12 are "macOS only" and 7 need the engine's source beside the repo. Running as root adds a false failure (`test/install-config.test.mjs:99`).

- Not tested: arm64 Linux, Windows and any macOS (no Mac runner was used for this run).

## 9. Verify on a real Mac (checklist)

- [ ] The installer end to end from a published release: parts, sha256, unpack, `codesign --verify --deep --strict`, rollback
- [ ] Gatekeeper "Open Anyway" for the unsigned installer; quarantine handling
- [ ] The real minimum macOS: install and run on 13, 14 and 15 (Ollama ≥ 14, Peekaboo 15, Kokoro-ANE 14)
- [ ] TCC prompts and persistence for `com.ronininc.solghost`: Microphone, Accessibility, Screen Recording, Automation, Event Synthesizing
- [ ] Live mic, wake word, Whisper STT, Kokoro/FluidAudio TTS on the Neural Engine, voiceprint enrollment
- [ ] Peekaboo and ghost-os clicks, including the open "approved click with another app in front → REFUSED" issue (Kingmaker README)
- [ ] Chrome extension + native host (`kingmaker chrome`); Chrome cookie import (macOS-only path)
- [ ] Siri Shortcut / `kingmaker://wake`
- [ ] Lean 8 GB profile (§6) on the 8 GB M3: memory footprint and swap with the Claude Code / Codex / Grok Build CLI running; whether web research works with `SOLOMON_HEADLESS_SERVICES=0`; a CRM read ("list my open leads")
- [ ] Kronos per-pass memory (~1.5 GB) returns to macOS between passes at ≤ 8.5 GiB
- [ ] CLT, Homebrew and Ollama installs and model digest pins via the installer
- [ ] Kingmaker under the bundled Electron-as-Node runtime (vs Node 22/24)
