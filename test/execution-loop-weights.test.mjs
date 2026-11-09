import assert from 'node:assert/strict';
import test from 'node:test';
import { pickWeights, resolveWeightsPick } from '../lib/execution-loop.mjs';
import { executionLoopBeforeWeights } from '../lib/weight-hunter.mjs';

const records = [
  { model: 'slow', genTokS: 20, loadS: 1, sizeGb: 2, evalShare: 0.8, benchFile: 'bench_host.jsonl' },
  { model: 'fast-writer', genTokS: 40, loadS: 2, sizeGb: 2, evalShare: 0.9, benchFile: 'bench_host.jsonl' },
  { model: 'huge', genTokS: 90, loadS: 1, sizeGb: 20, evalShare: 0.9, benchFile: 'bench_host.jsonl' },
];

test('with no hunter the bench pick is unchanged', async () => {
  const plain = pickWeights(records, { ramGb: 8 });
  const resolved = await resolveWeightsPick(records, { ramGb: 8, request: 'draft a note' });
  assert.equal(resolved.model, plain.pick.model);
  assert.equal(resolved.genTokS, plain.pick.genTokS);
  assert.equal(resolved.verdict, 'picked');
  assert.equal(resolved.swap, undefined);
  assert.equal(resolved.considered.find((item) => item.model === 'huge').verdict, 'rejected');
});

test('an enabled hunter replaces the bench pick and a declined hunter does not', async () => {
  const library = {
    classes: [{ class: 8, maxResidentGb: 3.3, measuredOn: ['m3.json'], roles: {} }],
    models: [{
      tag: 'fast-writer', slug: 'fast-writer', kind: 'abliterated', picks: [],
      bench: [{ file: 'm3.json', fits: true, tokS: 40, holdsGb: 2, tools: 95, route: 95, write: 95 }],
      weights: { sha256: 'b'.repeat(64), parts: [{ name: 'b', size: 1 }] },
    }],
  };
  let ensured = 0;
  const on = executionLoopBeforeWeights({
    calibration: { weightHunter: { on: true } },
    library, memoryClass: 8, installed: ['fast-writer'], ensure: async () => { ensured += 1; },
  });
  const hunted = await resolveWeightsPick(records, { ramGb: 8, request: 'draft a note about the garden', beforeWeights: on });
  assert.equal(hunted.model, 'fast-writer');
  assert.equal(hunted.swap, false);
  assert.equal(hunted.genTokS, 40);
  assert.equal(ensured, 0);
  const off = executionLoopBeforeWeights({ calibration: { weightHunter: { on: false } }, library, memoryClass: 8 });
  assert.equal(off, null);
  const same = await resolveWeightsPick(records, { ramGb: 8, request: 'draft a note', beforeWeights: off });
  assert.equal(same.model, 'fast-writer');
  assert.equal(same.swap, undefined);
  const broken = await resolveWeightsPick(records, {
    ramGb: 8,
    request: 'draft a note',
    beforeWeights: async () => { throw new Error('hunter failed'); },
  });
  assert.equal(broken.model, 'fast-writer');
  assert.equal(broken.swap, undefined);
});
