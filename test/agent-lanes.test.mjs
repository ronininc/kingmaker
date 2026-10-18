// Tier 1 agent-behaviour tests: the real lanes against a scripted Ollama (test/fixtures/fake-ollama.mjs), asserting on what
// Kingmaker SENDS (the schema a reply is held to, the tools a model is shown, how many calls a lane makes) and on what it
// does with a wrong or broken reply. No model and no network. Tier 2 (real local models) is `kingmaker models bench`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeOllama } from './fixtures/fake-ollama.mjs';
import { LANES, LANE_SCHEMA, ROUTER_CONTEXT, ROUTER_SYSTEM, routeLane, ruleLane } from '../lib/fast-route.mjs';
import { NO_TOOL, twoStepCall } from '../lib/tool-call.mjs';
import { connectorTurn } from '../lib/connectors.mjs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { conductParts, reloadInstructions, TURN_BUDGET } from '../lib/instructions.mjs';
import { LOCAL_SYSTEM, localModelTurn } from '../lib/local-turn.mjs';
import { prefixReuse } from '../lib/model-bench.mjs';
import { scanBench } from '../lib/library-scan.mjs';

const TOOLS = [
  { type: 'function', function: { name: 'send_message', description: 'Send a text message to a person', parameters: { type: 'object', properties: { to: { type: 'string', description: 'who' }, text: { type: 'string', description: 'what' } }, required: ['to', 'text'] } } },
  { type: 'function', function: { name: 'get_weather', description: 'The weather in a city', parameters: { type: 'object', properties: { city: { type: 'string', description: 'city' } }, required: ['city'] } } },
];
const ASK = [{ role: 'user', content: 'Tell Maria I am running late' }];
const withHost = async (base, fn) => { const was = process.env.OLLAMA_HOST; process.env.OLLAMA_HOST = base; try { return await fn(); } finally { if (was === undefined) delete process.env.OLLAMA_HOST; else process.env.OLLAMA_HOST = was; } };

test('router: a command the rules can\'t place is held to the five lanes, at the router\'s small context', async () => {
  const text = 'the quarterly thing with the vendor';
  assert.equal(ruleLane(text), null, 'the rules leave this one to the router');
  const o = await fakeOllama([{ content: '{"lane":"write"}' }]);
  try {
    const r = await routeLane(text, { model: 'router:1b', base: o.base });
    assert.deepEqual([r.lane, r.by], ['write', 'router']);
    const [sent] = o.chats;
    assert.deepEqual(sent.format, LANE_SCHEMA); assert.deepEqual(sent.format.properties.lane.enum, LANES);
    assert.equal(sent.options.num_ctx, ROUTER_CONTEXT); assert.equal(sent.options.temperature, 0); assert.equal(sent.think, false);
    assert.deepEqual(sent.messages.map((m) => m.role), ['system', 'user']); assert.equal(sent.messages[0].content, ROUTER_SYSTEM);
  } finally { await o.close(); }
});

test('router: a lane it made up, a broken reply or a server error all go to the governed brain (act); rules never call it', async () => {
  const o = await fakeOllama([{ content: '{"lane":"delete"}' }, { content: 'Sure! Here is a haiku' }, { status: 500 }]);
  try {
    for (let i = 0; i < 3; i += 1) assert.deepEqual(await routeLane('the quarterly thing', { base: o.base }).then((r) => [r.lane, r.by]), ['act', 'default']);
    assert.equal(o.chats.length, 3);
    await routeLane('Open Safari', { base: o.base });
    assert.equal(o.chats.length, 3, 'a command the rules place never reaches the model');
  } finally { await o.close(); }
});

