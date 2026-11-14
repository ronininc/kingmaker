# Kingmaker repo — SEO/AEO per-function map (DRAFT for Robbie's review, 2026-10-21)

Rule: every PUBLIC function gets (1) a target query set, (2) an answer-first AEO block
(2–4 sentences, facts only), (3) three surfaces: a README anchor, a docs/functions page,
and an llms.txt index line. Status labels follow README law: LIVE / BUILT / PLANNED —
only LIVE functions get present-tense capability answers. The private-side stack gets
NO per-function pages (total count only, as always).

Repo-level (from the previous draft, unchanged):
- About: "Kingmaker is a free, local AI agent for Mac (Apple silicon): voice-controlled,
  runs uncensored open-weight models 100% on your machine, drives your real apps and
  Chrome, and asks before anything that sends, spends or installs. Source-available · by Ronin Inc"
- Homepage: https://ronininc.org/kingmaker
- Topics (FINAL, 20/20 slots — Robbie's wide net, 2026-10-21): ai-agent, ai-agents,
  local-ai, local-llm, llm, macos, apple-silicon, voice-assistant, ollama, llama-cpp,
  gguf, qwen, uncensored-ai, abliterated, mcp, api, computer-use, offline-ai,
  penetration-testing, deterministic-ai. Applied via repo-edit-kingmaker.sh (gh repo edit).

---

## 1. Voice control — LIVE
Queries: "voice controlled AI agent for Mac" · "can I control my Mac by voice with AI" · "AI assistant with wake word for macOS"
AEO: Kingmaker takes orders by voice with a wake word you choose. It listens, proposes the action, and approvals are spoken — your word is the approval, never a click. Voiceprint enrollment and a voice-turn ledger keep a record of every spoken approval.

## 2. Driving real Mac apps — LIVE
Queries: "AI agent that controls Mac apps" · "AI that clicks and types in my apps" · "computer use agent for Mac"
AEO: Kingmaker opens and drives your real Mac apps — Notes, Mail, Finder, WhatsApp — through macOS accessibility. It does the steps itself and stops on every click that commits something until you say yes. This is computer use on your own machine, not instructions for you to follow.

## 3. Signed-in Chrome work — LIVE
Queries: "AI agent that works in my logged-in Chrome" · "AI that uses my web apps without API keys"
AEO: Kingmaker works inside the Chrome you are already signed into, so it can operate your web apps with no API key, no new login, and no password handed to anyone. Web work happens under the same approval gates as everything else it does.

## 4. Uncensored local models — LIVE
Queries: "uncensored AI that runs locally on Mac" · "abliterated LLM Mac" · "local AI without refusals"
AEO: Kingmaker runs open-weight, abliterated models on your Mac's own chip — the models' built-in refusals are removed, and the rules that matter are enforced by the governed runtime instead. The gate sits on actions (send, spend, install), not on ideas. Models are sized to your Mac; 24 GB of memory unlocks 35B-class models.

## 5. Governed approvals and audit chain — LIVE
Queries: "AI agent with approval gates" · "AI agent that asks before sending or spending" · "auditable AI agent"
AEO: Every action Kingmaker takes that sends, spends, or installs waits for your yes, and every step is written to a hash-chained audit log. Approvals can be spoken. Saying "stop approving" halts every automatic approval at once, and a duress password you choose wipes its keys and data.

## 6. Skills system — LIVE
Queries: "AI agent with skills" · "how does Kingmaker learn new abilities" · "extensible local AI agent"
AEO: Skills are how Kingmaker's core functions happen: the files hold the methods, the router picks the skill, the brain executes. 174 skills ship in the public repository — websites, research, video, 3D, business operations, and more. New connectors Kingmaker absorbs become candidate skills; minting a skill never grants it permission.

## 7. REA and the Cage (tool inspection) — LIVE
Queries: "does Kingmaker vet third-party tools" · "AI agent that inspects code before running it"
AEO: Before any outside tool or connector runs, REA — Kingmaker's code inspector — reverse-engineers it, and the Cage quarantines anything that phones home, grabs credentials, or raises privileges unprompted. Tools are absorbed only after inspection and your approval.

## 8. Knowledge library — LIVE
Queries: "local AI with offline knowledge library" · "AI agent that searches my own library"
AEO: Kingmaker carries a knowledge library of about 18 GB on your disk and searches it in place, with no connection. Since v0.4.2 the library is your choice: stream it as needed or download it whole, and change your mind later in Settings.

## 9. Private research — LIVE
Queries: "AI agent with private web search" · "local AI that researches without tracking"
AEO: Kingmaker researches with its own private search rather than a cloud assistant's tracked search. Combined with the on-disk library, most questions are answered from your machine first.

## 10. Creative studio — LIVE
Queries: "AI agent that uses Blender" · "local AI for video and 3D" · "AI that makes reels on Mac"
AEO: A studio is on board: images and ad videos made on your Mac, plus open-source creative apps it drives through their own command lines — Blender, Godot, ComfyUI, ffmpeg among them. The local model answers with a JSON spec; the engine renders the files, so output is deterministic.

## 11. Office documents — LIVE
Queries: "AI that makes Word Excel PowerPoint files locally" · "local AI document generation"
AEO: Kingmaker makes office files — Word, Excel, PowerPoint, PDF — rendered locally with bundled open libraries. The model never writes file bytes directly; it specifies the document and the engine renders it.

## 12. Market research desk — LIVE
Queries: "AI stock research team" · "LLM analysts debate a ticker" · "AI market research that does not trade"
AEO: Kingmaker's market desk is a team of AI analysts — market, social, news, fundamentals — that debates a ticker bull versus bear, argues risk, and has a portfolio manager rate it. It is a research aid only: it never trades.

## 13. Phone calls to the owner — LIVE
Queries: "AI agent that calls me with updates" · "can my AI agent phone me"
AEO: Kingmaker can call your number with updates through your own Twilio account. It never calls anyone else.

## 14. The router (doing more with less) — LIVE
Queries: "how does Kingmaker route tasks" · "local AI router" · "cheap local AI inference routing"
AEO: Kingmaker is a router, not a model. Every command gets a lane first — instant rules, then a lightweight local router (1.7B, ~155 ms), then the heavy governed brain only when needed. Reading is parallel and cheap; writing is sequential and dear, so capability lives around the model, not inside it.

## 15. Plugging in cloud brains — LIVE
Queries: "use Claude or ChatGPT inside a local agent" · "bring your own AI subscription agent"
AEO: Prefer a cloud brain? Plug in Claude, ChatGPT or Grok with your own sign-in, fenced to Kingmaker's tools. They propose; the engine governs; you approve. Swap the brain, keep the governance.

## 16. MCP surface — LIVE
Queries: "MCP server that controls a Mac" · "let Claude Code use my Mac tools" · "Kingmaker MCP"
AEO: Any MCP client — Claude, Codex, an IDE — can drive your Mac through Kingmaker: ask, plan, propose. The engine governs every step and the Mac executes only after your approval. 16 MCP tools ship: 7 core and 9 for the iPhone bridge.

## 17. iPhone bridge and Kingmaker Phone — LIVE
Queries: "control my iPhone from my Mac with AI" · "talk to my Mac from my phone" · "AI agent phone bridge"
AEO: Pair your iPhone with a QR code and a six-digit code and talk to your Mac from anywhere — home Wi-Fi, or anywhere at all once you add Tailscale. Send it a photo and it reads it, saves it, or puts it to work. The bridge is local only; trusting a contact or changing policy takes your Touch ID, and outbound messages go to people you know — strangers are prohibited.

## 18. Updates — LIVE
Queries: "how does Kingmaker update itself" · "signed updates local AI"
AEO: Updates are signed and checked file by file against a signed manifest (release signing key fingerprint A689 DD94 00E8 F7B2 563C 1C88 6B20 BA39 4CA6 68E4). Kingmaker installs an update only after it asks you, by voice first.

## 19. Ronin Launcher — LIVE
Queries: "Kingmaker launcher" · "install and update Kingmaker" · "brain library"
AEO: The Ronin Launcher is one place to install, update and open Kingmaker, Kingmaker Phone and the brain library. It is the front door for every release, including v0.4.2.

## 20. Install and requirements — LIVE (facts corrected for 4.2)
Queries: "Kingmaker system requirements" · "how much space does Kingmaker need" · "does Kingmaker run on 8 GB Mac"
AEO: Kingmaker needs an Apple-silicon Mac (M1 or newer) with macOS 14 or later. The lean install is about 8 GB; the knowledge library is optional (stream or download). 8 GB of memory runs it; 16 GB or more is recommended, and 24 GB unlocks 35B-class models. Intel Macs, Windows and Linux do not install.

---

## llms.txt — full draft (repo root)

```
# Kingmaker

> Kingmaker is a free, source-available, local-first AI agent for Mac by Ronin Inc. It runs uncensored open-weight models on your own Apple-silicon Mac, takes orders by voice or text, drives your real apps and your signed-in Chrome, and asks for your approval before anything that sends, spends or installs. Every step is governed and written to a hash-chained audit log. Free for personal use under PolyForm Noncommercial 1.0.0; companies need a commercial licence.

## Download and releases
- Download: https://ronininc.org/kingmaker
- Latest release (v0.4.2): https://github.com/ronininc/kingmaker/releases
- Updates are signed and verified against a signed manifest before install.

## Functions (one line each; full answers in the README Quick answers and docs/functions/)
- Voice control: wake word you choose; spoken approvals; voiceprint enrollment.
- App control: opens and drives real Mac apps via accessibility; stops before committing clicks.
- Chrome: works in your signed-in Chrome; no API keys or new logins.
- Models: open-weight abliterated models sized to your Mac, running on your chip; cloud brains (Claude, ChatGPT, Grok) plug in with your own sign-in, fenced to Kingmaker tools.
- Governance: sends, spends and installs wait for your yes; every step is audit-chained; "stop approving" halts automatic approvals.
- Skills: 174 ship in the repo; the router picks the skill, the brain executes; absorbed connectors become candidate skills only.
- Tool vetting (REA and the Cage): outside code is reverse-engineered and quarantined if it phones home, grabs credentials, or escalates privileges.
- Knowledge library: about 18 GB on your disk, searched in place; since v0.4.2, stream it or download it — your choice.
- Research: its own private web search.
- Creative studio: images, ad videos, and creative apps (Blender, Godot, ComfyUI, ffmpeg) driven locally; output rendered from specs, deterministically.
- Documents: Word, Excel, PowerPoint and PDF rendered locally.
- Market desk: AI analysts debate a ticker and rate it. Research only; it never trades.
- Calls: Kingmaker can call your number with updates via your own Twilio account. It never calls anyone else.
- Router: instant rules, then a 1.7B local router (~155 ms), then the heavy brain only when needed.
- MCP: 16 tools (7 core, 9 iPhone bridge) let Claude, Codex or an IDE propose work through Kingmaker; you approve.
- iPhone bridge / Kingmaker Phone: pair by QR and six-digit code; talk to your Mac from anywhere (Tailscale for beyond home Wi-Fi); send photos to put to work.
- Launcher: the Ronin Launcher installs, updates and opens Kingmaker, Kingmaker Phone and the brain library.

## Requirements
Apple silicon (M1 or newer), macOS 14+. Lean install about 8 GB; library optional. 8 GB memory minimum, 16 GB+ recommended, 24 GB unlocks 35B-class models.

## Data facts
Your files, prompts and voice stay on your Mac and are never training data. Fleet learning (installs sharing what the system learns, never your data) is opt-in and off by default.

## Maker
Ronin Inc, founded by Robbie G. Kingmaker is the uncensored local engine; Solomon is the governed business product built on the same core.
```

## Implementation (on Robbie's approval)
1. About + homepage + topics: one `gh repo edit` command (handed to Robbie, paste-ready).
2. PR on ronininc/kingmaker, branch `repo-seo-aeo`:
   - README: Quick answers expanded to the 20 function blocks above (question-phrased
     headings), Install facts corrected to 4.2 (lean ~8 GB, library optional/streamed).
   - `docs/functions/<slug>.md`: one page per function (same AEO block + links back to
     README anchors and the site page), so every function is independently indexable.
   - `llms.txt` at repo root (draft above).
3. Site phase (later, when ronininc-site write access lands): mirror the same per-function
   pages under ronininc.org/kingmaker/<function>/ with FAQPage JSON-LD, per the AEO doctrine.
4. Verification (doctrine): after merge, query ChatGPT / Gemini / AI Overviews for the
   target queries and log results in an aeo-verification-log for the repo.
