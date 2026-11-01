# What Kingmaker does on the machines people actually own

Measured 2026-10-09 on the only machine here: MacBook Air M3, 8 GB, macOS 26, disk 99% full. Anything marked
**estimate** was not run on that class of machine. Raw numbers are in `catalog/bench/`.

## The short answer

| Machine | Outcome for the owner |
|---|---|
| **8 GB Apple-silicon Mac** (M1/M2/M3 base) | **Works.** With the Claude or ChatGPT brain it is quick: the thinking happens in the cloud. With the local brain, simple answers come back in 2–4 s, but it gets multi-step reasoning wrong more often, and every switch between jobs (classify → answer → read the screen → code) waits 1–5 s while a model reloads. The Installer needs **≈ 29 GB free** (the 18.5 GB knowledge library is a required step); Kingmaker then keeps 20 GB free and pauses heavy jobs below that. A lean headless checkout is ≈ 1.4 GB (PR #27). |
| **16 GB Apple-silicon Mac** | **Good** (estimate). The local brain becomes the 8B model, which is much smarter. Chat stays smooth; alternating chat and coding probably still reloads a model now and then (8B brain + 7B coder ≈ 12.8 GB against ~11 GB free). |
| **24–64 GB Apple-silicon Mac** | **Good, same as 16 GB** (estimate). Kingmaker has no tier above 16 GB today, so the extra memory sits unused. Everything should stay loaded with no reloads. |
| **Intel Mac, any Windows PC, Linux box, POS terminal** | **Does not install.** The installer stops with "Kingmaker needs an Apple silicon Mac". These machines can still open the CRM in a browser. The engine's own Linux package is a separate path, proven only in a container. |

Most PCs are not Macs. On Steam's September 2026 survey the typical gaming PC has 32 GB (42%) or 16 GB (38%) of RAM and an
8 GB or 16 GB graphics card (27% each); 8 GB RAM is down to 6.5%. None of those can run Kingmaker. For a client's office PC or
POS, the honest answer today is "use the browser CRM; the brain runs on the owner's Mac."

## What was measured (8 GB M3, Ollama, Metal)

Each model: cold load, then three fixed turns; accuracy is 8 auto-graded tasks (math, a date question, intent, exact reply,
JSON extraction, a working regex function, a price sum, a one-line summary). "Resident" is what Ollama holds in memory.

| Model (what Kingmaker uses it for) | Weights | Resident | Speed (tokens/s) | First answer incl. load | Swap | Score /8 |
|---|---|---|---|---|---|---|
| qwen3-abliterated 0.6b (reflex, classifier) | Q4_K_M | 0.68 GB | 59–122 | 1.6 s | none | 5 |
| qwen3-abliterated 1.7b (brain on 8 GB) | Q4_K_M | 1.41 GB | 23–28 | 2.7 s | none | 6 |
| qwen3.5-abliterated 2b (vision, builds) | Q4_K_M | 1.60 GB | 19–24 | 5.9 s | none | 5 |
| qwen2.5-coder-abliterate 1.5b (coder on 8 GB) | Q4_K_M | 1.24 GB | 26–36 | 2.4 s | none | 6 |
| stock qwen3 0.6b / 1.7b / coder 1.5b | Q4_K_M | 0.81 / 1.66 / 1.11 GB | similar | similar | none | 5 / 6 / 6 |
| stock qwen3.5 2b | **Q8_0** + vision | 2.37 GB | 13–19 | 9.7 s | **+1.3 GB** | 5 |
| llama3.2 3b (the "small" tier pick of a windowed desktop app on the same engine) | Q4_K_M | 2.33 GB | 10–12 | 9.0 s | none | 6 (only one to get the date right) |
| qwen2.5-coder 3b | Q4_K_M | 2.09 GB | 15–17 | 4.1 s | none | 6 — **research licence, not for client work** |
| qwen3 4b (catalog: "best all-rounder at 8 GB") | Q4_K_M | 2.90 GB | **8–10** | 16–25 s | **+1.1 GB** | not scorable: it ignores "don't think", reasons out loud for minutes, 2 of 8 timed out at 300 s |
| granite-code 3b | Q4_0 | — | — | **fails** (HTTP 500: can't load with Homebrew Ollama's q8 KV cache) | — | 0 |

**All four of Kingmaker's 8 GB models loaded together** (the real workload, `bench/conc_8gb.json`): Ollama kept only **one**
resident at a time. Each switch between roles reloaded a model (1.1–5.1 s), even the "always-warm" 0.6b reflex, and swap
grew 1.2 GB over eight turns. A turn that stays on one model answers in ~1.5 s; a turn that changes role takes 3–7 s.

## Are these the best models and weights for 8 GB? (owner asked)

- **Kingmaker's own 8 GB set is right.** The abliterated Q4_K_M builds score exactly like the stock ones (abliteration cost
  nothing on these tasks), all run without swap on their own, and Q4_K_M is the right weight size at this memory.
