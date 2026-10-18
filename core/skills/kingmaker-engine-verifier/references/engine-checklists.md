# Kingmaker part checklists

Each part has the same five pieces: **Tests**, **Checklist** (what you do and see live), **Must stay true**,
**Recording must show**, **Verdict**. Run the tests with `node --test test/<name>.test.mjs`. `kingmaker` below is the
command inside the installed app (`/Applications/Kingmaker.app/Contents/Resources/sol-ghost/bin/kingmaker`).

Before any part: `kingmaker doctor`, and note every ✗ row. A ✗ in a part's own row means that part can't pass today.

---

## 1. Runtime
**Tests:** `runtime-respawn`, `background-runtime`, `unit`, `kingmaker-home`.
**Checklist:**
- `kingmaker start` in a terminal: the banner appears and this terminal becomes the owner console.
- In a second terminal, `kingmaker status`: runtime up on 127.0.0.1:3001, the process tree's memory, proposals
  waiting.
- `kingmaker stop` (or Quit Kingmaker from the menu bar logo): `kingmaker status` then says nothing is running.
**Must stay true:** one runtime per data folder (a second is refused); quitting leaves no runtime process behind.
**Recording must show:** start, status in the second terminal, stop, status again.
**Verdict:** VERIFIED only if it starts, reports itself truthfully and stops cleanly.

## 2. Voice
**Tests:** `voice-authority`, `push-to-talk`, `transcript-line`, `text-only`, `lang`, `self-check`.
**Checklist:**
- `kingmaker speak`: you hear the reply voice.
- Asleep: the logo is plain and the microphone is off. Wake it (click the logo, `kingmaker wake`, or "Hey Siri, wake
  Kingmaker" if `kingmaker siri` was set up). It says it's here.
- Ask something harmless ("what time is it"). It answers aloud.
- Talk over the answer: it stops.
- "That's all": it goes back to sleep. Speech while asleep is not answered.
- Read the voice decision log (`logs/voice.log` in the data folder): each decision is there; nothing heard while
  asleep is written, only its length.
**Must stay true:** the wake phrase alone never runs or approves anything; no audio is written to disk.
**Recording must show:** each step, with your voice and Kingmaker's on the audio track.
**Verdict:** VERIFIED only if wake, answer, barge-in and sleep all happen on the recording.

## 3. Verified owner voice
**Tests:** `owner-voice` (some tests skip without the engine's owner-voice modules; say so).
**Checklist:**
- With Kingmaker quit, `kingmaker enroll` at a terminal: read the five prompted sentences.
- `kingmaker voice verified`, then start Kingmaker.
- Ask for something that needs a yes. Say "yes, go ahead" in your own voice: it runs.
- Have another person (or a `say` voice) say "yes, go ahead": it answers that it can only do that for its owner's
  verified voice.
- Optional: `kingmaker enroll --forget` removes the voiceprint and its key.
**Must stay true:** another voice, Kingmaker's own voice, or a replayed phrase never approves.
**Recording must show:** enrollment, your approval working, the other voice refused.
**Verdict:** VERIFIED only if the other voice is refused on the recording.

## 4. Authority and approvals
**Tests:** `voice-authority`, `approvals`, `dms`, `flow`.
**Checklist:**
- `kingmaker say "<a request that changes something>"` from another shell: it is only proposed.
- At the console, `y` approves the waiting proposal and `n` cancels another.
- A RED action asks for its two challenge words ("confirm <words>"); a plain yes doesn't run it.
- "Stop approving" pauses delegated approvals at once.
**Must stay true:** `kingmaker say`, `kingmaker mcp` and the browser can propose but never approve.
**Recording must show:** the proposal from the other shell, the approval at the console, the RED challenge.
**Verdict:** VERIFIED only if nothing from another shell ran without the console's yes.

## 5. Hands
**Tests:** `hands`, `menu-click`, `macos-minimum`, `permissions`.
**Checklist:**
- `kingmaker doctor`: the hands row shows Accessibility and Screen Recording granted.
- Say or type "open Notes and click New Note". Reading the app happens freely; the click waits for your yes.
- One yes presses exactly one thing.
**Must stay true:** every committing step stops for a yes; the hands never click or type in a web browser.
**Recording must show:** the request, the stop for a yes, the one click.
**Verdict:** VERIFIED only if the click happened only after the yes.

## 6. Brains
**Tests:** `lanes`, `agent-lanes`, `claude-brain`, `fast-route`, `instructions`.
**Checklist:**
- `kingmaker brain`: which brain answers now. `kingmaker models`: the local models.
- With `local` (the local model, `kingmaker brain local`): ask a question; it answers with nothing sent off the Mac.
- If the owner uses a cloud brain (`kingmaker brain claude`, `chatgpt` or `grok`, then restart): ask the same
  question; say aloud that this prompt goes to that provider.
**Must stay true:** a cloud lane uses the owner's signed-in CLI and sees only Kingmaker's MCP tools; actions still
wait for the owner's word.
**Recording must show:** the brain setting and an answer from each brain tried.
**Verdict:** VERIFIED per brain tried; a brain not tried is UNVERIFIED.

## 7. Web research sources and evidence windows
**Tests:** `browse`, `artifacts`, `knowledge`.
**Checklist:** follow `kingmaker-native-internet`. Ask a research question; the pages it accepted open in Chrome (at
most three) while it explains.
**Must stay true:** a link that only appears in the answer text never opens; nothing with a password in the URL,
`file:` or `javascript:` opens.
**Recording must show:** the question, the source pages opening, the spoken answer.
**Verdict:** VERIFIED only if every page that opened was a source the answer stands on.

## 8. Connectors and REA
**Tests:** `rea`, `connectors`, `core-pack`, `extensions`.
**Checklist:** connect a small CLI, MCP server or skill folder from the Connectors page. Read its verdict (clean,
sandboxed or rejected) and its findings, each with a file and line.
**Must stay true:** a rejected connector is never connected; built-in skills can't be removed.
**Recording must show:** the connect, the verdict, the findings.
**Verdict:** VERIFIED only if the verdict matches what the code does (read the file it names).

## 9. ArtCraft apps
**Tests:** `artcraft`.
**Checklist:** `kingmaker craft status` (installed apps, versions, or the fix). Run one job, e.g.
`kingmaker craft photocraft --input <picture> --says "<text>"`: from a shell it is proposed; approve at the console;
the result opens.
**Must stay true:** a job that writes a file runs only on the owner's word; a changed binary is refused.
**Recording must show:** status, the proposal, the approval, the output.
**Verdict:** VERIFIED for the apps actually run.

## 10. Markets
**Tests:** `trading-agents`.
**Checklist:** `kingmaker markets status`; if installed, `kingmaker markets <TICKER>`. The rating appears with where its
reports are.
**Must stay true:** it never places, stages or schedules a trade.
**Recording must show:** the run and its rating.
**Verdict:** VERIFIED only if it stayed research only.

## 11. MCP surface
**Tests:** `connectors`, `voice-authority`.
**Checklist:** connect an MCP client to `kingmaker mcp`. List its tools: there is no approve tool. Ask it to do
something that needs a yes: it is proposed and waits at the console.
**Must stay true:** an agent can never confirm its own proposal.
**Recording must show:** the tool list and the waiting proposal.
**Verdict:** VERIFIED only if the proposal waited for the console.
