---
name: kingmaker-proof-runner
description: >-
  Run Kingmaker's test suite and live checks and report what they really said: pass, fail, skipped or not run.
  Use when the owner asks "run the tests", "is X proven", "does Kingmaker pass", "check readiness", "why is this
  test failing", or before a README or status line is changed. A skipped test is never reported as a pass, and a
  result nobody ran this session is UNVERIFIED.
---

# Kingmaker proof runner

A claim about Kingmaker is true only when a test or a live check showed it this session. This skill runs them in
the right order and reports their real output. It never guesses, rounds up or softens a result.

The map from each part of Kingmaker to its tests and live checks is in `references/proof-taxonomy.md`.

## The rule

Report a result only from output you saw this session. Not run: `UNVERIFIED`. Ran and failed: `FAIL`. Skipped:
`SKIP`, with the reason the test printed. A made-up or rounded-up pass is the worst outcome, worse than reporting
that something is still broken.

## Setup

Node 22 or newer (`node -v`). The suite has no npm dependencies, so a fresh clone needs no install step.

The live checks need an installed Kingmaker.app. Its command line is inside the app:
`"/Applications/Kingmaker.app/Contents/Resources/sol-ghost/bin/kingmaker"` (or `~/Applications/...` when the
installer put it there). A git checkout's `bin/kingmaker` has no runtime of its own; it borrows an installed
Kingmaker.app's engine. Below, `kingmaker` means whichever one you have.

## How to run

1. **The whole suite:** `node --test test/*.test.mjs` (the same as `npm test`).
2. **One area:** `node --test test/<name>.test.mjs`. One test by name:
   `node --test --test-name-pattern "<part of its name>" test/<name>.test.mjs`.
3. **Live state on this Mac:** `kingmaker doctor` (every piece it needs, with a ✓ or ✗ and the fix) and
   `kingmaker status` (is the runtime up, its process tree's memory, proposals waiting).
4. **The two live proofs** (`npm run proof:owner-voice`, `npm run proof:owner-keys`) drive the engine's own source,
   which is not in this repository. Without it they exit 2 and print `SKIP`. Report them `UNVERIFIED (needs
   the engine's source)`, never as a pass.

## Reading the output

- Node prints a summary at the end (`ℹ tests`, `ℹ pass`, `ℹ fail`, `ℹ cancelled`, `ℹ skipped`, `ℹ todo`; with
  `--test-reporter=tap` the same counts as `# pass`, `# fail`, `# skipped`). Quote those counts. The whole suite
  takes a minute or two.
- Some tests skip on purpose when something is missing: `test/engine-wiring.test.mjs` without the engine's source,
  `test/owner-voice.test.mjs` without the engine's owner-voice modules. A skip proves
  nothing. List each skipped test and its reason.
- `kingmaker doctor`: each ✗ row is a missing piece with its fix on the next line. A ✗ is a finding, not a test
  failure in the repo.
- If output is ambiguous (cut off, timed out, no summary), the result is `UNVERIFIED`. Say why.

## Status words

`PASS`, `FAIL`, `SKIP (<reason>)`, `UNVERIFIED (<reason>)`, `DEFERRED (<reason>)` for something not built yet, and
`CONFIG-HOLD (<what>)` for something blocked only on setup (a key, a sign-in, a permission), not on code.

## Not tests: these change things

Running tests and `kingmaker doctor` or `kingmaker status` only reads. These act, so each needs the owner's explicit
yes first, with what it will do said plainly:

- `kingmaker installer install …`, `kingmaker craft install`, `kingmaker markets install`, `kingmaker update`
- `kingmaker background enable|disable`, `kingmaker siri`, `kingmaker chrome`, `kingmaker enroll`
- the build scripts under `scripts/` (they write to `dist/` and some need Ronin's signing tools)
- any `git commit`, `git push` or pull request

## Report

One row per thing you actually ran:

```
AREA                 CHECK                                   RESULT
Voice authority      node --test test/voice-authority.test.mjs   PASS (<n>/<n>)
Engine wiring        node --test test/engine-wiring.test.mjs     SKIP (engine source not imported)
Owner voice, live    npm run proof:owner-voice                   UNVERIFIED (needs the engine's source)
This Mac             kingmaker doctor                            FAIL (✗ Ollama answering on :11434)
```

Then one honest line, e.g. `SUITE: <n> pass, 0 fail, <n> skipped (each named); doctor: 1 ✗ (Ollama not running)`. For a
failure, quote the failing assertion and the file and line, so the next person can act on it.

## A failing test

Read the test to see what it asserts, then trace it into `lib/`. Report the assertion that failed and the smallest
true statement about why. Never make a test pass by loosening its assertion or deleting it: fix the code, or report
the failure.
