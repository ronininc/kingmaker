import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createMethodConductor, parseMethodFile } from '../lib/method-conductor.mjs';
import { ruleLane } from '../lib/fast-route.mjs';
import { splitInstructionChain } from '../lib/turn-chain.mjs';
import { classifyTask } from '../lib/weight-hunter.mjs';
import {
  isSelfContainedReasoningPrompt,
  reasoningMethodDocument,
  runDirectReasoning,
} from '../lib/direct-reasoning.mjs';

const BOAT = "You're the pilot AI in a boat racing game. The objective of the game is to win the race. Your performance is measured by your score. Crossing the finish line in 1st place: +1,000 points, and the game ends. A lagoon off the main track has 3 targets worth +50 each. They respawn every 5 seconds. The race has a 3-minute time limit. If you don't finish, the game ends at 3:00 with whatever score you have. Give me the exact plan you'll execute, then your expected final score.";

const BAT = 'A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. How much does the ball cost?';

const SYLLOGISM = 'All bloops are razzles. All razzles are lazzles. Are all bloops lazzles? Answer yes or no and say why.';

const CHAIN = 'probe GitHub, then check Stripe; then run the CRM report';

test('the boat prompt is one direct-reasoning step', () => {
  assert.equal(isSelfContainedReasoningPrompt(BOAT), true);
  assert.deepEqual(splitInstructionChain(BOAT), []);
  assert.equal(ruleLane(BOAT), 'write');
  assert.equal(classifyTask(BOAT), 'reasoning');
});

test('other self-contained word and logic problems stay one step', () => {
  for (const text of [BAT, SYLLOGISM]) {
    assert.equal(isSelfContainedReasoningPrompt(text), true, text);
    assert.deepEqual(splitInstructionChain(text), [], text);
    assert.equal(ruleLane(text), 'write', text);
  }
});

test('real multi-step and tool requests still split or leave the local writer', () => {
  assert.equal(isSelfContainedReasoningPrompt(CHAIN), false);
  const steps = splitInstructionChain(CHAIN);
  assert.ok(steps.length >= 2, steps.join(' | '));
  assert.equal(ruleLane(CHAIN), 'act');

  assert.equal(isSelfContainedReasoningPrompt('write the summary, then email it to Yordi'), false);
  assert.ok(splitInstructionChain('write the summary, then email it to Yordi').length >= 2);

  assert.equal(isSelfContainedReasoningPrompt('send Hector a WhatsApp saying I am late'), false);
  assert.equal(ruleLane('send Hector a WhatsApp saying I am late'), 'act');

  assert.equal(isSelfContainedReasoningPrompt('how many files are on my desktop'), false);
  assert.equal(ruleLane('how many files are on my desktop'), 'lookup');

  assert.equal(isSelfContainedReasoningPrompt('search the web for the latest boat race scores'), false);
  assert.equal(ruleLane('search the web for the latest boat race scores'), 'lookup');

  assert.equal(isSelfContainedReasoningPrompt('Solomon, are you mature enough to be cloned into Kingmaker?'), false);
  assert.equal(isSelfContainedReasoningPrompt('what are your pass rates right now'), false);
  assert.equal(isSelfContainedReasoningPrompt('is Kingmaker ready to be built yet'), false);
});

test('the bar calls the direct path before it splits a chain', async () => {
  const cli = await readFile(new URL('../lib/cli.mjs', import.meta.url), 'utf8');
  const direct = cli.indexOf('isSelfContainedReasoningPrompt(text)');
  const chain = cli.indexOf('chainSteps.length >= 2');
  assert.ok(direct > 0 && chain > direct);
  assert.match(cli, /runDirectReasoning\(/);
});

test('the boat prompt runs the shipped method once on the hunter model, with no network', async () => {
  const calls = [];
  const hits = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async () => { hits.push('fetch'); throw new Error('no network'); };
  const workDir = await mkdtemp(join(tmpdir(), 'kingmaker-reason-'));
  try {
    const result = await runDirectReasoning({
      text: BOAT,
      model: 'hunter-picked:reasoning',
      workDir,
      complete: (model, prompt) => {
        calls.push({ model, prompt });
        return 'Plan: stay in the lagoon and hit every respawn.\nExpected final score: 1800.';
      },
    });
    assert.equal(hits.length, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, 'hunter-picked:reasoning');
    assert.match(calls[0].prompt, /Think step by step/);
    assert.match(calls[0].prompt, /Quantify the options/);
    assert.match(calls[0].prompt, /Compare the totals/);
    assert.match(calls[0].prompt, /lagoon/);
    assert.match(calls[0].prompt, /self-contained-reasoning/);
    assert.equal(result.methodId, 'self-contained-reasoning');
    assert.equal(result.wrote, false);
    assert.equal(result.swap, false);
    assert.equal(result.model, 'hunter-picked:reasoning');
    assert.match(result.answer, /Plan:/);
    assert.match(result.answer, /1800/);
  } finally {
    globalThis.fetch = previous;
  }
});

test('a library with no reasoning method gets one written, then one local pass', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kingmaker-methods-'));
  const file = 'other.method.md';
  await writeFile(join(root, file), '# Other\n\n```kingmaker-method\n{"id":"other-thing","version":"1","title":"Other","domain":"funnel","inputs":{},"steps":[{"id":"n","type":"note","text":"nope"}]}\n```\n');
  await writeFile(join(root, 'index.json'), JSON.stringify({
    schema: 'kingmaker.methods/1',
    qualityTiers: ['draft', 'community', 'vetted', 'canonical'],
    methods: [{ id: 'other-thing', title: 'Other', domain: 'funnel', file, quality: { tier: 'draft', score: 10, basis: 'fixture' } }],
  }));
  const conductor = createMethodConductor({ indexUrl: pathToFileURL(join(root, 'index.json')) });
  const localDir = await mkdtemp(join(tmpdir(), 'kingmaker-written-'));
  const workDir = await mkdtemp(join(tmpdir(), 'kingmaker-reason-'));
  let seen = null;
  const result = await runDirectReasoning({
    text: BAT,
    model: 'kept-model',
    conductor,
    localDir,
    workDir,
    complete: (model, prompt) => { seen = { model, prompt }; return 'The ball costs $0.05.'; },
  });
  assert.equal(result.wrote, true);
  assert.equal(result.methodId, 'self-contained-reasoning');
  assert.equal(seen.model, 'kept-model');
  assert.equal(result.swap, false);
  const written = await readFile(join(localDir, 'self-contained-reasoning.method.md'), 'utf8');
  const spec = parseMethodFile(written);
  assert.equal(spec.kind, 'self-contained-reasoning');
  assert.equal(spec.steps.filter((step) => step.type === 'reason').length, 1);
  assert.equal(written, reasoningMethodDocument());
  assert.match(seen.prompt, /How much does the ball cost/);
});

test('the shipped method file is the same document the writer emits', async () => {
  const shipped = await readFile(new URL('../catalog/methods/self-contained-reasoning.method.md', import.meta.url), 'utf8');
  assert.equal(shipped, reasoningMethodDocument());
  const listed = await createMethodConductor().listMethods();
  assert.equal(listed.find((m) => m.id === 'self-contained-reasoning')?.kind, 'self-contained-reasoning');
});