test('two-step tool call: the pick is held to the tools or none, then the arguments to that tool\'s own schema', async () => {
  const o = await fakeOllama([{ content: '{"tool":"send_message"}' }, { content: '{"to":"Maria","text":"I am running late"}' }]);
  try {
    const r = await twoStepCall({ model: 'm', messages: [{ role: 'system', content: 'ignored' }, ...ASK], tools: TOOLS, base: o.base });
    assert.deepEqual([r.name, r.arguments], ['send_message', { to: 'Maria', text: 'I am running late' }]);
    const [pick, args] = o.chats;
    assert.deepEqual(pick.format.properties.tool.enum, ['send_message', 'get_weather', NO_TOOL]);
    for (const t of TOOLS) assert.match(pick.messages[0].content, new RegExp(`- ${t.function.name}: `), 'every tool is shown, one line each');
    assert.ok(!pick.messages.some((m) => m.content === 'ignored'), 'the caller\'s system line is replaced, not stacked');
    assert.deepEqual(args.format, TOOLS[0].function.parameters);
    assert.ok(!('tools' in pick) && !('tools' in args), 'the two-step path never hands Ollama the native tools field');
  } finally { await o.close(); }
});

test('two-step tool call: an unknown tool does nothing; arguments that never fit give up after one retry', async () => {
  const o = await fakeOllama([{ content: '{"tool":"delete_everything"}' },
    { content: '{"tool":"get_weather"}' }, { content: '{"town":"Paris"}' }, { content: '{"city":""}' }]);
  try {
    assert.equal((await twoStepCall({ model: 'm', messages: ASK, tools: TOOLS, base: o.base })).name, NO_TOOL);
    assert.equal(o.chats.length, 1, 'no arguments are asked for a tool that does not exist');
    const r = await twoStepCall({ model: 'm', messages: ASK, tools: TOOLS, base: o.base });
    assert.deepEqual([r.name, r.why], [NO_TOOL, 'arguments_did_not_fit']);
    assert.equal(o.chats.length, 4, 'one pick and two tries at the arguments, no more');
  } finally { await o.close(); }
});

test('connector lane: the model reads --help and picks arguments; the program\'s real output is shown, not retold', async () => {
  const runs = [];
  const run = async (c, args) => { runs.push(args); return args[0] === '--help' ? { ok: true, code: 0, stdout: 'usage: greet <name>', stderr: '' } : { ok: true, code: 0, stdout: `hello ${args[0]}`, stderr: '' }; };
  const o = await fakeOllama([{ content: '{"args":["owner"]}' }, { content: 'It greeted the owner.' }]);
  try {
    // ["owner"] is not a recognised read-only call, so it waits for the owner's yes (the gate); on it the same arguments run
    let held = null;
    const gated = await withHost(o.base, () => connectorTurn({ enabled: true, kind: 'cli', name: 'greet', target: '/bin/greet' }, 'greet me', { run, fetchImpl: fetch, confirm: (h) => { held = h; } }));
    assert.deepEqual(runs, [['--help']]); assert.equal(gated.held, true);
    const r = await withHost(o.base, () => held.run());
    assert.deepEqual(runs, [['--help'], ['owner']]);
    assert.equal(r.text, 'It greeted the owner.\n\nhello owner'); assert.deepEqual(r.ran, ['greet', 'owner']);
    const [plan, said] = o.chats;
    assert.equal(plan.format, 'json'); assert.match(plan.messages[1].content, /usage: greet <name>/);
    assert.match(said.messages[1].content, /Exit code: 0\nOutput:\nhello owner/, 'the sentence is written from what really ran');
  } finally { await o.close(); }
});

