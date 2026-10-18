---
name: kingmaker-engine-verifier
description: >-
  Verify each part of Kingmaker on a real Mac (the runtime, voice, verified owner voice, hands, brains, web
  research sources, connectors and REA, ArtCraft, markets, the MCP surface) with its tests, a hands-on checklist,
  and a screen recording with audio as evidence. Use when the owner asks to "verify everything works", "sign off
  voice", "record proof that X works", "check Kingmaker end to end", or wants evidence beyond green tests.
---

# Kingmaker engine verifier

A passing test shows the code keeps an invariant. It doesn't show the owner that Kingmaker works on their Mac: that
it wakes, hears, answers, waits for a yes, and drives the app. This skill pairs each part's tests with a checklist
done live, captured in one screen recording with audio, so the claim is something watched and heard.

`kingmaker-proof-runner` runs the tests, `kingmaker-voice-verification` and `kingmaker-native-internet` carry the
deep checks for voice and the network, and `kingmaker-readme-sync` records the outcome.

## How to use it

1. Pick the part. Read its checklist in `references/engine-checklists.md`.
2. Run its tests (`node --test test/<name>.test.mjs`) and `kingmaker doctor`. Write down the real results.
3. Start a screen recording with audio (`references/av-capture.md`). Do the checklist live, saying each step out
   loud. For voice, the audio is the evidence.
4. Stop, hash the file, and write its evidence record.
5. Give the verdict. A part is VERIFIED only when its tests pass, every checklist step passed on the recording, and
   the recording exists with real audio (capture state `CAPTURED`).

Parts that run inside Kingmaker's engine (its research, planning and memory engines) ship compiled in Kingmaker.app.
Verify them through Kingmaker's own surface: a turn at the console, a spoken turn, or `kingmaker say`. Their own
internal tests are not in this repository.

## The recording

- **What it shows:** the screen during the whole checklist, with a live audio track: you narrating each step, and
  for voice, the spoken request and Kingmaker's spoken answer.
- **One take.** Every checklist step, start to finish, uncut.
- **Where it goes:** a folder outside the repository (for example `~/Movies/kingmaker-evidence/<part>/`). Never
  commit it.
- **Your own capture.** Kingmaker's voice never writes audio to disk; this recording is the owner's deliberate
  evidence. Don't record other people without their agreement, and don't show keys or private messages on screen.
- **Evidence record:** `{part, file, sha256, durationSec, captureState, capturedAt, checklistStepsShown[]}` beside
  the file.

Capture states: `CAPTURED` (real recording with audio, shows the checklist), `NOT_CAPTURED` (none made: the part is
UNVERIFIED whatever its tests say), `FAILED` (no audio, empty or cut short: redo it), `UNSUPPORTED` (this Mac can't
record, for example no Screen Recording permission: the part is DEFERRED for evidence, said plainly).

## Parts covered

1. Runtime (start, status, stop, one runtime per data folder)
2. Voice (wake, listen, answer, sleep, barge-in)
3. Verified owner voice (enroll, verified mode, another voice refused)
4. Authority and approvals (what each source can do; the yes; RED's challenge words; the kill switch)
5. Hands (driving a Mac app; one yes presses one thing)
6. Brains (local model and the cloud CLIs; what leaves the Mac)
7. Web research sources and evidence windows
8. Connectors and REA
9. ArtCraft apps
10. Markets (research only)
11. MCP surface (propose only, no approve tool)

## Report

```
PART                 TESTS                         CHECKLIST   RECORDING              VERDICT
Voice                voice-authority, push-to-talk  PASS        CAPTURED (sha256 …)   VERIFIED
Verified owner voice owner-voice (SKIP: no modules) PASS        CAPTURED (sha256 …)   VERIFIED live; test SKIP noted
Hands                hands, menu-click              FAIL step 3 CAPTURED (sha256 …)   FAIL (Notes button not found)
ArtCraft             artcraft                       not run     NOT_CAPTURED           UNVERIFIED
```

Then one honest line, e.g. `PARTS VERIFIED: 7/11 (ArtCraft not run; Hands FAIL at step 3; …)`.

## The rule

Green tests with no recording: UNVERIFIED. A recording with no audio: FAILED. A recording that skips a step doesn't
verify that step. Anything less than all three gets the honest lower status, and that is a correct result.
