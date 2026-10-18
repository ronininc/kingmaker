🤫 source-available: open to everyone, not for commercial use 🤫

# Kingmaker

Kingmaker is a headless, voice-driven agent for your Mac. Your Mac's own apps are the screen and your voice drives it. Its engine governs every step, and the Hands of Horus do the clicking (ghost-os when they are not installed). It is source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE).

Kingmaker runs its engine with no window: the engine's binary is used only as Node, started by its own headless launcher (`desktop/headless-server.mjs`). No Electron window, renderer, or GPU process is ever created.

- **The app (`Kingmaker.app`, installed by Kingmaker Installer) carries the engine inside itself.** Install it with Kingmaker Installer and you have all of it: server, voice runtime, guardrails, agent and knowledge runtimes, the browser runtime, the Chrome connector and the engine catalogs. Electron's binary is in it only as the Node runtime. There are no helper apps, so no window can start.
- **A git checkout (`bin/kingmaker`) has no engine**, so it borrows the runtime of an installed Kingmaker.app (`KINGMAKER_RUNTIME_APP`, default `/Applications/Kingmaker.app`). Inside the app, that variable is ignored.
- **The engine's source is not in this repo.** This repo is Kingmaker: the headless shell, its voice, console, abilities and installer. The engine ships compiled inside Kingmaker.app.

System requirements (macOS, Linux, Windows, Node, disk, permissions, lean 8 GB profile, test matrix): [docs/SYSTEM-REQUIREMENTS.md](docs/SYSTEM-REQUIREMENTS.md)

## Install: one window, one button

Open **Kingmaker Installer** (from its DMG). It is the only window Kingmaker ever shows. It has one field, the wake word, and one button, **Download & Install**. There is nothing to pick: you get all of it or none of it. Then it opens Kingmaker and quits, and from then on the only sign of Kingmaker is the Ronin Inc logo in your menu bar.

What the button does, in order (one progress bar for all of it):