- **The stock `qwen3.5:2b` tag is the wrong weights for an 8 GB Mac:** Ollama's default is Q8 (2.7 GB download), it swapped
  1.3 GB and was the slowest at reading prompts. Kingmaker already uses the Q4 abliterated build (1.6 GB) — keep it that way.
- **The local catalog (`kingmaker models`) overstates 8 GB.** It labels every model "8GB+", including 8B models at 5 GB. On
  this Mac anything resident above ~2.5 GB swaps; `qwen3:4b` (2.9 GB) already fell to 8–10 tok/s. Suggested: mark 4B as
  "8 GB, slow" and 7–8B as 16 GB+. The catalog's tags were "taken from the registry listings, not pulled here".
- **The catalog is a generation behind:** the registry now has Qwen 3.5 (0.8b, 2b, 4b, 9b, 27b, 35b-a3b) and Gemma 4 (e2b,
  e4b, 12b, 26b-a4b, 31b, plus QAT builds). Neither is in it. Caveat for 8 GB: Qwen 3.5's default tags are Q8 and Gemma 4
  e2b is a 4.6 GB download, so neither is an automatic upgrade on small Macs.
- **Remove** `granite-code:3b` (cannot load) and the stock `qwen3.5:2b` Q8 if disk is needed (~4.7 GB together).

## The earlier table, corrected

| Earlier claim | What the code and measurements say |
|---|---|
| "One install needs about 20 GB" | **Low.** The Installer needs ≈ 29 GB on a Mac under 16 GB (app ~4 GB + knowledge library 18.5 GB, a required phase: `installer/engine.sh:587-592` + models 4.6 GB + 2 GB margin) and ≈ 38 GB at 16 GB+ (models 13.2 GB). Corrected 2026-10-09 after PR #27; an earlier version of this file wrongly called the library optional. Without the library (a lean headless checkout) it is ≈ 1.4 GB. |
| POS / 4 GB: "below floor, install probably refuses" | No RAM floor exists in code; anything under 12 GB is "floor". The POS **does** get refused — because it is not an Apple-silicon Mac. |
| Office PC 8 GB: "20–60 s per turn" | Not measurable: Kingmaker does not install on a PC. On an 8 GB **Mac**: 1.5–7 s per local turn (measured). |
| 16 GB: "3B model, agent bundle" | Kingmaker at 16 GB uses the **8B** brain and the **7B** coder (`lib/profile.mjs`). The 3B is the desktop app's `small` tier (the engine's RAM tiers, 12 GB+), a different program. |
| 32 GB: "8B reasoning, 7B coding" | Same as 16 GB for Kingmaker (no tier above 16). The desktop app's `mid` tier starts at 24 GB, not 32. |
| 64 GB + RTX: "14B on the GPU" | Kingmaker never sees an RTX (Mac only). The desktop app's `large` tier is 48 GB+ RAM and ignores the GPU entirely. |
| Windows x64 / ARM Linux rows | Apply to the desktop app, not Kingmaker. |

