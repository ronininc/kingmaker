import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceIntent } from '../lib/device-desk.mjs';
import { ruleLane } from '../lib/fast-route.mjs';

test('capability questions are handled by the device desk before live web lookup', () => {
  for (const text of [
    'what can you do',
    'what can ya do right now',
    'What can you do for me?',
    'what can you do on this mac',
  ]) {
    assert.deepEqual(deviceIntent(text), { kind: 'tools' }, text);
  }
  // This documents the bug the desk interception prevents: "right now" alone is a live lookup cue.
  assert.equal(ruleLane('what can ya do right now'), 'lookup');
});
