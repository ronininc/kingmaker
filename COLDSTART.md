# COLDSTART.md — the cold-start attack: budget, build, and honest numbers

Goal: **"instantaneous"** — from the owner's action (launch, or the first request of a session) to
Kingmaker ready and answering. This document is the phase budget, what was built against it, the
measurements this machine could honestly take, and the explicit list of what only the real
8 GB M3 Mac can prove.

The discipline that runs through all of it: **every number is labeled REAL or SIMULATED.** A
simulated number is never presented as measured — the harness (`lib/cold-start.mjs`) refuses an
unlabeled kind outright, and its verdict (`phaseVerdict`) can only say "proven" when *every*
phase was measured REAL and within budget.

## The phase budget

Launch → ready, decomposed (budgets written against the 8 GB M3 class — the acceptance machine,
where a swapping host made a single Ollama probe cost up to 6,100 ms; see
`OLLAMA_PROBE_TIMEOUT_MS` in `lib/cli.mjs`):

| Phase | What it covers | Budget |
|---|---|---|
| process | Node starts and the launcher's module graph loads | 500 ms |
| preflight | Paths, payload check, launch blockers, the Ollama probe | 1,000 ms |
| engine | The engine process spawns and prints its listening line | 3,000 ms |
| post-ready | Rules verified fail-closed, hands warm, session wired, supervision armed | 2,000 ms |
| first-decision | The first reflex decision (decision router round trip + the reflex model's pass) | 150 ms |
| first-token | The first generated token of the first real answer | 1,000 ms |

The strategic reading: on a *cold* machine the engine boot and the weight loads dominate, and no
launcher trick removes them — so the build makes sure they are paid **once, early, and in
parallel**, and that every launch after the first pays almost none of it:

- the engine becomes a **resident** that survives its launcher and is *adopted*, not respawned;
- the model seats are **pre-warmed during startup** (weights paged in via mmap, held with
  `keep_alive`), so the first turn finds them resident instead of paying their load;
- everything a fresh session predictably needs is **staged in the background** the moment the
  rules pass, while the session is still being wired.

## What was implemented

### 1. The measurement harness — `lib/cold-start.mjs`, `scripts/coldstart-bench.mjs`

`COLD_START_PHASES` (the budget above), `createPhaseTimer` (mark/set/rows), `phaseVerdict`,
`formatPhaseTable`. The bench times all six phases: a fresh child process imports the startup
module set; preflight runs for real (paths, payload check, port probe, resident probe);
`startBackend` runs for real against a **fixture** engine (its scripted boot delay is the
simulated part, and the launcher mechanics around it are reported separately); the real
`DecisionRouter` runs against a mock SystemOne endpoint; a mock generate stream stands in for
first-token. `node scripts/coldstart-bench.mjs [--json]`.

The launcher itself now times its own launch: `cmdStart` marks preflight → engine → post-ready
and logs a `cold_start` event plus one console line (`cold start: preflight … · engine … ·
post-ready …`) when the session is ready.

### 2. One Ollama probe, not two — `lib/cli.mjs`

Launch asked Ollama two questions in two sequential `/api/tags` round trips (`ollamaUp()`, then
`ollamaModels()`). One `ollamaProbe()` now answers both under the bounded probe timeout, and its
model list feeds `installedModels`. On a swapping 8 GB Mac each trip could cost seconds; the
second was pure cold-start latency for information the first already carried.

### 3. Post-ready: serial → concurrent + background staging — `lib/cli.mjs`, `lib/model-warm.mjs`

`startupStagePlan` names the stages a fresh session predictably needs:

- **blocking** (unchanged semantics, now concurrent): the fail-closed rules check and the hands
  warm never needed each other's answer, so they run under one `Promise.all` instead of
  back-to-back (the hands warm alone is ≈2 s cold). The rules verdict still gates everything
  after it — fail-closed is untouched.
- **background** (started the moment the rules pass, while the session wires up):
  `reflex-warm` (the decision router's reflex seat), one `brain-warm:<model>` per brain seat,
  and `chrome-sync` — the Chrome connector sync that used to be *awaited* on the launch path.
  A background stage that misses is a logged outcome (`startup_stage` events), never a launch
  failure. No stage approves, sends, or changes settings.

### 4. Weight-loading wins — `lib/model-warm.mjs`

- **mmap / lazy load, pinned in one place:** every pre-warm is an Ollama load call
  (`POST /api/generate`, no prompt, `stream: false`) whose body sets
  `options: { use_mmap: true }` — weights are memory-mapped and paged on use rather than read
  eagerly — and `keep_alive: '30m'`, so a warmed seat *stays* resident instead of being evicted
  before the first turn.
- **Reflex pre-warm:** the reflex seat is the decision router's **own pick** for the host's Mac
  class (`reflexPrewarmModel` = `DecisionRouter.pickModelForMac`) — never a second,
  hand-maintained choice, because the warmed seat must be the seat the reflex layer actually
  calls. At this registry revision the pick is `tev1` (0.8B, 812 MB, 100 ms published latency)
  on every shipping class; `laya` (0.421B, ~450 MB, 33 ms) is the registry's next entry, not
  the router's pick. At engine start the seat is (a) loaded into Ollama like any seat, and
  (b) given one **discarded** `DecisionRouter.decide()` warmup call (`prewarmReflex`, against
  the same `OLLAMA_HOST` endpoint the reflex layer's router is constructed with), so the first
  *real* reflex decision doesn't pay the endpoint's cold path either. Reflex decisions must be
  instant — a 150 ms budget cannot contain an 812 MB cold load.
- **Brain seats:** the launch's pinned models (abliterated pins + the owner's catalog choice)
  are pre-warmed the same way, deduped.

### 5. The resident engine — `lib/resident-engine.mjs`, wired into `lib/cli.mjs`

Before: residency was an accident of the app staying open. The launcher started the engine
in-process, and "an engine is already running" was only ever a *refusal* (`startBlockers`).
Now there is a lifecycle:

- **probe** — daemon state (runtime.mjs) + pid liveness + the engine's own `/api/health`
  (client.mjs) as the readiness endpoint → `ready` / `starting` / `orphaned` / `foreign` /
  `down`. A live pid that doesn't answer is `starting`, never `ready` — a reused engine must be
  a *working* engine.
- **ensure** — ready → reuse (a live session is *not* attached; `cmdStart` refuses a second
  session, as before); starting → bounded wait, never a second spawn on a held port; foreign →
  refuse (never reuse or kill what can't be proved ours); orphaned → **adopt**; down → start
  once, record state, supervise.
- **Adoption** is the cold-start win for every launch after an ungraceful one: when a launcher
  dies without stopping its engine (crash, kill -9, power), the engine keeps answering but its
  launcher is gone. `cmdStart` now probes before the blocker gate; an orphaned engine explains
  its port/lock blockers, `ensureResidentEngine` returns it as adopted, and
  `attachToResident` presents it to the rest of `cmdStart` in `startBackend`'s exact shape —
  ready already true, `exited` settling when the engine pid dies, and `stop()` mirroring
  `startBackend`'s stop (SIGTERM, 20 s, SIGKILL) against the recorded engine pid. Adoption
  transfers ownership: shutdown, the crash supervisor (which can relaunch fresh if the adopted
  engine dies), and the fail-closed paths all behave as for a spawned engine.
- **Clean shutdown** — `kingmaker stop` is rebuilt on `stopResidentEngine`: SIGTERM the
  launcher (whose own shutdown stops its engine), wait for actual exit through a 20 s grace,
  SIGKILL only past it, daemon state cleared only once the process is gone. The existing
  "only signal a process that is really Kingmaker" ps check is preserved as the injected
  `verify` — an unverified pid is never signalled.

### Deliberately NOT changed: `scripts/installer-plan.mjs`

The resident/startup logic ships inside `lib/`, which is already a payload part (payload.json is
generated at build time; the new modules ship automatically). Touching the installer plan would
change `planHash` for already-shipped releases to no benefit. A login-resident LaunchAgent in
the installer bundle — so the engine starts at login rather than first launch — is a Mac-side
follow-up, not part of this change.

## Measured here (this VM: Linux, Node v24.20.0, 2026-10-21)

One bench run (`node scripts/coldstart-bench.mjs`); expect run-to-run variance on a shared VM:

| Phase | Measured | Budget | |
|---|---|---|---|
| Process start | 34.5 ms (REAL) | 500 ms | ✓ within |
| Preflight | 30.1 ms (REAL) | 1000 ms | ✓ within |
| Engine spawn → listening | 334.8 ms (SIMULATED) | 3000 ms | ✓ within |
| Post-ready staging | 6 ms (SIMULATED) | 2000 ms | ✓ within |
| First reflex decision | 3.4 ms (REAL) | 150 ms | ✓ within |
| First token | 2.2 ms (SIMULATED) | 1000 ms | ✓ within |

What those labels mean, exactly:

- **process (REAL):** a fresh node child importing the 10 loadable startup modules. *Not*
  `lib/cli.mjs`'s full graph — this snapshot is partial (no `vendor/`, `core/`), so cli.mjs
  cannot be imported here at all. The Mac number is the real one.
- **preflight (REAL):** paths + payload check + port probe + resident probe (down), all real.
- **engine (SIMULATED):** the *real* `startBackend` spawning a fixture engine with a scripted
  250 ms boot: launcher mechanics (spawn, stream, ready-line match) measured ≈85 ms of the
  334.8 ms. The real engine's internal boot is not in this tree (kingmaker-os) — Mac-only.
- **post-ready (SIMULATED):** the hands-warm + rules-check calls, concurrent, against an
  instantly-answering mock. The call pattern is real; the engine's own hands start (≈2 s cold)
  is not in the number.
- **first-decision (REAL):** the real `DecisionRouter` round trip against an instantly-
  answering mock SystemOne. The reflex model's own forward pass is *not* in this number —
  the reflex pick's (tev1) published latency (100 ms) is a registry/vendor figure, quoted,
  never added.
- **first-token (SIMULATED):** a mock NDJSON stream — only the streaming mechanics are timed.
  No model exists on this machine to produce a token.
- Pre-warm behavior vs mock endpoints: a brain seat "loaded" in ≈35 ms, the reflex warmup
  answered in ≈5 ms — endpoint mechanics only, no weights exist here.

Verdict the harness itself prints: **not a proof of "instantaneous"** — 3 of 6 phases are
simulated and this is not the acceptance machine.

## Tests

`node --test --test-force-exit tests/*.test.mjs` — all suites green, zero regressions:

| Suite | Checks |
|---|---|
| coldstart (new) | 53 |
| release-gate | 11 |
| phase2 | 20 |
| promotion | 38 |
| issuance | 13 |

The new suite covers: the phase model and its labeling discipline (an unlabeled kind is
refused; a table with simulated rows is never "proven"); the load-body shape (mmap pinned,
keep_alive held); pre-warm outcomes against fake fetches (HTTP refusal and dead Ollama are
outcomes, never throws); seat dedupe; reflex warm against fake routers (transport failure is a
missed warm, with its reason); the staging plan (blocking = exactly the safety two; background
contents); background stages never throwing; resident probe states (ready / starting / down /
foreign / orphaned); ensure (reuse, start-once + state write + supervise, foreign refusal,
starting-wait, wedged refusal, adoption); stop (SIGTERM→gone, grace→exactly one SIGKILL,
unverified pid never signalled, stale state cleared); and a smoke run of the bench itself
asserting the fixture row is SIMULATED and the verdict refuses to call the run proven.

## What still needs the real 8 GB M3 Mac

This VM cannot prove the following. Each is a concrete run for Robbie:

1. **The real engine boot** — `startBackend` against the actual kingmaker-os headless server:
   spawn → listening, cold, on the 8 GB M3. Replaces the SIMULATED engine row.
2. **Real weight loads + real first token** — pull the seats (the reflex pick, tev1 at this
   registry revision, + the brain pins), run the
   bench beside the real Ollama: mmap load time per seat, and true time-to-first-token with
   and without the pre-warm (the pre-warm's whole claim is that the first turn pays ~0 load).
3. **The full process phase** — a fresh node child importing `lib/cli.mjs` itself in a complete
   checkout (vendor/ + core/ present). This snapshot cannot import it.
4. **The `cmdStart` wiring end-to-end** — the probe merge, the concurrent hands/rules, the
   background staging, and the `cold start: …` line at ready. cli.mjs cannot execute in this
   partial snapshot; the first real launch on the Mac is its smoke test. Check the voice log /
   debug output for `startup_stage` outcomes (reflex-warm and brain-warm ok) and the
   `cold_start` event rows.
5. **The reflex warmup against the real SystemOne** — `prewarmReflex`'s warmup question shape
   is best-effort against the router's documented schema; the engine's `/v1/systemone` schema
   could not be verified from this snapshot (the finish-build kingmaker-os copy carries no
   decision-router source). Confirm the warmup is answered (not rejected) by the real engine.
6. **Orphan adoption end-to-end** — launch, `kill -9` the launcher (not the engine), relaunch:
   the launch should adopt ("reusing the engine already running…"), the session should work,
   and `kingmaker stop` should then stop the adopted engine. Also confirm the hands line/warm
   on an adopted session on a Peekaboo Mac (an adopted handle re-detects the hands binaries
   but has no backend env, so an env-pinned hands choice falls back to defaults).
7. **`kingmaker stop` wait-for-exit** against a real running Kingmaker, including the
   not-Kingmaker stale-state path.
8. **The budgets themselves** — they were written for the 8 GB M3 class; the Mac runs above
   are what validate or revise them.