Three sources of truth disagree about which model a machine gets: the engine's RAM tiers (stock qwen3 + llama3.2:3b at 12 GB),
`lib/profile.mjs` + the release manifest (abliterated set, 8B at 16 GB), and `lib/models.mjs` (owner's catalog, everything
"8GB+"). Worth making one the source.

## Feature sets: where each one runs

| Feature (CLI) | Needs | 8 GB Mac | Not a Mac |
|---|---|---|---|
| Tests (`npm test`) | Node ≥ 22 | **217/217 pass**, 142 s (measured) | not run (see VM below) |
| Brain: Claude / ChatGPT lanes (`kingmaker brain`, PR #25) | the owner's Claude Code / Codex sign-in, internet | runs; RAM-light (live brain turn **not** run this session) | — |
| Brain: local lane (`kingmaker models`) | Ollama + one model | measured above | — |
| Voice (`start`, `enroll`, `wake`, `siri`) | macOS mic, Siri Shortcuts, whisper | macOS-only by design; not exercised this session | no |
| Hands / Chrome connector (`chrome`, `scan`, `tools`) | Peekaboo, Chrome | macOS-only | no |
| MCP control surface (`kingmaker mcp`) | Node | runs | would run under Node, untested |
| ArtCraft (`craft install`) | builds 7 apps from source | disk-heavy; not run (8.8 GB free, under the 20 GB floor) | no |
| A business: tracker as context | Google Sheets read | cloud call; any machine | browser |
| A business: goal loop | long-running planner | use the Claude/ChatGPT brain at night; the local 1.7b got the date question wrong in every build and the handoff forbids a resident model overnight on 8 GB | — |
| A business: standards checks | web + inbox checks | light; any machine | — |

## Brain lanes, live on this Mac (2026-10-09, PR #25)

Kingmaker started headless (`kingmaker start --no-voice`) on a real pseudo-terminal, the same four typed turns per lane:

| Turn | `local` (local 1.7b) | `claude` (Claude Code, subscription) | `chatgpt` (Codex, ChatGPT sign-in) |
|---|---|---|---|
| "In one sentence, what is a merchant cash advance?" | no answer ("online synthesis shows one result, 72%"), opened a source in Chrome | correct, ~10 s | correct, 8 s (after the stdin fix) |
| "Today is Monday… 10 days from today?" | **Friday** (wrong), 1 s | Thursday, with the reasoning, ~18 s | Thursday, 12 s |
| "Open Safari" | proposal, waits for the owner | proposal via Kingmaker MCP, says honestly Safari is not open yet, ~10 s | **blocked**: Codex exec refuses the MCP call ("approval policy") |
| "List my open leads in my CRM" | — | reads the connected CRM (Ronin Inc CRM, local: no leads), ~11 s | **blocked**, same reason |

Found and fixed: every ChatGPT turn hung 180 s and said "ChatGPT did not answer" because `codex exec` reads stdin to EOF
and `execFile` left it open (`lib/chatgpt-brain.mjs`, regression test in `test/lanes.test.mjs`).
Open, needs the owner's decision: Codex refuses Kingmaker's MCP tools under `exec`. Verified fix on the CLI:
`-c mcp_servers.kingmaker.default_tools_approval_mode="approve"` (only the kingmaker server; the engine's own yes-gate still
holds every write). Not applied: it lets an autonomous agent call those tools without Codex's own prompt.
Also found: `kingmaker say` and anything outside the owner console/voice never reach the chosen brain (they go straight
to the engine, `routeTurn` in `lib/cli.mjs`); a business's data has to enter through that path for the brain to see it.
This branch reports Kingmaker **0.2.3**: the 0.2.4/0.2.5 voice work is not in it yet.

**VM testing.** A Linux VM (Podman, 4 GB) would not finish booting on this 8 GB Mac with swap already full; it was stopped
after 20 minutes. Kingmaker refuses non-Mac hosts anyway, and a macOS VM needs 30–60 GB of disk this Mac does not have.
To measure the other rows: borrow or rent one 16 GB and one 24 GB+ Apple-silicon Mac and run `catalog/bench/` there.
