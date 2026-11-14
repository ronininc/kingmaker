🤫 source-available: open to everyone, not for commercial use 🤫

# Kingmaker 4.4.4

4.4.4 is the current public release, published 2026-11-07. The macOS installer is Developer ID signed, Apple-notarized and stapled, the release manifest is signed, and the release is live on GitHub (see release status below). One step is still open: the owner's clean-machine production proof — delete the local copy, download from the site, install, run — has not been done yet, so no install path is customer-proven yet.

Kingmaker is Ronin's governed local AI control surface. The shipped 4.4.4 release path is **macOS** (Linux and Windows units are built but not yet released — see release status). It runs as the native Kingmaker app on macOS and through the governed `kingmaker` owner console on packaged platforms. Its engine governs every action; platform adapters use direct CLI/API control where available, while the Hands of Horus provide the macOS accessibility fallback. It is source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE).

- **`Kingmaker.app` carries the complete runtime closure.** A valid 4.4.4 package contains the engine plus `kingmaker-runtime`, `voice-runtime`, `guardrails-runtime`, `guardrails-config`, `agent-runtime`, `knowledge-runtime`, managed Playwright browsers, the Chrome connector, `app.asar`, and the signed Kingmaker payload. The release gate rejects a missing, empty, unsafe or placeholder component.
- **The native shell may show a window; the engine remains a separate Node process.** `desktop/headless-server.mjs` is the engine entry point. The default app mode presents the bar shown by the Dock/menu-bar UI; `km.windowMode bar` is the menu-bar-only mode. These are two supported presentation modes, not two different engines.
- **A source checkout does not contain the compiled engine.** Development commands borrow a reviewed installed/staged runtime through `KINGMAKER_RUNTIME_APP`; packaged builds carry their own verified engine and resources.
- **macOS is the reviewed native GUI target and the shipped release path.** The 4.4.4 build pipeline also produces Linux x64 and Windows x64 install units from the same deep-verified payload. The 4.4.4 units were built and hash-verified on a Linux VM on 2026-11-06; they are not attached to the GitHub release and have not had native-host run proof, so they remain installer candidates, not a shipped path. NVIDIA is an inference backend on Windows/Linux, not a separate Kingmaker edition.

## 4.4.4 release status

