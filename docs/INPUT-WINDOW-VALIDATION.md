# Input-window fix and validation

Source base: `fb31a234375d07f9ee5c241361ec510e6af92e29` (includes PR #103).
This work is isolated on `codex/app-reopen-input`; PRs #104 and #105 are unchanged.

## Diagnosis and change

`GhostApp.applicationShouldHandleReopen` previously showed the composer only in
window mode and only when macOS reported no visible app windows. An explicit reopen
in bar mode therefore did nothing; another visible window could also prevent the
composer from appearing. The handler now calls `bar.show()` unconditionally. It
shows rather than toggles, so repeated reopens cannot hide the composer.

This fixes handling of a delivered reopen event. It does not prove that Launch
Services delivers that event to the installed build or explain every computer-control
timeout. No cold-launch behavior, model selection, permissions, engine startup,
production bundle, or input protocol is changed.

The source input path is `sendTurn` → base64 JSON → app `onTurn` → `toCli` →
`typed-turn` → CLI `queueTurn`. A failed app-selection tool call does not establish
that this input protocol or the inference engine is broken.

## Isolated fixture

`node scripts/check-input-window.mjs --build-only` builds:

`dist/input-window-fixture/Kingmaker Input Fixture.app`

The fixture has a distinct bundle identifier, a normal titled window, an inert
input callback, and no URL handler. It extracts the production reopen and `sendTurn`
methods into a small AppKit harness. It starts no engine or model server, reads no
production state or credentials, and performs no network calls. Opening it runs
the assertions and displays the inert window for at most three minutes. Its
Validate input button displays decoded framing only, not an inference result.

`node scripts/check-input-window.mjs` builds and runs assertions, with a 30-second
execution timeout. A macOS desktop session is required for AppKit. Do not retry a
denied desktop-session operation or assume granting new permissions is required.

## Observed checks

- Fixture compiled successfully with its module cache under this worktree.
- Engine-free assertions passed in the desktop session: reopen requests with and
  without other visible windows call show; UTF-8 and embedded newlines remain one
  JSON payload; input while busy queues exactly once rather than invoking the callback.
- The final bundled fixture's `--self-test` invocation also returned that PASS result.
- Full `app/Kingmaker.swift` typecheck passed. It emitted an existing capture-ownership
  warning around the unrelated Automation permission callback (line 2458).
- `node --check scripts/check-input-window.mjs` and `git diff --check` passed.

The restricted shell could not reach macOS window services: the first fixture run
reported `com.apple.hiservices-xpcservice` connection invalid; another exited 134.
These are distinct from the successful desktop-session assertion run. Computer
control's attempt to open the fixture ended with `node_repl kernel exited
unexpectedly` / `signal=9`. Visual reachability and mouse-driven submission have
therefore not been verified, and the fixture is not a full production-app test.

## Remaining runtime proof

Use a functioning UI controller to deliver an explicit reopen to a patched isolated
app shell, without launching another engine or replacing production. The inert
fixture can establish UI reachability first. Connecting a new shell to production
would require a supported authenticated bridge; this fixture supplies no bypass.

For a useful real task, prefer the existing installed app's typed-turn queue with
the existing configured model picks. Example supplied text: “Summarize these test
requirements in six bullets: zero local tokens fails; zero completed jobs fails;
missing telemetry is unknown; truncated output fails; cloud fallback is not local;
unload recovery needs measurement. Answer only from this text.” Validate its answer
against those six requirements and correlate its time window with provider receipts.
Do not infer completion from historical counters, residency, or GPU use alone.

Calling `routeLane` and `localModelTurn` from a separate harness would exercise
production helpers but would bypass the installed app's queue; it must be labeled
a helper integration trial, not a production job or complete five-lane soak. It
also needs safe admission against competing work. No such inference was run here.

The smallest outstanding requirement is functioning desktop-session UI control for
the isolated fixture and existing production composer. No new consent or pairing
is assumed. Full unload/recovery validation still needs its separate exclusive window.
