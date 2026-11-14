// The prompt-time weight hunter (lib/weight-hunter.mjs): the owner's override lane over the Brain
// Library. Since the metered-doctrine rework (2026-11-14) it scores models on measurements from ANY
// device — no memory class is consulted — and size never gates: it only orders ties.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { beforeModelSelection, classifyTask, huntWeights, scoreLibraryModels, weightHunterEnabled } from '../lib/weight-hunter.mjs';
import { defaults } from '../lib/calibration.mjs';

const measured = (file, tokS, holdsGb, scores = {}) => ({
  file, fits: true, tokS, holdsGb, tools: scores.tools ?? 90, route: scores.route ?? 90, write: scores.write ?? 90,
});

function library() {
  return {
    floor: { roles: { writer: 'slow-writer', coder: 'huihui_ai/qwen2.5-coder-abliterate:1.5b', reasoning: 'slow-writer', vision: 'vision-small' } },
    models: [
      { tag: 'slow-writer', slug: 'slow-writer', kind: 'abliterated', roles: ['writer'], picks: [{ role: 'writer' }], bench: [measured('m3.json', 30, 2.4, { tools: 70, route: 70, write: 70 })], weights: { sha256: 'a'.repeat(64), parts: [{ name: 'a', size: 1 }] } },
      { tag: 'fast-writer', slug: 'fast-writer', kind: 'abliterated', roles: ['writer'], picks: [], bench: [measured('m3.json', 80, 2.2, { tools: 95, route: 95, write: 95 })], weights: { sha256: 'b'.repeat(64), parts: [{ name: 'b', size: 1 }] } },
      { tag: 'huihui_ai/qwen2.5-coder-abliterate:1.5b', slug: 'coder-small', kind: 'abliterated', roles: ['coder'], picks: [{ role: 'coder' }], bench: [measured('m3.json', 40, 1.2)], weights: { sha256: 'c'.repeat(64), parts: [{ name: 'c', size: 1 }] } },
      { tag: 'huihui_ai/qwen2.5-coder-abliterate:7b', slug: 'coder-big', kind: 'abliterated', roles: ['coder'], picks: [], bench: [measured('m3.json', 50, 6.4)], weights: { sha256: 'd'.repeat(64), parts: [{ name: 'd', size: 1 }] } },
      { tag: 'too-slow-coder', slug: 'too-slow', kind: 'abliterated', roles: ['coder'], picks: [], bench: [measured('m3.json', 5, 1)], weights: { sha256: 'e'.repeat(64), parts: [{ name: 'e', size: 1 }] } },
      { tag: 'vision-small', slug: 'vision-small', kind: 'abliterated', capabilities: ['vision'], roles: ['vision'], picks: [{ role: 'vision' }], bench: [measured('m3.json', 30, 2)], weights: { sha256: 'f'.repeat(64), parts: [{ name: 'f', size: 1 }] } },
    ],
  };
}

test('tasks are classified, and governed requests are not taken from the lanes', () => {
  assert.equal(classifyTask('draft a note about the garden'), 'writer');
  assert.equal(classifyTask('fix the python bug in this function'), 'coder');
  assert.equal(classifyTask('prove this step by step'), 'reasoning');
  assert.equal(classifyTask('what is in this screenshot'), 'vision');
  assert.equal(classifyTask('send the invoice to Ada'), null);
  assert.equal(classifyTask('draw a logo of a crane'), null);
  assert.equal(classifyTask('write the summary, then email it to Ada'), 'writer');
});

test('the hunter scores on measurement and the role speed floor, and prefers installed only as a tie', () => {
  const lib = library();
  const best = huntWeights({ text: 'draft a note', library: lib, installed: ['slow-writer'], cached: [] });
  assert.equal(best.tag, 'fast-writer');
  assert.equal(best.availability, 'fetch');
  assert.equal(best.swap, false);
  const tied = huntWeights({
    text: 'draft a note',
    library: { ...lib, models: lib.models.filter((model) => model.tag.endsWith('writer')).map((model) => model.tag === 'fast-writer' ? { ...model, bench: lib.models[0].bench } : model) },
    installed: ['slow-writer'],
    cached: ['fast-writer'],
  });
  assert.equal(tied.tag, 'slow-writer');
  assert.equal(tied.availability, 'installed');
  const coder = huntWeights({ text: 'debug this python script', library: lib, installed: [], cached: ['huihui_ai/qwen2.5-coder-abliterate:1.5b'] });
  assert.equal(coder.tag, 'huihui_ai/qwen2.5-coder-abliterate:1.5b');
  assert.equal(coder.availability, 'cached');
  assert.equal(huntWeights({ text: 'send the invoice', library: lib }), null);
});