The public release is **4.4.4**, published 2026-11-07 as a full GitHub release ([v4.4.4](https://github.com/ronininc/kingmaker/releases/tag/v4.4.4)) — not a draft, not a pre-release. Its 8 assets: the macOS installer DMG, the release manifest and its signature, SHA256SUMS, the two archive parts and the whole archive, and the Ronin Launcher 0.3.15 DMG and ZIP. The manifest is signed with the rotated release key; the current release-key fingerprint is:

`7EDC 06F8 D116 7C8A 2514 F7BA 5A06 6F7C A391 E9C9 FA78 8971 9FFD E2BD DD64 73B6`

The macOS installer (`Kingmaker-Installer-v4.4.4.dmg`) is Developer ID signed, Apple-notarized (Accepted), stapled, and Gatekeeper-verified (`spctl`: accepted, source = Notarized Developer ID). ronininc.org/download/kingmaker serves the Ronin Launcher 0.3.17 DMG (7,836,235 bytes) from this release; the Launcher is the front door — one download, Start opens it — and Kingmaker is free inside it. The 4.4.4 cut's suite ran 176/176 at the release staging tree, with the G7 guarded transport and the Brain Library machinery in the build.

Still open, stated plainly:

- The owner's clean-machine production proof (delete the local copy, download from the site, install, run) has not been done yet.
- The Windows x64 and Linux x64 4.4.4 units were built and hash-verified on a Linux VM on 2026-11-06, but they are not attached to this release and have not had native-host run proof; they are not verified native feature parity.
- The Brain Library holds 41 models and its machinery is in this build, but live streaming from it has not been proven end to end live.

See [platform evidence](docs/PLATFORM-SUPPORT.md).

Updates are authenticated separately from per-install identity and paid entitlement:

1. the signed release manifest binds the public app/archive bytes;
2. the Launcher/install certificate binds an installation to its current release using its opaque installation hash and proof of possession;
3. Scripture Armor is a separate paid product with its own UI, daemon and installers. Free Kingmaker carries only the shared compatibility modules and their Kingmaker product-policy dependencies its governed transport imports; installing Kingmaker does not install or entitle the standalone scanning-protection product.

Kingmaker checks its configured HTTPS update host on launch and wake (not on a background timer). `kingmaker update --setup` stores the update URL and the installation's existing update key through stdin; `kingmaker update --check` never manufactures a key or trusts an unsigned replacement.

## Install and update

The supported customer path is the Ronin Launcher: ronininc.org/download/kingmaker serves the Launcher DMG from the signed 4.4.4 release — one download — and Kingmaker is free inside it. The standalone **Kingmaker Installer** DMG remains the macOS recovery/fresh-install path. Neither path installs a local staging build: both deliver the final signed 4.4.4 manifest, its exact assets and the governed release envelope.

On macOS, the standalone installer has one wake-word field and one **Download & Install** button. After installation, Kingmaker opens in its normal app mode; it is not restricted to a menu-bar-only UI.

What the button does, in order (one progress bar for all of it):

1. **Checks this Mac:** macOS 14 or newer (15 for clicking and typing in other apps), Apple silicon, the wake word, and room on the disk (it says how much it needs before it starts, and stops there if it won't fit).
2. **Downloads the exact platform artifact** named by the signed `kingmaker.release/1` manifest. On macOS, large app archives may be split into parts of at most 1.9 GB. Every physical part, the joined archive, app bundle identity, payload closure and code signature must agree with the authenticated manifest. A cut-off part can resume.
3. **Apple's Command Line Tools and Homebrew**, only if they are missing (Homebrew's official package, pinned by sha256). macOS asks for your password once, in its own dialog.
4. **Ollama** (its official build, pinned by sha256) if it is missing, then **the abliterated models** Kingmaker runs (`lib/profile.mjs`), with the coder sized to the Mac: the 1.5b under 16 GB of memory, the 7b from 16 GB. Each model must come down with exactly the digest the release pinned from Ollama's registry; if one changed upstream since the release was built, the install stops and says so.
5. **Hands of Horus** (Peekaboo), **sox** (the microphone) and Python for SearXNG, through Homebrew, then **SearXNG** (private web search) with the engine's own installer, run by Kingmaker's own runtime.
6. **The knowledge library:** every confirmed corpus in the engine's bootstrap (about 17 GB), into a staging folder. A library that is already complete in Kingmaker's data folder is reused, not downloaded again.
7. **Moves Kingmaker into place:** the app (into `/Applications`, or `~/Applications` when `/Applications` isn't writable), the cemented wake word and the knowledge library. This step is journaled: if anything in it fails, everything it moved is moved back. An older copy is moved to the Trash (not deleted), and a running Kingmaker is asked to quit first.
8. **Opens Kingmaker** and the installer quits.

**Nothing is ever half-installed.** Kingmaker's own pieces (the app, its config, its library) exist only in staging until step 7, so a failure anywhere before leaves none of them in place, and a failure during step 7 puts everything back. The shared tools it installs on the way (Ollama and its models, Homebrew and its formulas, SearXNG) are each installed whole by their own installers and are kept, together with the verified downloads, so pressing the button again continues instead of starting over. The installer never installs third-party MCP servers or CLI tools: only Kingmaker's own parts and what they need to run.

**Gatekeeper:** an ad hoc local build is for private engineering validation only. A public macOS release must complete the configured production signing flow and the final post-signing physical gate. Developer ID/notarization are separate Apple distribution requirements; neither an ad hoc signature nor a manifest hash substitutes for them. The 4.4.4 macOS installer has completed that flow: Developer ID signed, Apple-notarized (Accepted), stapled, and accepted by Gatekeeper with source = Notarized Developer ID.

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

The host's real squeeze is the agent tooling, not the engine. Cloud-agent desktop apps and their CLI sessions (each starting its own `ghost mcp`) filled 8 GB with the engine off (measured 2026-10-05). Kingmaker removes the desktop app's visual load. It cannot remove theirs.

Proven live, with no window:
- "press Seven in Calculator" → the engine's grammar planner (no model) → a YELLOW proposal → the event stream pushes it to the console → `y` approves it by id → the tool runs.
- `n` cancels: "Cancelled. Nothing was changed."
- What you say while it is awake is your word: "press Seven in Calculator" spoken becomes the same YELLOW proposal as typed, and a spoken "cancel" cancels it (installed build 5253f40e, 2026-10-07).

## The app

When Kingmaker opens, it runs as a normal app window: a Dock icon and a Cmd-Tab entry, with the bar as its window (click the Dock icon or the menu-bar logo to bring it up). There is also always a tiny Ronin Inc logo in the menu bar (the crest's shield and eye, as a template image, so it matches your menu bar). To run it the old way instead — no window, no Dock icon, just the menu-bar logo — set `defaults write com.ronininc.solghost km.windowMode bar` (and `km.windowMode window` to switch back):

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
| `kingmaker say "<text>"` | One turn from any other shell, in the bar's lanes: a question the local writer can answer is answered there, and lookups and actions go to the engine (`--engine` sends anything there). It can only propose. Sources are listed under the answer (`--open` opens them). |
| `kingmaker brain local\|claude\|chatgpt\|grok` | Chooses the answering brain. The three cloud lanes use the owner's signed-in CLI and expose only Kingmaker's MCP tools; restart Kingmaker after changing it. |
| `kingmaker background status\|enable\|disable` | Headless Host Mode: registers or removes the installed `Kingmaker.app` as a macOS Login Item and keeps the plugged-in Mac awake while the lid stays open. The built-in display may sleep. |
| `kingmaker update --setup` | Reads the canonical HTTPS update-host URL and this installation's existing update key from stdin, then writes the private `update.json` configuration with mode 0600. It does not mint or rotate a key. |
| `kingmaker update --check` | Authenticates `latest.json` against the signed release manifest and reports an available update without applying it. |
| `kingmaker update --auto` | Performs the quiet authenticated launch/wake check. It reports that an update is ready; it does not silently apply it. |
| `kingmaker update` | Applies an authenticated newer release through the journaled installer. It refuses unsigned manifests, mismatched parts, an unrecognized release identity, rollback, or changed installed provenance. |
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
| `kingmaker settings` | Says where Kingmaker's settings are: the menu bar's gear, or `/connectors` (connectors, keys, and what it may reach on this Mac). |
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
| `build …` | Build a tool, tracker, dashboard or small site: the engine reads the plan back and builds it on your yes |
| `research …` | Research a question on the open internet, governed (online mode + consent); answers grounded or says it is not |
| `merchant clover dry-run …` | Dry-run a Clover menu change (proposes the diff, changes nothing); applying is the owner's word at the console |
| `fabricate …` | Plan a part with the engine (CAD): planning only, it proposes a plan and never runs a machine |
| `twin list · twin show …` | Project Twins: list, show, back-burner, export; reviewing a task is your word at the console |
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
| `new conversation` | A fresh cloud-agent conversation; what it learned stays |
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

## Known gaps (4.4.4, honest)

- **Clean-machine production proof is still pending.** The signed, notarized 4.4.4 release is live and its macOS installer passes Gatekeeper, but the owner's own acceptance run — delete the local copy, download the production installer from the site, install, run — has not been done yet. Until it has, no install path is customer-proven.
- **Linux and Windows install units are built, not released.** The 4.4.4 units were built and hash-verified on a Linux VM on 2026-11-06; they are not attached to the GitHub release and have not had native-host run proof, so they are not native GUI parity and not a shipped path. macOS is the shipped release path today.
- **System software it doesn't bundle** comes with the installer: Ollama and the models, the Hands of Horus, sox, SearXNG (Kingmaker starts an installed `ollama serve` when none is running). ghost-os stays an optional fallback for the hands. Blender, Godot and Chrome are found where they're installed.
- **The desktop app's first-run installer and knowledge-library offer are pop-ups in its window,** so they don't run headless. The runtime still reports what's missing.
- **The ledger calls spoken turns typed.** The engine records them as `operator_typed` because Kingmaker sends them with the console's nonce. An honest "spoken at the Kingmaker console" principal needs an engine change.
- **Mic capture is not live-tested here.** The first `kingmaker start` in Terminal triggers macOS's microphone prompt for Terminal.
- **The verified mode is proven on synthetic voices, not yet on your own.** The end-to-end proof (`npm run proof:owner-voice`) uses `say` voices as stand-ins for people; your first live run is `kingmaker enroll`.
- **The engine's own Kokoro voice** isn't wired yet; `say` is the 0-MB default. Kokoro can be added when RAM allows.
- **The wake detector** runs whisper on every speech segment while asleep. The bundled KWS spotter would make sleep near-zero CPU.

(yes the title is deliberate, share this by word of mouth not social media please.)

## Licence

Free for personal and noncommercial use under the [PolyForm Noncommercial License 1.0.0](LICENSE). Kingmaker is source-available, not open source: any commercial use, by any company, needs a written licence from Ronin Inc. Contact **ronininc@mail.grokbot.com**. See [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md); contributions are covered by [CONTRIBUTING.md](CONTRIBUTING.md).

## Fine print

Kingmaker shares what it learns by default, and it's your choice: the first time it has something to share, a permissions box asks, and "Keep it on this Mac" turns it off (so does "sharing off", any time). The line between your data and ours is absolute: everything you say, type, see or store stays on your device and stays yours. Only sanitized learning about how Kingmaker works is sent: skill procedures and scorecards, per-device evaluation and model-trial results, counts of public task words, and counts of preference kinds. Every packet is logged locally, exactly as sent, in `fleet/contributed.jsonl`. The collective's signed improvements go only to installs that share. Full terms: [TERMS.md](TERMS.md). The community-learning implementation lives in `lib/sharing.mjs` and its associated tests; this recovered tree does not contain the former standalone design document.


---

# Appendix — historical Kingmaker management-layer doctrine

_Historical design record consolidated from `ronininc/kingmaker-os` on 2026-10-23. It is preserved for provenance and is **not** the current 4.4.4 product description, deployment status, network contract or release checklist. Where it conflicts with the implementation documented above, the 4.4.4 source and signed contracts govern._

# Kingmaker

Kingmaker is the sovereign management layer for **Solomon** — the internal Ronin
executive/administrative and capability-evolution exoskeleton that **manages, builds,
alters, and monitors** a running Solomon instance.

Kingmaker is a **separate project, built after Solomon is done.** It was extracted from
the Solomon (TSS) repo on 2026-07-19; none of the files here had any Solomon importer —
Solomon does not depend on Kingmaker and does not run this code.

## The diode (anti-zero-day) security model

**Kingmaker is the SOLE, non-public access point to Solomon.** Solomon is not publicly
reachable at all; the only way to reach it is through the Kingmaker gateway. Kingmaker is a
closed-loop, one-way diode:

```
(the world) ──▶ Kingmaker ──(one-way, Kingmaker-initiated)──▶ Solomon
Solomon ──✗──▶ Kingmaker      (NEVER — Solomon holds no address, credential, or path back)
```

There is **no backdoor** into Solomon. All access flows through Kingmaker → Solomon.
Kingmaker *initiates* every connection (to manage/build/alter/monitor); Solomon is passive —
it only *responds* to reads/inputs Kingmaker initiates, over connectors that live on the
Solomon side (the receiving end). Solomon never opens an outbound connection to Kingmaker,
never pushes, and never learns where Kingmaker is. Monitoring works by Kingmaker PULLING
Solomon's exposed read surfaces (e.g. the self-hardening immune ledger), not by Solomon
reporting out.

**Anti-zero-day property:** a fully compromised Solomon cannot pivot into Kingmaker — there
is no route, address, or credential to follow — so Kingmaker's elevated management authority
can never become an inbound attack surface. The channel only flows one direction.

**Deployment:** Kingmaker is self-hosted on Ronin's own server in a **black site** (private,
not public, network-isolated). It is a SECONDARY program that begins only after Solomon is
complete.

Kingmaker uses this one-way channel to:
- **manage** Solomon (governed lifecycle, queue, founder review),
- **build** Solomon (capability evolution, the Vault),
- **alter** Solomon (governed changes pushed in through the connector),
- **monitor** Solomon's internals for users attempting harm (zero-day / breach detection).

## Contents

- `contracts/` — the governed lifecycle spine (pure types + pure functions, no I/O):
  - `kingmaker-queue.ts` — the queue lane/status state machine
    (Request → Review → Risk Class → Founder Table → Build Queue → Validation → Vault →
    Release → Hall of Fame / Public Telemetry).
  - `runtime-sovereignty.ts` — Green/Yellow/Red risk classification + device/runtime tiers.
  - `lifecycle-stage.ts` / `lifecycle-transitions.ts` / `lifecycle-snapshot.ts` — the
    stage vocabulary + "nothing teleports" transition guards + per-request stage state.
  - `capability-manifest.ts`, `intent-manifest.ts`, `objective-registry.ts` — the
    capability/intent/objective contract layers.
  - `vault-registry.ts` — governed capability accumulation (customer data never enters the
    Vault; contributor watermarks; no price penalty for contributions).
  - `federation-report.ts` — the SANITIZED Solomon→Kingmaker report schema + the SANDBOX that
    refuses any incoming report carrying a payload/source key, malformed JSON, or an un-sanitized
    shape. Abilities are metadata only — there is nothing to execute, so sandboxing = strict
    schema validation + anomaly quarantine.
  - `open-dev-hall-of-fame.ts` — contributor Hall of Fame, public idea pot, weekly draw,
    and ronininc.org public expansion telemetry.
- `runtime/` — `kingmaker-engine.ts`, `open-dev-engine.ts` (engine implementations over the
  contracts), and `solomon-federation-collector.ts` — the **first Solomon connector**: the PULL
  side of the S→K diode. It reads Solomon's exposed sanitized outbox, sandboxes every line, STAGES
  graduated abilities under review (a governed step later promotes them into the Vault — never
  auto-canon), records BLOCKED-skill threat intel, and QUARANTINES anything hostile. Kingmaker thus
  accumulates the abilities acquired across every Solomon installation, staying as powerful as their
  sum, with no path for a compromised node to push code or data upward.
- `docs/` — the Kingmaker ↔ Solomon split + ownership architecture.

## Status

Contract + engine layer, plus the **first one-way Solomon connector**: `solomon-federation-collector`
(the S→K federation transport) is built and tested (`npm test`) — it pulls + sandboxes + stages
Solomon's sanitized ability reports. The full runtime service, persistence, routes, UI, and the
remaining connectors (management/build/alter) are **not built yet** — Kingmaker begins in earnest
once Solomon is complete, when its core becomes a clone of a mature full-capacity Solomon + build
permissions (Solomon PLUS).

The Solomon side of this transport already exists in TSS: Solomon's governed acquisition loop writes
sanitized abilities/blocks to a durable local outbox (`data/capability-acquisition/kingmaker-outbox.jsonl`),
opening no outbound connection and holding no Kingmaker address. Point the collector at that file (the
exposed read surface) to pull it up.


Platform requirements, exact release/source provenance and scoped performance evidence: [Platform support](docs/PLATFORM-SUPPORT.md).
