---
name: kingmaker-proof-authoring
description: >-
  Write a new Kingmaker test in the repo's own pattern (test/<area>.test.mjs with node:test, pure functions from
  lib/, stand-ins for anything that reaches the Mac or the network) so an untested capability can be shown to work,
  and fails loudly when it breaks. Use when the owner asks to "write a test for X", "prove X works", "add a check for
  this bug", or when a README claim has no test behind it.
---

# Kingmaker proof authoring

A Kingmaker capability is "done" when a test asserts it and passes, and the test has been seen to fail when the
capability breaks. A test that can't fail proves nothing. This skill writes tests; `kingmaker-proof-runner` runs them.

## The house pattern

One file per area: `test/<area>.test.mjs`. `node --test test/*.test.mjs` picks up every such file, so a new one needs
no wiring. Read two neighbours first (`test/rrf.test.mjs` is short; `test/voice-authority.test.mjs` shows authority
checks) and match them.

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { theThing } from '../lib/<area>.mjs';

test('<the invariant, in plain words: what must always hold>', () => {
  const dir = mkdtempSync(join(tmpdir(), 'km-<area>-'));
  try {
    const opened = [];
    const r = theThing({ dir, open: (url) => opened.push(url) }); // a stand-in, never the real opener
    assert.equal(r.ok, true);
    assert.deepEqual(opened, [], 'a link in the answer text is never opened');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

The rules the existing tests follow:

- **Test pure functions.** Logic lives in `lib/` as exported functions that take their effects as arguments
  (`exec`, `open`, `fetch`, a clock, a folder). If the code you need to test reaches out directly, refactor it to
  take that dependency first.
- **Nothing real leaves the test.** No real URL is opened, no dialog appears, no real Keychain item, microphone,
  network call or message is touched, and nothing is written in the owner's data folder. Use a temporary folder and
  stand-ins, and record what they were asked to do so the test can assert it.
- **Name the invariant.** The test name says what must hold ("a tap, a silent hold, or a cancelled hold sends
  nothing"), so a failure explains itself.
- **Prove the negatives too.** What must never happen is often the point: a spoken "wake up" is never sent as a
  command, `kingmaker say` can never approve, a `file:` or `javascript:` link never opens, a secret never appears in
  output.
- **Skip honestly.** When a test needs something that may be absent (the engine's source, `ffmpeg`, macOS), pass
  `{ skip: '<why>' }` to `test()`. A skip is never a pass, and never written as one.

## Live proofs

For a check that must drive real pieces end to end (real models, real routes), follow `test/owner-keys.proof.mjs`:
a `test/<name>.proof.mjs` script that prints each check, exits 0 only when every check holds, 1 when one fails, and 2
with `SKIP <reason>` when it can't run. Give it a `proof:<name>` script in `package.json`. Keep its effects scratch-only
(a temporary runtime, a throwaway item it deletes at the end) and keep the stand-ins few and recorded.

## Checklist

1. Write the test next to its neighbours, in their style.
2. Run it: `node --test test/<area>.test.mjs`. See it pass.
3. Break the code it guards (flip a condition, remove a check), run it again, and see it fail with a clear message.
   Put the code back. A test you haven't seen fail isn't trusted yet.
4. Run the whole suite (`node --test test/*.test.mjs`) so nothing else broke.
5. If the test backs a README claim, hand the result to `kingmaker-readme-sync`, after you saw it pass.

## Don't

- Don't write a check that is always true, or that asserts a constant defined in the test itself.
- Don't loosen or delete a failing test to get a green run. Fix the code, or report the failure.
- Don't make a test depend on the network, a cloud brain's key, the owner's own files, or a running Kingmaker.
- Don't test the engine's internals from here. Its source is not in this repository; test what Kingmaker sends to it
  and does with what comes back.
- Don't commit anything a test leaves behind.