test('a model measured on any device is measured here; an unmeasured floor pick scores 0 and loses to any measurement', () => {
  const lib = library();
  lib.models.push({ tag: 'elsewhere-writer', slug: 'elsewhere-writer', kind: 'abliterated', roles: ['writer'], picks: [], bench: [measured('m5-pro.json', 45, 3, { tools: 80, route: 80, write: 80 })], weights: { sha256: '9'.repeat(64), parts: [{ name: '9', size: 1 }] } });
  const scored = scoreLibraryModels(lib, 'writer');
  assert.ok(scored.find((s) => s.model.tag === 'elsewhere-writer')?.measured, 'a bench file from another device counts');
  const unmeasured = { floor: { roles: { writer: 'ghost-writer' } }, models: [{ tag: 'ghost-writer', slug: 'ghost-writer', kind: 'abliterated', roles: ['writer'], picks: [{ role: 'writer' }], bench: [], weights: { sha256: '8'.repeat(64), parts: [{ name: '8', size: 1 }] } }] };
  const ghost = scoreLibraryModels(unmeasured, 'writer');
  assert.equal(ghost.length, 1);
  assert.equal(ghost[0].score, 0);
  assert.equal(ghost[0].measured, false);
});

test('the calibration switch defaults off, and Kingmaker x Heretic enables the hunter', async () => {
  const off = defaults();
  assert.equal(off.weightHunter.on, false);
  assert.equal(weightHunterEnabled(off), false);
  const on = { ...off, weightHunter: { on: true } };
  assert.equal(weightHunterEnabled(on), true);
  const heretic = { ...off, router: { ...off.router, governanceSpine: 'kingmaker-x-heretic' } };
  assert.equal(weightHunterEnabled(heretic), true);
  let ensured = 0;
  const skipped = await beforeModelSelection({ text: 'draft a note', calibration: off, profileModel: 'profile-writer', library: library(), ensure: async () => { ensured += 1; } });
  assert.equal(skipped.hunted, false);
  assert.equal(skipped.model, 'profile-writer');
  assert.equal(ensured, 0);
  const fetched = await beforeModelSelection({ text: 'draft a note', calibration: on, profileModel: 'profile-writer', library: library(), ensure: async () => { ensured += 1; } });
  assert.equal(fetched.hunted, true);
  assert.equal(fetched.model, 'fast-writer');
  assert.equal(fetched.swap, false);
  assert.equal(ensured, 1);
  const installed = await beforeModelSelection({ text: 'draft a note', calibration: heretic, profileModel: 'profile-writer', library: library(), installed: ['fast-writer'], ensure: async () => { ensured += 1; } });
  assert.equal(installed.model, 'fast-writer');
  assert.equal(installed.availability, 'installed');
  assert.equal(ensured, 1);
});

test('the execution loop asks the hunter before the selector, and the prompt lane does too', () => {
  const loop = readFileSync(new URL('../lib/execution-loop.mjs', import.meta.url), 'utf8');
  const pick = loop.slice(loop.indexOf('export async function resolveWeightsPick'), loop.indexOf('export function createExecutionLoop'));
  assert.ok(pick.indexOf('beforeWeights') < pick.indexOf('pickSmallestSufficient(records'));
  assert.match(loop, /resolveWeightsPick\(records, \{ requirement: req, device, request, beforeWeights \}\)/);
  const source = readFileSync(new URL('../lib/cli.mjs', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('const fastLane = async'), source.indexOf('const selfCheck'));
  assert.ok(body.includes('chooseTaskModel'));
  assert.ok(body.indexOf('chooseTaskModel') < body.indexOf('writerModel(pin)'));
  assert.match(source, /chooseTaskModel[\s\S]{0,2500}beforeModelSelection/);
  assert.match(source, /resetTaskChoice\(\);\s*const kind = classifyLine\(text\)/);
});