test('connector lane: a plan that isn\'t JSON runs nothing; a rejected connector never reaches the model', async () => {
  const runs = [];
  const run = async (c, args) => { runs.push(args); return { ok: true, code: 0, stdout: 'usage: x', stderr: '' }; };
  const o = await fakeOllama([{ content: 'I would run it with the owner flag' }]);
  try {
    const r = await withHost(o.base, () => connectorTurn({ enabled: true, kind: 'cli', name: 'x', target: '/bin/x' }, 'do it', { run }));
    assert.deepEqual(runs, [['--help']], 'only --help ran'); assert.match(r.text, /couldn't work out how to use x/);
    const before = o.chats.length;
    const no = await withHost(o.base, () => connectorTurn({ enabled: false, kind: 'cli', name: 'bad', summary: 'REA rejected it: it downloads code and runs it.' }, 'do it', { run }));
    assert.match(no.text, /isn’t connected: REA rejected it/); assert.equal(o.chats.length, before);
  } finally { await o.close(); }
});

test('write lane: the system brief is the same turn after turn, so Ollama reuses it; only what was picked rides with the turn', async () => {
  const d = mkdtempSync(join(tmpdir(), 'km-brief-'));
  // Instructions too long to carry whole: an opening, then sections on bakery pricing and on flyers.
  const filler = (w) => Array.from({ length: 70 }, (_, i) => `${w} note ${i}: keep the ${w} wording short and plain for customers.`).join('\n\n');
  writeFileSync(join(d, 'instructions.md'), `Always sign as Ana.\n\n## Pricing\nBakery pricing: ${filler('pricing')}\n\n## Flyers\nFlyer layout: ${filler('flyer')}\n`);
  writeFileSync(join(d, 'guardrails.md'), 'Never promise delivery.');
  assert.ok(reloadInstructions(d).chars > TURN_BUDGET, 'too long to carry whole');
  const o = await fakeOllama([{ content: 'a' }, { content: 'b' }]);
  try {
    const a = conductParts(d, 'what should the bakery pricing be'), b = conductParts(d, 'make a flyer for saturday');
    assert.equal(a.stable, b.stable, 'the system part does not depend on the turn');
    assert.match(a.stable, /Never promise delivery/); assert.match(a.stable, /Always sign as Ana/);
    assert.match(a.turn, /pricing note/); assert.match(b.turn, /flyer note/); assert.notEqual(a.turn, b.turn, 'what rides with the turn is picked for it');
    await localModelTurn('w', 'what should the bakery pricing be', { brief: a.stable, turnBrief: a.turn, base: o.base });
    await localModelTurn('w', 'make a flyer for saturday', { brief: b.stable, turnBrief: b.turn, base: o.base });
    const [one, two] = o.chats;
    assert.equal(one.messages[0].content, two.messages[0].content, 'byte-for-byte the same system message');
    assert.ok(one.messages[0].content.startsWith(LOCAL_SYSTEM));
    assert.match(one.messages[1].content, /pricing note[\s\S]*\n\nwhat should the bakery pricing be$/, 'the picked sections, then the owner\'s words');
    // Short instructions: nothing rides with the turn at all.
    writeFileSync(join(d, 'instructions.md'), 'Always sign as Ana.'); reloadInstructions(d);
    assert.equal(conductParts(d, 'anything').turn, '');
  } finally { await o.close(); rmSync(d, { recursive: true, force: true }); reloadInstructions(tmpdir()); }
});

test('bench: how much of a repeated brief the model read again; a bench file carrying it still passes the library scan', () => {
  assert.deepEqual(prefixReuse({ prompt_eval_count: 420, prompt_eval_duration: 9e8 }, { prompt_eval_count: 14, prompt_eval_duration: 3e7 }),
    { firstTokens: 420, secondTokens: 14, firstMs: 900, secondMs: 30, reusedPct: 97 });
  assert.equal(prefixReuse({ prompt_eval_count: 420 }, { prompt_eval_count: 430 }).reusedPct, 0, 'no reuse: it read it all again');
  assert.equal(prefixReuse(null, null).reusedPct, null);
  const file = { schema: 1, slug: 'm3-8gb', startedAt: '2026-10-15T00:00:00.000Z', context: 4096, maxResidentGb: 3.3, simulated: null, cooldownS: 30,
    host: { chip: 'Apple M3', model: 'Mac15,3', ramGb: 8, macos: '26.6.2', ollama: '0.31.1' },
    results: [{ model: 'granite4.1:3b', at: '2026-10-15T00:00:00.000Z', context: 4096, speed: { promptTokS: 100, genTokS: 20, genTokens: 100, promptTokens: 30, promptMs: 300,
      prefix: prefixReuse({ prompt_eval_count: 420, prompt_eval_duration: 9e8 }, { prompt_eval_count: 14, prompt_eval_duration: 3e7 }) } }] };
  assert.deepEqual(scanBench(file), []);
});
