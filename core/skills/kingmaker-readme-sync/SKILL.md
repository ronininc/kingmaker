---
name: kingmaker-readme-sync
description: >-
  Keep Kingmaker's README.md, docs/*.md and the command list at the top of lib/cli.mjs truthful: every status
  line, "Known gaps" entry, measured number and command row matches what the code does and what tests and live
  checks showed this session. Use when the owner asks to "update the README", "sync the docs", "mark X as done",
  "refresh the known gaps", or after a change adds, renames or removes a command.
---

# Kingmaker README and status sync

Kingmaker's README is the product's honest description of itself, not sales copy. Its command table, "Measured on…"
table and "Known gaps (v0.1, honest)" section are claims, and each must match what is true. This skill turns real
results into careful edits. For prose that isn't status, use `kingmaker-doc-author`; to get the results, use
`kingmaker-proof-runner` first.

## The rule

Write a positive claim (works, tested, proven, measured) only when a test or live check backed it this session and
you saw it. Otherwise keep it as a known gap, or say plainly what is unproven. When unsure, mark it down, not up.

## What has to agree

- **Commands.** Every command in the README's table and in the usage block at the top of `lib/cli.mjs` exists in
  that file's `main()` switch, with the same flags. A command added, renamed or removed changes both places.
- **Version.** `package.json`'s `version` is what `kingmaker version` prints. Don't write a version the code doesn't
  carry.
- **Numbers.** A measured figure keeps its machine and date. A new figure needs a new measurement, dated; never copy
  an old number onto a new claim.
- **Known gaps.** A gap is removed only when a check closed it this session. Otherwise reword it to say exactly
  what remains. Current examples worth keeping honest: mic capture not live-tested, the verified voice mode proven
  on synthetic voices rather than the owner's own, the app not notarized.
- **Docs pages.** A page in `docs/` that describes the same thing as the README must not disagree with it. Resolve
  a disagreement against the code and a real run, not by picking the nicer sentence.
- **Skill descriptions.** A core skill's `description:` must not promise a command or behaviour that doesn't exist.

## Workflow

1. **Get the real state.** Run the relevant tests and live checks (`kingmaker-proof-runner`). Never edit status from
   memory.
2. **Map each claim to its check.** `kingmaker-proof-runner/references/proof-taxonomy.md` lists the tests and live
   checks per area. A claim with no check behind it is unproven: say so, or write the test
   (`kingmaker-proof-authoring`).
3. **Edit only what changed.** Keep the README's order, headings and voice.
4. **Re-read the section** and check every positive sentence against something you saw pass.

## Status words

Plain words first ("tested", "not live-tested yet", "proven on synthetic voices", "off by default", "needs your
yes"). Where a status column is used: `PASS`, `FAIL`, `SKIP`, `UNVERIFIED`, `DEFERRED`, `CONFIG-HOLD`. A deferred item
with a clear reason is a correct, finished state.

## Examples

- `node --test test/push-to-talk.test.mjs` passed, and a live hold-to-talk on this Mac worked: the README may
  describe push to talk as working. If only the test ran, describe the logic as tested and leave live use unproven.
- `kingmaker doctor` shows ✗ for the microphone tool on this Mac: that is this Mac's setup, not a README change.
  Don't write "voice works" from a Mac where it didn't run.
- `npm run proof:owner-voice` printed SKIP (no engine source here): the README's gap "proven on synthetic voices,
  not yet on your own" stays exactly as it is.
- A command was removed from `lib/cli.mjs`: remove its README row and its usage line in the same change.

## Before you finish

Read the edited section top to bottom. Every positive claim needs a check you saw pass. If one doesn't have it, mark
it down. A README that lists its real gaps is complete; one that reads finished but overstates is a failure.