1. **Checks this Mac:** macOS 14 or newer (15 for clicking and typing in other apps), Apple silicon, the wake word, and room on the disk (it says how much it needs before it starts, and stops there if it won't fit).
2. **Downloads Kingmaker.app** as release parts of at most 1.9 GB each (GitHub caps a release file at 2 GB; the app is about 4 GB). Every part is checked against the sha256 in the manifest the installer carries, then the whole archive is, then it is unpacked into a hidden staging folder beside its destination and its bundle id and code signature are checked. A download that gets cut off resumes from where it stopped the next time you press the button.
3. **Apple's Command Line Tools and Homebrew**, only if they are missing (Homebrew's official package, pinned by sha256). macOS asks for your password once, in its own dialog.
4. **Ollama** (its official build, pinned by sha256) if it is missing, then **the abliterated models** Kingmaker runs (`lib/profile.mjs`), with the coder sized to the Mac: the 1.5b under 16 GB of memory, the 7b from 16 GB. Each model must come down with exactly the digest the release pinned from Ollama's registry; if one changed upstream since the release was built, the install stops and says so.
5. **Hands of Horus** (Peekaboo), **sox** (the microphone) and Python for SearXNG, through Homebrew, then **SearXNG** (private web search) with the engine's own installer, run by Kingmaker's own runtime.
6. **The knowledge library:** every confirmed corpus in the engine's bootstrap (about 17 GB), into a staging folder. A library that is already complete in Kingmaker's data folder is reused, not downloaded again.
7. **Moves Kingmaker into place:** the app (into `/Applications`, or `~/Applications` when `/Applications` isn't writable), the cemented wake word and the knowledge library. This step is journaled: if anything in it fails, everything it moved is moved back. An older copy is moved to the Trash (not deleted), and a running Kingmaker is asked to quit first.
8. **Opens Kingmaker** and the installer quits.

**Nothing is ever half-installed.** Kingmaker's own pieces (the app, its config, its library) exist only in staging until step 7, so a failure anywhere before leaves none of them in place, and a failure during step 7 puts everything back. The shared tools it installs on the way (Ollama and its models, Homebrew and its formulas, SearXNG) are each installed whole by their own installers and are kept, together with the verified downloads, so pressing the button again continues instead of starting over. The installer never installs third-party MCP servers or CLI tools: only Kingmaker's own parts and what they need to run.

**Gatekeeper:** true one-click on someone else's Mac needs the installer signed with an Apple **Developer ID** and **notarized**. Until then it is signed ad hoc, and your Mac shows "Open Anyway" once for the installer.

## The wake word is cemented

You pick it on the install screen (default **Kingmaker**; 1 to 3 words, letters only). Then it's cemented. Want a different one? Delete Kingmaker and install it again. That's the whole settings page, lol.

- It is written once to `~/Library/Application Support/sol-ghost/install.json`, read-only, and to `wake-word.txt` beside it, which is how the engine learns its own name ("the wake word is the name"). Nothing in Kingmaker offers to change either, and `SOL_GHOST_WAKE_PHRASES` is ignored once a word is cemented.
- Reinstalling over an installed Kingmaker keeps its word (the field is locked to it; that's an update). Move Kingmaker.app to the Trash first and the installer lets you pick again.
- Mishearings are generated from the word itself, not hardcoded: spacing never matters ("king maker" is "Kingmaker"), a plural is fine, and a name of 6+ letters may be off by one slip after folding the usual spellings (c/k, ph/f, a dropped "-er"). Short names must match exactly.
- `kingmaker doctor` and the start banner say which word it is and whether it is cemented.

## Its own data

Kingmaker keeps its own data folder: `~/Library/Application Support/sol-ghost/runtime` (vault, memory, connectors, `.env`). It never writes the data folder of a windowed desktop app on the same engine, so the two can never write one data folder at once. The runtime takes a lock on whichever folder it runs (`runtime.lock`), and a second runtime on that folder is refused.

- Sharing the desktop app's data is an explicit opt-in: `KINGMAKER_DESKTOP_USERDATA="$HOME/Library/Application Support/solomon-desktop"`. It is still refused while the window runs on that folder.
- The desktop app (from its next build) refuses to start on a folder a headless engine holds. If Kingmaker is serving port 3001, the window reports it instead of killing it as an orphan.
- Machine-level tool installs (managed Playwright browsers, the DimOS venv, the local SearXNG service, Ollama's models) are shared. They are tools, not governed data.

## Measured on an 8 GB M3 (2026-10-07)

| | Desktop app | Kingmaker |
|---|---|---|
| UI processes | GPU helper 236 MB + renderer 181 MB (+ main) | none |
| Runtime at idle | server 434 MB (live data, after use) | launcher 16 MB + server 129 MB (fresh data folder) |
| Ronin Atlas boot prewarm | ~670 MB, held ~20 min | skipped; Ronin Atlas starts on first use (in the standalone app; the desktop app needs a rebuild) |
| Boot to ready | — | 22 s cold, ~5 s warm |

The host's real squeeze is the agent tooling, not the engine. The Claude desktop VM, Claude Code sessions (each starting its own `ghost mcp`) and Codex filled 8 GB with the engine off (measured 2026-10-05). Kingmaker removes the desktop app's visual load. It cannot remove theirs.

Proven live, with no window:
- "press Seven in Calculator" → the engine's grammar planner (no model) → a YELLOW proposal → the event stream pushes it to the console → `y` approves it by id → the tool runs.
- `n` cancels: "Cancelled. Nothing was changed."
- What you say while it is awake is your word: "press Seven in Calculator" spoken becomes the same YELLOW proposal as typed, and a spoken "cancel" cancels it (installed build 5253f40e, 2026-10-07).

## The app

When Kingmaker opens, it just starts: no window, no Dock icon. The only UI is a tiny Ronin Inc logo in the menu bar (the crest's shield and eye, as a template image, so it matches your menu bar):

| The logo | State |
|---|---|
| plain | asleep, microphone off ("Hey Siri, wake Kingmaker" wakes it) |
| glows | awake: talk to it |
| an RGB outline turns around it | listening to you |
| glows amber | working on your command |
| pulses | speaking to you (talk over it to stop it) |
| slow amber pulse | waiting for your word |
| red | not listening; the app quits with the engine |

It is all Core Animation: asleep, nothing is animating at all, so the UI costs no CPU. Click the logo to wake it (the same as "Hey Siri, wake Kingmaker": it says "I'm here." and takes your next words as a command; a click only ever wakes it, it never approves anything). Right-click, control-click or option-click the logo for its menu: one status line and **Quit Kingmaker**. `KINGMAKER_EDGE_GLOW=1` adds the old screen-edge RGB ring on top (four click-through windows per screen); by default there are no windows. macOS's own orange microphone dot shows on top of all of it. `scripts/build-app.sh --install` builds a thin dev copy into `~/Applications` (it borrows the installed Kingmaker.app's runtime). Quitting the app stops the engine, and so does force-quitting or a crash: the daemon's stdin closes and it shuts down (tested: 0 processes left after 2 s).

Approvals in the app are your word, never a menu click: say yes while Kingmaker is awake (or, with `kingmaker voice verified`, "yes, go ahead" in your enrolled voice), or type `y` at a `kingmaker start` terminal.

## Run it

```bash
./install.sh            # developers: checks the engine runtime, Ollama, the hands, sox; links kingmaker into ~/.local/bin
kingmaker doctor        # every piece, with the fix for anything missing
kingmaker start         # this terminal is the owner console; voice starts asleep
```

Kingmaker and the desktop app both serve `127.0.0.1:3001`, so run one at a time. Their data never mixes either way (see "Its own data").

| Command | What it does |
|---|---|
| `kingmaker start [--no-voice] [--quiet] [--port N]` | Runs Kingmaker's engine headless. Type to it here; `y` approves the waiting action, `n` cancels it. |
| `kingmaker voice [owner\|verified\|propose]` | Shows or sets what your spoken word can do (default `owner`). Set at a terminal; takes effect at the next start, for the app too. |
| `kingmaker enroll` | Enrolls your voice for the `verified` mode, typed at a terminal: read 5 short sentences aloud. |
| `kingmaker enroll --forget` | Deletes your voiceprint and its Keychain key. |
| `kingmaker say "<text>"` | One turn from any other shell. It can only propose. Its report opens on your desktop (`--no-open` to skip). |
| `kingmaker brain local\|claude\|chatgpt\|grok` | Chooses the answering brain. The three cloud lanes use the owner's signed-in CLI and expose only Kingmaker's MCP tools; restart Kingmaker after changing it. |
| `kingmaker background status\|enable\|disable` | Headless Host Mode: registers or removes the installed `Kingmaker.app` as a macOS Login Item and keeps the plugged-in Mac awake while the lid stays open. The built-in display may sleep. |
| ChatGPT/Codex interaction lease | When ChatGPT or Codex owns the foreground governed conversation, Kingmaker closes its microphone and suppresses wake acknowledgements, answers, and proactive announcements. It records a bounded private event for its own brain instead of speaking into the other transcript. Switching to another app releases the lease and the cemented wake path works normally. |
| `:key <provider>` at the console (or say "connect my GitHub key") | An API key into Kingmaker's vault: the provider's key page opens in Chrome, the steps are printed and spoken, you paste the key at a hidden prompt, and "Saved your GitHub key to the vault" comes only once the engine confirms. Connecting it and its live test wait for your `y`. Providers come from the engine's key-handoff catalog. |
| `kingmaker key <provider>` | The same from a shell, against a headless engine that minted its own owner secret (the Linux service: `--runtime-home <dir>`). While Kingmaker runs, its console holds the secret, so it points you there. |
| `kingmaker mcp` | MCP control surface over stdio, for Claude, Codex or an IDE. It can only propose. Its ArtCraft tools (`artcraft_status`, `artcraft_request`) go through the engine the same way. |
| `kingmaker craft [status]` | The seven ArtCraft apps: found (version, commit, sha256, pinned) or missing, each with its fix line. Also the engine's own view of them. `kingmaker doctor` lists them too. |
| `kingmaker craft install [app…]` | Builds them from source (all seven if none is named), one at a time. See "ArtCraft apps". |
| `kingmaker craft <app> [what…] [--input F] [--says T]` | Asks the engine to run one, e.g. `kingmaker craft photocraft --input beach.jpg --says "Summer sale"`. The input is copied into the ArtCraft inbox first. A job that makes a file is read back and runs only on the owner's word: from this shell it is proposed. At the console, `:craft <app> …` does the same as the owner. |
| `kingmaker scan [--find] [--force]` | The device scan, now (it also runs in the background on every start when the last one is over a week old): every app and how Kingmaker can drive it (its own CLI, an MCP server already configured on this Mac, Kingmaker's engine, AppleScript, its links, the Hands of Horus as the fallback), the CLIs on PATH, Homebrew/npm/uv/cargo tools, the web apps in your Chrome session (hosts only), and the API keys already on this Mac (names, provider and file only; never a value). One file: `<runtime home>/device-capabilities.json` (0600). `--find` is your consent to look online (the MCP registry and GitHub, only app names leave) for open-source tools for the apps with no CLI or MCP; they become proposals, ranked licence first (AGPL and non-commercial flagged), never installed. |
| `kingmaker tools` / `:tools` / "what can you drive" | The capability summary and the proposals. |
| "install <tool>" / "acquire <tool>" (said or typed at the console) | Outside code is never run as-is. Read back first; on your yes the proposal goes to the engine's acquisition loop as a capability gap: it is studied in quarantine and rebuilt as Kingmaker's own CLI or MCP tool, and nothing from it runs until you approve what comes out. |
| "put my keys in the vault" / `:key import` | The keys the scan found, read back by name and provider; on your yes they go to Kingmaker's vault in one receipted call (`/api/key-handoff/console/import`), and the lanes that read an env var (Tavily, Groq, Gemini, NIM, …) can use them. |
| "get me a Groq key" / "set up my keys" / `:key setup` | For the free APIs the engine uses (its free-tier catalog) with no key yet: read back, then on your yes the key page opens in your Chrome and a hidden Kingmaker paste box for that provider opens with it. You sign up and copy the key (Kingmaker never signs up, accepts terms, types a password or passes a check); paste and Save is your act: shape-checked, sealed, receipted, then a read-only check says whether it works. A provider already in the vault is never asked for again: the vault is outside every app bundle (`~/.solomon-secure`), so a rebuild or reinstall keeps it. "Save the Groq key" reads your clipboard once instead, on your spoken yes. |
| `kingmaker markets install\|status` / `kingmaker markets <TICKER>` | TradingAgents (TauricResearch, Apache-2.0) as a research-only ability: a desk of AI analysts on your local models rates one ticker Buy to Sell, with its reports. It never trades; not financial advice. See `core/skills/trading-agents/SKILL.md`. |
| `kingmaker settings` | Opens the engine's own settings pages in your browser, only when you ask. |
| `kingmaker status` / `stop` | Up or down, what's waiting, RAM across the process tree. |

### Grok brain

Install xAI's official Grok Build CLI, run `grok login` once, then choose it with `kingmaker brain grok`. Kingmaker invokes `grok -p` in bounded headless turns, resumes the same Grok session, and gives it only Kingmaker's MCP surface; Grok's shell, file, subagent and web tools remain disabled. `XAI_API_KEY` and `GROK_API_KEY` are deliberately removed from this lane, so it uses the cached CLI login instead of silently starting metered API usage. Set `SOL_GHOST_GROK_MODEL` only when you want to pin a model. Prompts and answers in this lane leave the Mac for xAI; Mac and CRM actions still pass through the engine's normal proposal and owner-approval boundary.

### Background operation and sleep

`kingmaker background enable` uses Apple's `SMAppService` Login Item API for the installed app; it installs no copied LaunchAgent or privileged helper, remains visible in System Settings ▸ General ▸ Login Items, and is reversible with `kingmaker background disable`. While the service is enabled, Kingmaker holds `caffeinate -s -w <pid>` for its full lifetime. That prevents **system** sleep while the Mac is connected to AC power, allows the built-in display to sleep, and automatically releases if Kingmaker exits.

The supported default is: **power connected, MacBook lid open, built-in display asleep/off**. A local process cannot execute while macOS is in true system sleep, and software does not override normal closed-lid sleep. A dock, external monitor, dummy-display adapter, or wake-on-LAN may be used as an optional recovery arrangement, but none is required or claimed by Headless Host Mode.


## Built-in skills

Kingmaker ships with 100+ skills in `core/skills/`: Ronin's own (websites, local-business operations, voice, releases),
the engine's project skills (Godot, Blender, ComfyUI, Docker, research, cameras, video and more), and the best public ones,
each under its own licence ([THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)). Two are the core of how Kingmaker meets
outside code:

- **`rea`**: REA reads any program, repo, MCP server, CLI or skill before Kingmaker uses it and says what it would do
  unprompted. Clean code runs as itself, code with bad parts runs sandboxed, and code that fetches-and-runs or hides
  what it runs is never connected.
- **`cli-anything`**: a ready-made CLI for 175+ apps from the Kingmaker CLI Hub, or a new CLI-Anything harness for an
  app that has none, so Kingmaker drives it exactly instead of clicking.

Name a skill in the bar (`/name`) to use it. Every skill, built in or added by you, goes through REA first.

## Paid add-ons

Kingmaker is complete on its own. Ronin sells add-ons through Ronin Launcher. The launcher hands one to
`kingmaker addons install <folder>` (the licence on stdin); Kingmaker checks it again itself: the manifest's signature by
Ronin's release key, every file's size and SHA-256, the Kingmaker version it needs, and, for a paid one, a licence
signed by Ronin for this Mac and not revoked. It then places the add-on in its own data folder, outside the app, and
loads it at the next start. An add-on never reaches into Kingmaker's files; it gets only what Kingmaker hands it.
`kingmaker addons list` shows what is installed; `kingmaker addons remove <id>` takes one out.

<!-- BEGIN command-list (generated from lib/command-list.mjs; edit it there) -->
## Command list

Every preset shortcut key, every bar and console command, and the words that turn a tool on. The bar shows the same list as its command library: click the small controller icon in its bottom row (🎮, beside Voice) for a glassy panel with every category side by side and a search bar on top (type what you want to do, e.g. *poster*, *approve*, *keys*). Choosing an entry puts it in the box, ready to finish and send.

### Shortcut keys

| Keys | What it does |
|---|---|
| ⌥Space | Open the bar from anywhere (Customize → Shortcut: ⌃Space, ⇧⌘K or none) |
| Hold fn | Talk to Kingmaker while it's held; let go and it's one command (Customize → Hold to talk) |
| ↵ | Send |
| ⌘↵ | Queue it for after the current answer |
| ⌥-click the mic | Talk to Kingmaker (a plain click dictates into the box) |
| Tab | Take the suggested next command, or the highlighted pick |
| ↑ ↓ | Move through the picks under the box |
| Esc | Close the picks; again to hide the bar |
| ⌘M | Minimize the bar (⌘W too); Kingmaker keeps running |
| ⌘V | Paste: copied files, images, video and audio attach to the message |
| ⌘Z | Undo (⇧⌘Z redo) |
| ⌘X ⌘C ⌘A | Cut, copy, select all |
| ↵ / Esc on a card | Answer the card in the bar (↵ takes its highlighted button) when you're in the bar and not typing |
| ⌘S | Save in Customize → How should Kingmaker behave? |

### In the bar

| Say or type | What it does |
|---|---|
| `/off` | A real off: no listening, no wake word, until /on |
| `/on` | Turn it back on |
| `/mute` | No voice: answers here as text |
| `/unmute` | Speak again |
| `/folder` | Choose the folder Kingmaker works in |
| `/clear` | A new conversation (/new too) |
| `/connectors` | Connectors & keys (/keys, /settings, /connections) |
| `/behave` | How Kingmaker should behave, and its guardrails (/instructions, /guardrails) |
| `/<program> …` | Drive that program with the rest of the words (type / for the list) |
| `@name` | Attach a file from this Mac |

### Typed commands (console, or the bar)

| Say or type | What it does |
|---|---|
| `:key <provider>` | Put an API key in the vault (console only) |
| `:key import · :key setup` | The keys the scan found · free keys still missing (console only) |
| `:craft <app> …` | Run an ArtCraft app (console only) |
| `:tools · :scan` | What it can drive · rescan this Mac (console only) |
| `:pending · y · n` | What's waiting · approve it · cancel it (console only) |
| `:help · :quit` | The console's help · stop Kingmaker (console only) |

### Say or type to turn a tool on

| Say or type | What it does |
|---|---|
| `open youtube · open Photos · open gmail` | Open an app or site |
| `how many files on my desktop` | Count files |
| `whatsapp Ana saying on my way` | WhatsApp someone from Contacts: it opens ready, you press Send |
| `make a poster for …` | Draw a picture on this Mac (about 90 s); it shows in the chat |
| `make an ad about …` | Make an ad video on this Mac |
| `write … · draft … · research …` | Written work or research, by the local writer |
| `connect my CRM` | Dock the CRM (the key goes through the hidden field into the vault) |
| `connect my GitHub key` | Any provider's key into the vault |
| `scan my Mac` | Rescan what it can drive (read-only) |
| `what can you drive` | Its tools and the proposals |
| `find tools for my apps` | Your OK to look online for open-source tools |
| `install <tool>` | Acquire a tool: studied in quarantine, rebuilt, and only run on your yes |
| `put my keys in the vault` | The keys the scan found, into the vault on your yes |
| `set up my keys · get me a Groq key` | The free API keys it still needs |
| `learning on · learning off` | Learn your preferences from what you say |
| `keep that · drop that` | Keep or drop what it just offered to learn |
| `what have you learned about me` | What it has learned about you |
| `forget what you learned about …` | Forget it |
| `where did you learn …` | Where a preference came from |
| `sharing on · sharing off` | Community learning (kept preferences only) |
| `new conversation` | A fresh Claude/ChatGPT conversation; what it learned stays |
| `stop approving` | Kill switch: everything that approves without asking stops, at once |
<!-- END command-list -->

## Who can do what (same rules as the desktop app)

At launch Kingmaker mints the same two per-launch secrets the desktop shell mints: the control nonce and the voice-attestation key. Their presence switches the engine's principal enforcement on. They live only in Kingmaker's memory and the server's environment. They are never written to disk or logged.

| Where it comes from | The engine sees | Can |
|---|---|---|
| Typed at the `kingmaker start` terminal | `operator_typed` (nonce) | Ask, run your direct commands, approve proposals |
| Your voice while Kingmaker is awake (default, `owner`) | your word (sent with this console's nonce, `operator_typed`) | Everything typing here can: run commands, say yes, say "confirm <words>" for RED |
| With `kingmaker voice verified`: your enrolled voice, verified on this utterance | `owner_voice` (solvox2 attestation) | Ask, run your direct commands, approve what you asked for with "yes, go ahead" |
| With `verified`: any other voice, Kingmaker's own echo, you talking over Kingmaker, a replayed token, or no voiceprint | `unverified_voice` | Ask and get answers. An action gets "I can only do that for my owner's verified voice." |
| `kingmaker say`, `kingmaker mcp`, the browser, any program | `local_process` | Ask and propose; never approve; never reach the owner-only routes |

The engine's owner-only routes (the vault, CLI-Anything, reverse engineering, capability acquisition, feature watch, key handoff) admit only this console when there is no window: whoever installed Kingmaker and holds its console is the owner. Opening a route is not an approval: money, outbound messages, connector writes and every proposal still wait for your word.

The MCP server has **no approve tool**. An agent can never confirm its own proposal.

## Voice

The examples say "Kingmaker"; yours says whatever word you cemented at install.

- **Asleep by default, microphone off.** While asleep, nothing is captured at all. "Hey Siri, wake Kingmaker" (a Shortcut `kingmaker siri` adds; it opens `kingmaker://wake`) or `kingmaker wake` wakes it.
- **Addressing it by name:** "Kingmaker, …" wakes it and the name comes off the command, so "Kingmaker, open my Chrome" works in one breath (with `SOL_GHOST_LISTEN_ASLEEP=1` the name alone wakes it from sleep too).
- **Decision log:** `logs/voice.log` records each decision (woke, slept, ignored N characters, barge-in, the command sent). Anything heard while asleep is never written, only its length.
- **Awake:** talk normally with no wake word, until "Kingmaker, go to sleep" (or "that's all") or 2 minutes of quiet. "Shut down" turns it off.
- **Waking is the gate, not the words.** The wake phrase itself is never sent to the engine, so "Kingmaker, wake up" on its own never runs or approves anything. "Kingmaker, yes go ahead" in one breath sends only "yes go ahead".
- **What your voice can do** (`kingmaker voice`; `SOL_GHOST_VOICE_AUTHORITY` wins over it):
  - `owner` (default): what Kingmaker hears while AWAKE is your word, sent with this console's nonce. Waking it is the only gate: anything audible while it is awake (a person, the TV) has that authority, and RED still needs its two challenge words.
  - `verified` (opt-in): only your enrolled voice is your word. See "Verified voice" below.
  - `propose`: speech only proposes (a local program's authority), and approvals are typed.

## Verified voice (opt-in)

For when "anyone audible while it is awake" is too loose. `kingmaker enroll` (once, typed at a terminal, with Kingmaker quit) runs the engine's own guided enrollment (`desktop/owner-voice/*`, used as shipped): you read 5 prompted sentences, each is checked (too short, wrong sentence, Kingmaker's own voice, a second voice), and the averaged voiceprint is sealed. Then `kingmaker voice verified` turns it on. In that mode every voice turn carries a solvox2 attestation that the engine's server re-checks before it counts as you:

- **Per utterance:** the same audio that whisper transcribes is embedded by the bundled CAM++ model, compared with your print (threshold 0.62), and the token is minted for the exact text sent. The server re-checks the key, MAC, age (15 s), the transcript hash, the minimum speech (700 ms), and that the token has never been used.
- **Never you:** another voice (`owner_mismatch`), Kingmaker's own voice (`self_echo`, against its `say` voice learned at each start), speech captured while Kingmaker was talking, a re-sent token (`replayed`), or no enrolled print.
- **Say "yes, go ahead", not just "yes".** A bare "yes" is usually under the 700 ms the server requires, and Kingmaker then answers "I couldn't verify it was your voice". `cancel` always works, from anyone.
- **What a spoken yes can approve:** what you (or the console) asked for. A proposal from `kingmaker say`, MCP or another program is never voice-approvable, by the engine's rule; approve those with `y` at the console.
- **Sealed, not stored:** the print is AES-256-GCM sealed with a random key in your login Keychain (item "Sol Ghost Owner Voice"), under `~/Library/Application Support/sol-ghost/owner-voice/`. No audio is ever written: whisper reads the WAV on stdin, the speaker model gets PCM on stdin, and buffers are zero-filled after each utterance. `--forget` zero-fills the file and deletes the Keychain key, so any old backup of the file can't be opened.
- **Honest limit:** the key's trusted reader is `/usr/bin/security`, so a program running as you could ask for it, the same reach it has over the rest of your account. Narrowing that to Kingmaker's own code signature needs a Developer-ID-signed helper with a Keychain access group.
- **Speech:** replies come from Apple's own `say` voice, headless with nothing resident.
- **Barge-in:** talk over it and it stops (detection is about 300 ms). It never fires in the first 700 ms of a reply. The echo level is learned only once `say` is actually audible, because `say` starts silent and learning from that silence used to cut its own voice off. `SOL_GHOST_BARGE=0` turns it off.
- **Listening:** mic via `sox` (or ffmpeg), endpointing in-process, then the app's bundled whisper.cpp per utterance. Nothing stays resident between utterances.
- **Overrides:** `SOL_GHOST_SAY_VOICE` changes the voice. `SOL_GHOST_WAKE_PHRASES` changes the wake phrases only on a legacy install; once a word is cemented it is ignored.

## Chrome connector

Kingmaker sets up its Chrome connector with the engine's own setup code (`desktop/chrome-connector-setup.mjs` + `chrome-extension-update.mjs`, imported from the bundle):

- **Talks to the server, not a window.** The extension's native host calls the engine's server on `127.0.0.1:3001`, so keep Kingmaker on port 3001.
- **Setup:** `kingmaker chrome` (or `./install.sh --yes`) writes the native-messaging host and a Chrome connector folder on your Desktop.
- **One step only you can do:** in Chrome, open `chrome://extensions`, turn on Developer mode, choose Load unpacked, and pick that folder. Chrome doesn't let a program add an unpacked extension.
- **Updates:** every start keeps the loaded copy current, as the desktop app does.

## Ronin Atlas (formerly God's Eye)

Ronin Atlas stays installed and is driven in the browser. Only its boot warm-up is skipped (`SOLOMON_GODS_EYE_PREWARM=0`), because on 8 GB it holds about 670 MB for about 20 minutes at every boot. It starts on first use instead. `SOL_GHOST_GODS_EYE=0` turns Ronin Atlas off entirely (the variable keeps its old name).

## Evidence, as Mac windows

When a turn produces something (an image, a video, a page), Kingmaker opens it with your Mac's own apps: Preview, QuickTime or your browser. Only the engine's own output is ever opened, meaning files in its `generated-media` / `evidence-screenshots` / `artifacts` folders, or pages on its own loopback port. Links that merely appear in an answer are never opened. `SOL_GHOST_OPEN_EVIDENCE=0` turns this off.

## What drives what

1. **Apps macOS can see through accessibility** (most Mac apps, Finder, Notes, Mail, Calculator): the Hands of Horus, through the engine's mac provider and its governed device actions (voice "open Notes and click New Note", a WhatsApp send). Reading is free. Every committing step stops for a yes, and one yes presses exactly one thing. They act on an app in place, without bringing it forward, and never click or type in a web browser. When they are not installed, ghost-os does this, as before.

## The hands

The Hands of Horus are an MIT-licensed macOS automation tool (credited in the code where it is invoked), driven over its MCP server. Install with `brew install openclaw/tap/peekaboo`, then allow its Bridge under System Settings ▸ Privacy & Security ▸ Accessibility and Screen Recording. When the `peekaboo` binary is found (`/opt/homebrew/bin`, `/usr/local/bin`, then `PATH`; or `SOL_GHOST_PEEKABOO_BIN`), Kingmaker hands the engine `SOLOMON_MAC_HANDS=peekaboo` and `SOLOMON_PEEKABOO_MCP_CMD`, and the start banner says `Hands: Hands of Horus <version> live (<N> tools, …)`. `kingmaker doctor` reads their own permission report. Your own `SOLOMON_*` environment wins: `SOLOMON_MAC_HANDS=ghost` goes back to ghost-os. Kingmaker never uses their built-in AI agent, image analysis or browser tools.
2. **Scriptable programs** (Blender, Godot, FreeCAD, ffmpeg, ComfyUI, anything added with CLI-Anything or a self-built skill): Kingmaker's engine drives them through their CLI or Python API. This is more deterministic than clicking. Blender draws its own UI, so the accessibility tree sees almost nothing inside it.
3. **Pixel-only surfaces** (a 3D viewport, a game, canvas web apps): these need ghost-os vision grounding (ShowUI-2B, about 3 GB). That's off on 8 GB and turns on with more RAM.

## ArtCraft apps

The engine's ArtCraft adapter drives seven open-source creative apps from `storytold/*`, each MIT OR Apache-2.0: PhotoCraft, VectorCraft, FilmCraft, LightCraft, EffectCraft, PrintCraft (its repo is now `storytold/pdfcraft`; the CLI is still `printcraft-cli`) and DesignCraft. It runs their CLIs in a sandbox with no network, verifies every output by its bytes and signs a receipt.

- **Where they go.** `<runtime home>/data/artcraft/bin`, Kingmaker's own data root. The adapter looks there itself, so a Kingmaker that is already running finds a new install. Every start also hands the engine `SOLOMON_ARTCRAFT_BIN_DIR` and, for each app Kingmaker built, `SOLOMON_<APP>_CLI_SHA256`. With that pin, a binary that changed since the install is refused, never run. Your own `SOLOMON_*` environment wins.
- **Building.** There are no published binaries. `kingmaker craft install` fetches each repo at the commit the engine's evaluation verified. Then it runs `cargo build --release --locked -p <app>-cli` and copies the binary in. The commit, version and sha256 go into `sol-ghost-craft.json` beside it, and the clone and target folder are removed (`--keep-build` keeps them). Builds run one at a time, at `nice 15`, with 2 jobs on 8 GB, and paced like every other Kingmaker background job. A build waits while another cargo build or critical memory pressure is going. It never gives up because the Mac is busy. It stops only when the disk has less than 4 GB free.
- **Using them.** Only through the engine: by voice ("PhotoCraft, make a carousel image from beach.jpg"), at the console (`:craft`), with `kingmaker craft`, or over MCP. The apps' own `<app>-cli mcp` servers are never started or re-exported. With no flags, VectorCraft's attaches to an unauthenticated `127.0.0.1:7979`. VectorCraft `screenshot` and DesignCraft `render_page` claim to be read-only but write a file when given a path. What a request does is judged from its words and by the engine, never from a tool's hint. FilmCraft and EffectCraft renders wait for the engine's heavy slot, never beside a model load.
- **LightCraft in this build.** HEIC and AVIF do not decode, and its folder import skips Nikon `.nrw`. `kingmaker craft lightcraft --input <folder>` counts those files and says so.

## Known gaps (v0.1, honest)

- **Not notarized yet.** Kingmaker.app is about 4 GB, mostly the knowledge runtime (2 GB) and the voice runtime (1 GB). Kingmaker Installer downloads it as release parts. Until there is an Apple Developer ID to sign and notarize the installer with, your Mac needs "Open Anyway" once for the installer.
- **System software it doesn't bundle** comes with the installer: Ollama and the models, the Hands of Horus, sox, SearXNG (Kingmaker starts an installed `ollama serve` when none is running). ghost-os stays an optional fallback for the hands. Blender, Godot and Chrome are found where they're installed.
- **The desktop app's first-run installer and knowledge-library offer are pop-ups in its window,** so they don't run headless. The runtime still reports what's missing.
- **The ledger calls spoken turns typed.** The engine records them as `operator_typed` because Kingmaker sends them with the console's nonce. An honest "spoken at the Kingmaker console" principal needs an engine change.
- **Mic capture is not live-tested here.** The first `kingmaker start` in Terminal triggers macOS's microphone prompt for Terminal.
- **The verified mode is proven on synthetic voices, not yet on your own.** The end-to-end proof (`npm run proof:owner-voice`) uses `say` voices as stand-ins for people; your first live run is `kingmaker enroll`.
- **The engine's own Kokoro voice** isn't wired yet; `say` is the 0-MB default. Kokoro can be added when RAM allows.
- **The wake detector** runs whisper on every speech segment while asleep. The bundled KWS spotter would make sleep near-zero CPU.

(yes the title is deliberate, share this by word of mouth not social media please.)

## Licence

Free for personal and noncommercial use under the [PolyForm Noncommercial License 1.0.0](LICENSE). Kingmaker is source-available, not open source: any commercial use, by any company, needs a written licence from Ronin Inc. Contact **ronininc2026@gmail.com**. See [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md); contributions are covered by [CONTRIBUTING.md](CONTRIBUTING.md).

## Fine print

Kingmaker shares what it learns by default, and it's your choice: the first time it has something to share, a permissions box asks, and "Keep it on this Mac" turns it off (so does "sharing off", any time). The line between your data and ours is absolute: everything you say, type, see or store stays on your device and stays yours. Only sanitized learning about how Kingmaker works is sent: skill procedures and scorecards, per-device evaluation and model-trial results, counts of public task words, and counts of preference kinds. Every packet is logged locally, exactly as sent, in `fleet/contributed.jsonl`. The collective's signed improvements go only to installs that share. Full terms: [TERMS.md](TERMS.md); the design is in [docs/community-learning.md](docs/community-learning.md).
