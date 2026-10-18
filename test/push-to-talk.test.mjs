// Push-to-talk on fn (lib/voice.mjs createPushToTalk): the whole hold is one command, pauses included.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPushToTalk, SAMPLE_RATE } from '../lib/voice.mjs';

const chunk = (ms, level) => { const a = new Int16Array((SAMPLE_RATE / 1000) * ms); for (let i = 0; i < a.length; i += 1) a[i] = i % 2 ? level : -level; return Buffer.from(a.buffer); };

test('a hold with a pause in the middle is one utterance', () => {
  let t = 0;
  const p = createPushToTalk({ now: () => t });
  p.down();
  p.push(chunk(600, 4000)); p.push(chunk(1200, 20)); p.push(chunk(600, 4000));
  t = 2400;
  const u = p.up();
  assert.ok(u);
  assert.equal(u.samples.length, (SAMPLE_RATE / 1000) * 2400);
  assert.ok(u.speechMs >= 1100 && u.speechMs <= 1300, String(u.speechMs));
  assert.equal(p.held, false);
});

test('a tap, a silent hold, or a cancelled hold sends nothing', () => {
  let t = 0;
  const p = createPushToTalk({ now: () => t });
  p.down(); p.push(chunk(150, 4000)); t = 150; assert.equal(p.up(), null);
  p.down(); p.push(chunk(2000, 20)); t = 2150; assert.equal(p.up(), null);
  p.down(); p.push(chunk(1000, 4000)); p.cancel(); assert.equal(p.up(), null);
  p.push(chunk(500, 4000)); assert.equal(p.held, false, 'audio outside a hold is ignored');
});

test('a hold can be read so far without ending it (live dictation)', () => {
  let t = 0;
  const p = createPushToTalk({ now: () => t });
  p.down(); p.push(chunk(600, 4000));
  assert.equal(p.snapshot().length, (SAMPLE_RATE / 1000) * 600);
  p.push(chunk(400, 4000));
  assert.equal(p.snapshot().length, (SAMPLE_RATE / 1000) * 1000);
  assert.equal(p.held, true, 'reading the hold so far does not end it');
  t = 1000; assert.ok(p.up());
});
