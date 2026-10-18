---
name: kingmaker-voice-verification
description: >-
  Verify Kingmaker's voice end to end on a real Mac (wake, listen, transcribe with the bundled whisper, a governed
  turn, the spoken answer, barge-in, sleep) and decide truthfully whether voice can be called working. Use when the
  owner asks "does voice work", "test the voice", "verify the wake word", "can I trust the verified voice mode",
  or "can we say voice is done". Tests are necessary, not enough: voice is proven only by a person speaking to it.
---

# Kingmaker voice verification

Voice is how the owner drives Kingmaker, but passing tests isn't the same as a person speaking into a real microphone
and getting a governed spoken answer. This skill runs the tests, then the live checks, and reports voice as proven
only when both pass. The governing rule: voice changes how you ask, never what is allowed. Speaking can't skip a yes.

`kingmaker-proof-runner` runs the tests; `kingmaker-readme-sync` records the result.

## The loop being verified

```
microphone (sox or ffmpeg) → endpointing → bundled whisper.cpp → the turn (with its authority)
  → Kingmaker's engine → the answer, spoken (Kokoro, else the Mac's own voice) → barge-in stops it
```

The code is in `lib/voice.mjs` (the loop), `lib/owner-voice.mjs` (the verified mode), `lib/session.mjs` (what each
voice mode may do), `lib/voice-ledger.mjs` (one line per spoken turn: lengths, never words) and `lib/lang.mjs` (the
answer in the language you spoke). README.md's "Voice" and "Verified voice (opt-in)" sections describe the behaviour.

## Layer 1: tests

```bash
node --test test/voice-authority.test.mjs test/push-to-talk.test.mjs test/transcript-line.test.mjs \
  test/text-only.test.mjs test/lang.test.mjs test/self-check.test.mjs test/owner-voice.test.mjs \
  test/phone-voice.test.mjs test/interaction-owner.test.mjs
```

They cover: the wake phrase alone never runs anything; "wake up" while awake is answered locally; under `propose`
a spoken turn carries no authority; a tap or silent hold sends nothing; speech heard while asleep never reaches the
transcript line; text only on an 8 GB-class Mac by default; the voiceprint's seal fails closed. Some `owner-voice`
tests skip without the engine's owner-voice modules: report them `SKIP`.

`npm run proof:owner-voice` drives real models and the engine's own authority code. It needs the engine's source, which is
not in this repository; from a public checkout it exits 2 (SKIP). Report it `UNVERIFIED (needs the engine's source)`.

## Layer 2: a person at the microphone

1. `kingmaker doctor`: whisper and its model, the microphone tool, the wake word (and whether it is cemented), the
   voice authority mode. Any ✗ there blocks the rest.
2. `kingmaker speak`: you hear the reply voice.
3. `kingmaker start` (the first time, macOS asks to let Terminal use the microphone). It starts asleep with the
   microphone off.
4. Wake it: click the logo, `kingmaker wake`, or "Hey Siri, wake Kingmaker". It says it's here.
5. Ask something harmless. The words appear, the logo shows it working, and the answer is spoken.
6. Ask for something that changes a thing (for example, to create a note). It waits for your word; nothing happens
   until you say yes. A RED action asks for its challenge words ("confirm <words>").
7. Talk over an answer: it stops.
8. "That's all": it sleeps. Speech while asleep is not answered and not written down.
9. Read `logs/voice.log` in the data folder: each decision is there (woke, slept, the command sent); nothing heard
   while asleep, only its length.
10. If the owner uses the verified mode: `kingmaker enroll` (typed, with Kingmaker quit), `kingmaker voice verified`,
    then "yes, go ahead" in your voice approves; another voice saying it does not.

Record it as evidence (screen and audio, see `kingmaker-engine-verifier`). A step that couldn't be done is
`NOT_CAPTURED` or `UNSUPPORTED`, said honestly.

## Report

Two parts: (a) the test results, with each skip named; (b) the live checklist, step by step, with the recording's
sha256. Then one line: `VOICE: PROVEN (tests + live, evidence <sha256>)` or `VOICE: NOT PROVEN (<the step that
failed or wasn't done>)`. Never the first without the live run.

## Known gaps to keep honest

README.md says mic capture is not live-tested there, and the verified mode is proven on synthetic `say` voices, not
yet on the owner's own voice. A live run on this Mac changes what is true for this Mac; update the README only through
`kingmaker-readme-sync`, with the evidence.

## When a check fails

- No microphone, or the permission not granted: `UNSUPPORTED` on this Mac, not a code failure.
- Whisper or its model missing: `kingmaker doctor` names the fix (the app's voice runtime).
- A spoken yes approving something from another program, or anything running without a yes: a real bug. Read the
  failing test or `lib/session.mjs`, report the exact line, and never paper over it.
