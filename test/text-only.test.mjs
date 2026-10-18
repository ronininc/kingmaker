import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEXT_ONLY_MAX_GB, textOnlyFor, voicePlan } from '../lib/ring.mjs';

const GB = 2 ** 30;

test('auto (the default) is text only on an 8 GB-class Mac and voice on anything bigger', () => {
  assert.equal(textOnlyFor('auto', 8 * GB), true);
  assert.equal(textOnlyFor(undefined, 8 * GB), true, 'no choice is auto');
  assert.equal(textOnlyFor('auto', 16 * GB), false);
  assert.equal(textOnlyFor('auto', 24 * GB), false);
  assert.equal(TEXT_ONLY_MAX_GB, 10);
});

test('the owner\'s choice wins on any Mac', () => {
  assert.equal(textOnlyFor('text', 64 * GB), true, 'text only is optional on a bigger Mac');
  assert.equal(textOnlyFor('voice', 8 * GB), false, 'voice can still be turned on at 8 GB');
  assert.equal(textOnlyFor(' TEXT ', 32 * GB), true);
});

test('text only never listens', () => {
  assert.equal(voicePlan({ wantsVoice: false, agent: true, ring: null }).listening, false);
});
