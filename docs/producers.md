# Producers — Kingmaker-callable ingest tools

The four ingest lanes (headless browser, site crawler, YouTube scraper, voice
runtime) were proven as *ingest* on 2026-11-13: real tool output, folded at
ingest, every identifier restored byte-exact. As of this build they are
**registered tools the brain can call in the background** — the tool-wiring
doctrine's bar: the running brain's tool-calling layer knows each one by name,
purpose and parameter schema, and can invoke it headless.

## The registration

`lib/producers.mjs` exports `PRODUCER_TOOLS` — four MCP-shaped descriptors
(`name`, `description`, `inputSchema`, `annotations`) — and
`lib/mcp.mjs` spreads them into the registry's `TOOLS` beside `IPHONE_TOOLS`
and routes `tools/call` for their names to `callProducerTool`, exactly the
iPhone bridge's pattern. `tools/list` therefore carries them; a client that
can call `kingmaker_turn` can call these.

| Tool | Engine | Input | Artifact |
|---|---|---|---|
| `ingest-browser-capture` | Playwright + staged Chromium, via the loopback egress relay | `url`, opt. `settleMs` | page capture: status, title, full text, links, assets |
| `ingest-site-crawl` | the CRM build's `worker/site-crawl.ts` | `url`, opt. `maxPages`/`maxChecks` | crawl report + every recorded URL |
| `ingest-youtube-transcript` | yt-dlp | `videoId` XOR `query`, opt. `minTranscriptChars` | metadata + cleaned English transcript |
| `ingest-voice-transcribe` | faster-whisper, local weights | `audioPath` XOR `audioPaths` | segment-timed transcript(s) |

## The call contract

- **One call = one job folder = one child process**, headless, argv only (no
  shell). The runner (`createProducerRunner`) spawns the producer script in
  `lib/producers/`, the producer writes `output.txt` + `output.meta.json`
  into the job folder, and the call returns a **receipt**: job folder,
  artifact paths, char count, the artifact's SHA-256 **recomputed from the
  bytes on disk**, and the producer's meta — cross-checked against that hash
  when the meta carries one. A failed producer (bad args, spawn failure,
  timeout, non-zero exit, missing artifact, meta/hash mismatch) returns an
  `isError` result. It never returns a receipt for an artifact that is not
  on disk.
- **Receipts, not content.** The artifact text stays in the job folder for
  the caller's own next step (fold it into the evidence store, read it,
  quote it) — the tool result itself stays small enough for a small model's
  context.
- **Background-safe.** Job folders are unique per call (module-level
  sequence + timestamp) and the browser lane's egress relay binds an
  ephemeral port per capture, so concurrent calls — the normal case for
  background tools — do not collide. Proven by the build's evaluation
  battery: two concurrent captures of the same page both landed, distinct
  job folders, HTTP 200 each.
- **Batch the voice.** The whisper model load is the expensive part of a
  transcription (~15 s on the build VM). `audioPaths` transcribes several
  files under one load in one call; prefer it whenever a caller has more
  than one file.
- **Timeouts** are per tool (browser 180 s, crawl 300 s, YouTube 600 s,
  voice 1800 s — transcription cost scales with audio length and cell
  contention) and a kill on timeout is reported as a timeout, never as a
  silent partial success. Every failure names the job folder, and the
  voice producer writes **incrementally** — each finished file's
  transcript lands on disk as it completes, with `complete: false` in
  its meta until the last file — so even a killed run leaves its finished
  work findable from the error alone.

## Node-local bindings

The producers resolve their heavy dependencies from the environment, with
the fleet's proven locations as defaults. A node that lacks one gets the
producer's own error as the call's error — never a fabricated artifact.

- `KINGMAKER_PLAYWRIGHT_PACKAGE` — a `package.json` whose `node_modules`
  carry Playwright (and its staged Chromium).
- `KINGMAKER_SITE_CRAWL_MODULE` — path to the CRM build's
  `worker/site-crawl.ts`.
- `KINGMAKER_WHISPER_MODEL` — a faster-whisper model name or local CT2
  folder; loaded `local_files_only`, so a missing model is an error, never
  a silent download.
- The browser lane also needs `HTTPS_PROXY` in the environment (the egress
  relay reads its credentials from there and never prints them).

The MCP host wires the job-folder parent once: `deps.producers.workRoot`
(or a prebuilt `deps.producers.runner` from `createProducerRunner`).

## What these tools are not

Ingest lanes, not gates. A producer run changes nothing outside its job
folder, sends nothing, approves nothing, and folds nothing by itself. What
a caller does with the material afterwards keeps that path's own rules —
the fold-at-ingest pipeline (`jev-bili-ingest-2026-11-13`) is the proven
next step for material headed into the evidence store.
