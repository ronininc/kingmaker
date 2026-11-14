import test from 'node:test';
import { readFileSync } from 'node:fs';
const evidence = JSON.parse(readFileSync(new URL('./fixtures/foreground-nightly-misassociation.json', import.meta.url)));
import assert from 'node:assert/strict';
import { barEvent, createBarTurnQueue } from '../lib/bar-events.mjs';

test('overnight output cannot inherit a queued foreground request; completion follows all answer lines', async () => {
  const frames = [], write = (e) => frames.push(JSON.parse(JSON.stringify(e)));
  const work = { queued: 0, running: 0 }, queue = createBarTurnQueue({ write, work });
  let release, releaseLate, late;
  const lateGate = new Promise(r => { releaseLate = r; });
  const gate = new Promise(r => { release = r; });
  const first = queue(async () => {
    write(barEvent({ said: '1. Zero local generated tokens fails.' }));
    await gate;
    write(barEvent({ said: '2. Zero locally completed jobs fails.' }));
    late = lateGate.then(() => write(barEvent({ said: 'late callback' })));
  }, 'A');
  const second = queue(async () => write(barEvent({ said: 'Second answer' })), 'B');
  await Promise.resolve();
  write(barEvent({ said: evidence.unrelatedOutputExcerpt }));
  assert.deepEqual(work, { queued: 1, running: 1 });
  assert.equal(frames.at(-1).requestId, null);
  assert.equal(frames.some(e => e.turnComplete), false);
  release(); await Promise.all([first, second]); releaseLate(); await late;
  assert.deepEqual(frames.filter(e=>e.requestId).map(e=>[e.requestId,!!e.turnComplete]), [['A',false],['A',false],['A',true],['B',false],['B',true]]);
  assert.equal(frames.at(-1).requestId, null);
  assert.deepEqual(work, { queued: 0, running: 0 });
});
test('failed and invalid requests cannot poison the queue or forge completion IDs', async () => {
  const frames = [], queue = createBarTurnQueue({ write: e=>frames.push(e) });
  await assert.rejects(queue(async () => { throw Error('synthetic'); }, 'C'));
  await queue(async () => frames.push(barEvent({ said: 'after error' })), 'D');
  await queue(async () => {}, 'invalid\nID');
  assert.deepEqual(frames.map(e=>e.requestId), ['C','D','D']);
});
