import test from 'node:test';
import assert from 'node:assert/strict';
import { createOfferQuestion } from '../lib/voice.mjs';

const make = () => {
  const said = []; const ran = [];
  const q = createOfferQuestion({ say: async (l) => { said.push(l); } });
  q.set({ id: 'u', prompt: 'Update ready. Install it?', onYes: async () => { ran.push('yes'); return 'Updating now.'; }, onNo: async () => { ran.push('no'); return 'Okay.'; } });
  return { q, said, ran };
};

test('nothing installs until it was asked aloud and answered yes', async () => {
  const { q, said, ran } = make();
  assert.equal(await q.answer('yes'), false, 'a yes before the question is not consent');
  assert.deepEqual(ran, []);
  await q.ask();
  assert.equal(said[0], 'Update ready. Install it?');
  assert.equal(await q.answer('Yes, go ahead.'), true);
  assert.deepEqual(ran, ['yes']);
  assert.equal(said.at(-1), 'Updating now.');
  assert.equal(q.pending, null);
});

test('no clears it; anything else is a command and the question waits for the next wake', async () => {
  const a = make();
  await a.q.ask();
  assert.equal(await a.q.answer('what is the weather'), false);
  assert.deepEqual(a.ran, []);
  assert.ok(a.q.pending, 'still pending');
  assert.equal(await a.q.answer('yes'), false, 'not asked again yet: a later yes is not consent');
  await a.q.ask();
  assert.equal(await a.q.answer('not now'), true);
  assert.deepEqual(a.ran, ['no']);
  assert.equal(a.q.pending, null);
});

test("what's in it: hears an outcome summary, then is asked again; still no install without yes", async () => {
  const said = []; const ran = [];
  const { createOfferQuestion: mk } = await import('../lib/voice.mjs');
  const q = mk({ say: async (l) => { said.push(l); } });
  q.set({ id: 'u', prompt: 'Install?', details: 'Smarter answers.', reprompt: 'Install it now?', onYes: async () => { ran.push('yes'); } });
  await q.ask();
  assert.equal(await q.answer("what's in it"), true);
  assert.deepEqual(said.slice(-2), ['Smarter answers.', 'Install it now?']);
  assert.deepEqual(ran, []);
  assert.equal(await q.answer('yes'), true);
  assert.deepEqual(ran, ['yes']);
});

test('spoken notes: two sentences, 240 characters at most', async () => {
  const { spokenNotes } = await import('../lib/update.mjs');
  assert.equal(spokenNotes('One. Two. Three. Four.'), 'One. Two.');
  assert.ok(spokenNotes('word '.repeat(200)).length <= 240);
  assert.equal(spokenNotes(''), '');
});

test('barge-in: talking while the reply is still being prepared (nothing audible yet) interrupts', async () => {
  const { createBargeDetector } = await import('../lib/voice.mjs');
  const b = createBargeDetector();
  for (let i = 0; i < 10; i += 1) assert.equal(b.push(300, 100, false), false, 'quiet room, no sound yet');
  let fired = false;
  for (let i = 0; i < 4 && !fired; i += 1) fired = b.push(6000, 100, false);
  assert.equal(fired, true, 'his voice over the quiet room is a barge-in, not learned as echo');
});

test('barge-in: once sound plays, its own echo never interrupts but talking over it does', async () => {
  const { createBargeDetector } = await import('../lib/voice.mjs');
  const b = createBargeDetector();
  for (let i = 0; i < 10; i += 1) b.push(300, 100, false);
  for (let i = 0; i < 30; i += 1) assert.equal(b.push(1400, 100, true), false, 'echo of its own voice');
  let fired = false;
  for (let i = 0; i < 5 && !fired; i += 1) fired = b.push(6400, 100, true);
  assert.equal(fired, true);
});
