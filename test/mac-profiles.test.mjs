// The starter floor (lib/mac-profiles.mjs), structured tool calls (lib/tool-call.mjs) and the benchmark's
// pure parts (lib/model-bench.mjs): detection from sysctl, the floor every Mac shares, and that every floor
// pick is backed by a measured, fitting result in catalog/bench/. Since the metered-doctrine rework
// (2026-11-14) there is no per-Mac class table: the floor is the smallest sufficient model per role, the
// same on every device, and anything beyond it is picked per task and metered in.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { defaultRouter, LANE_SCHEMA, LANES, ROUTER_CONTEXT, writerModel } from '../lib/fast-route.mjs';
import { BENCH_SETS, FLOOR_MODELS, FLOOR_ROLES, GRANITE_8GB, MODEL_GB, ROLES, detectMac, floorLine, floorRole, knownModelTags, parseChip } from '../lib/mac-profiles.mjs';
import { benchProvenance, benchSlug, hasModel, mayStart, MIN_FREE_PCT, runnerRows, stepMatches, summarize, TOOL_CASES, verdict, WRITE_CASES } from '../lib/model-bench.mjs';
import { fitsSchema, NO_TOOL, parseReply, pickSchema, twoStepCall } from '../lib/tool-call.mjs';
import { benchOutDir, benchSet, brainLibraryScript } from '../lib/bench-cli.mjs';

const sysctlOf = (map) => (cmd, args) => { const v = map[args[1]]; if (v === undefined) throw new Error('unknown'); return `${v}\n`; };

test('the chip and its bandwidth come from machdep.cpu.brand_string', () => {
  assert.deepEqual(parseChip('Apple M3'), { chip: 'M3', gen: 3, tier: 'base', bandwidth: 100 });
  assert.deepEqual(parseChip('Apple M5 Pro'), { chip: 'M5 Pro', gen: 5, tier: 'Pro', bandwidth: 307 });
  assert.equal(parseChip('Apple M4 Max').bandwidth, 546);
  assert.equal(parseChip('Apple M2 Ultra').chip, 'M2 Ultra');
  assert.equal(parseChip('Intel(R) Core(TM) i7').chip, null);
});

test('detectMac reads hw.memsize and the chip from sysctl (the 8 GB M3 and this M5 Pro)', () => {
  const m3 = detectMac({ exec: sysctlOf({ 'hw.memsize': 8589934592, 'machdep.cpu.brand_string': 'Apple M3', 'hw.model': 'Mac15,12' }) });
  assert.equal(m3.ramGb, 8); assert.equal(m3.chip, 'M3'); assert.equal(m3.model, 'Mac15,12');
  const m5 = detectMac({ exec: sysctlOf({ 'hw.memsize': 25769803776, 'machdep.cpu.brand_string': 'Apple M5 Pro', 'hw.model': 'Mac17,9' }) });
  assert.equal(m5.ramGb, 24); assert.equal(m5.bandwidth, 307);
});

test('the floor names the smallest sufficient model for every role — the same on every Mac', () => {
  for (const r of ROLES) {
    assert.equal(floorRole(r), FLOOR_ROLES[r], r);
    assert.ok(knownModelTags().includes(FLOOR_ROLES[r]), `${r}: ${FLOOR_ROLES[r]} is a tabled model`);
    assert.ok(MODEL_GB[FLOOR_ROLES[r]] > 0, `${r}: the floor pick has a measured size`);
  }
  // Writer and reasoning share one model (a small Mac keeps one writing brain resident); the router is
  // the smallest router-tabled model — routing does not need the writer's size.
  assert.equal(FLOOR_ROLES.writer, GRANITE_8GB);
  assert.equal(FLOOR_ROLES.reasoning, FLOOR_ROLES.writer);
  assert.ok(MODEL_GB[FLOOR_ROLES.router] < MODEL_GB[FLOOR_ROLES.writer], 'the router is smaller than the writer');
  assert.deepEqual([...FLOOR_MODELS].sort(), [...new Set(Object.values(FLOOR_ROLES))].sort(), 'the floor set is the floor roles, deduplicated');
  assert.equal(floorRole('nope'), null);
});

test('the write lane and the router default to the floor; a pin always wins', () => {
  assert.equal(writerModel(null), GRANITE_8GB, 'the write lane defaults to the floor writer on every Mac');
  assert.equal(defaultRouter(), FLOOR_ROLES.router, 'the router defaults to the floor router on every Mac');
  assert.equal(writerModel('dolphin3:8b'), 'dolphin3:8b', 'a pin always wins');
});

test('the floor line names this Mac and the floor it shares with every Mac', () => {
  const line = floorLine({ chip: 'M3', ramGb: 8 });
  assert.match(line, /M3 · 8 GB/);
  assert.match(line, /starter floor \(the same on every Mac\)/);
  assert.match(line, /picked per task and metered in/);
  for (const r of ROLES) assert.ok(line.includes(FLOOR_ROLES[r]), `${r} named`);
});

test('the floor is chosen from measured numbers: each pick was benchmarked on the 8 GB simulation and fits that device', () => {
  const load = (f) => { const p = new URL(`../catalog/bench/${f}`, import.meta.url); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; };
  const sim8 = load('m5-pro-24gb-as-8gb.json');
  assert.ok(sim8, 'the committed bench results');
  for (const role of ROLES) {
    const tag = FLOOR_ROLES[role];
    const r = sim8.results.find((x) => x.model === tag);
    assert.ok(r, `${role} ${tag} was measured`);
    const v = verdict(r, { maxResidentGb: 8 });
    assert.ok(v.fits, `${role} ${tag} fits the 8 GB device it was simulated as (${v.why})`);
  }
  // The real 8 GB candidate set is the simulation's own measured models.
  for (const m of BENCH_SETS[8]) assert.ok(sim8.results.some((r) => r.model === m.tag), `${m.tag} in the 8 GB set was measured`);
});

test('tool calls: the pick is held to the tool names or none, and arguments must fit their schema', () => {
  const tools = [{ type: 'function', function: { name: 'open_app', description: 'Open an app', parameters: { type: 'object', properties: { app: { type: 'string' } }, required: ['app'] } } }];
  assert.deepEqual(pickSchema(tools).properties.tool.enum, ['open_app', NO_TOOL]);
  assert.ok(fitsSchema({ app: 'Spotify' }, tools[0].function.parameters));
  assert.ok(!fitsSchema({}, tools[0].function.parameters));
  assert.ok(!fitsSchema({ amount: '450' }, { type: 'object', properties: { amount: { type: 'number' } }, required: ['amount'] }));
  // Measured on Ollama 0.31: qwen3.5 wraps a format-held answer in a fence; the object inside is read, then checked.
  assert.deepEqual(parseReply('```json\n{\n  "app": "Spotify"\n}\n```'), { app: 'Spotify' });
  assert.deepEqual(parseReply('<think>hm</think>{"tool":"none"}'), { tool: 'none' });
  assert.equal(parseReply('no json here'), null);
  // The router's reply is a schema too, and it reads a short context.
  assert.deepEqual(LANE_SCHEMA.properties.lane.enum, LANES); assert.equal(ROUTER_CONTEXT, 2048);
});

test('two-step: a pick of none or arguments that never fit do nothing', async () => {
  const tools = [{ type: 'function', function: { name: 'open_app', description: 'Open an app', parameters: { type: 'object', properties: { app: { type: 'string' } }, required: ['app'] } } }];
  const replies = (...contents) => { let i = 0; return async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ message: { content: contents[Math.min(i++, contents.length - 1)] } }) }); };
  assert.deepEqual(await twoStepCall({ model: 'm', tools, messages: [{ role: 'user', content: 'capital of France?' }], fetchImpl: replies('{"tool":"none"}') }).then((r) => r.name), NO_TOOL);
  assert.deepEqual((await twoStepCall({ model: 'm', tools, messages: [{ role: 'user', content: 'open spotify' }], fetchImpl: replies('{"tool":"open_app"}', '{"app":"Spotify"}') })).arguments, { app: 'Spotify' });
  const bad = await twoStepCall({ model: 'm', tools, messages: [{ role: 'user', content: 'open it' }], fetchImpl: replies('{"tool":"open_app"}', '{"name":"x"}') });
  assert.equal(bad.name, NO_TOOL); assert.equal(bad.why, 'arguments_did_not_fit');
  assert.equal((await twoStepCall({ model: 'm', tools, messages: [{ role: 'user', content: 'x' }], fetchImpl: replies('{"tool":"rm_rf"}') })).name, NO_TOOL);
});

test('bench scoring: steps match by name and argument, amounts as numbers; kinds are summarized', () => {
  const m1 = TOOL_CASES.find((c) => c.id === 'm1');
  assert.ok(stepMatches({ name: 'create_invoice', arguments: { customer: 'Hector Tacos', amount: '$450', due_date: 'November 1' } }, m1.steps[0]));
  assert.ok(!stepMatches({ name: 'create_invoice', arguments: { customer: 'Hector Tacos', amount: 45, due_date: 'November 1' } }, m1.steps[0]));
  assert.ok(!stepMatches({ name: 'send_message', arguments: {} }, m1.steps[0]));
  const kinds = new Set(TOOL_CASES.map((c) => c.kind));
  assert.deepEqual([...kinds].sort(), ['chain', 'multi', 'refuse', 'single']);
  assert.ok(TOOL_CASES.filter((c) => c.kind === 'chain').every((c) => c.steps.length === 2 && c.result));
  assert.deepEqual(summarize([{ kind: 'a', pass: true }, { kind: 'a', pass: false }]).by.a, { pass: 1, of: 2 });
  assert.ok(WRITE_CASES[0].check('Your order is delayed by one day. Sorry for the wait.'));
  assert.ok(!WRITE_CASES[0].check('Delayed. Sorry. Really.'));
  assert.ok(WRITE_CASES[1].check('- Ask for reviews\n- Reply to reviews\n- Put a QR code for reviews'));
});

test('bench memory: only the runner under the server being measured counts, by its largest process', () => {
  const ps = ' 10  1  3000000 /x/llama-server --model /b/sha256-aa -c 4096\n 11  2  3100000 /x/llama-server --model /b/sha256-aa -c 4096\n 12  1  900 /x/ollama serve\n 13  1 500000 /x/llama-server --model /b/sha256-bb';
  assert.deepEqual(runnerRows(ps, { blob: 'sha256-aa', serverPid: 2 }), [{ pid: 11, rssKb: 3100000 }]);
  assert.equal(runnerRows(ps, { blob: 'sha256-aa' }).length, 2);
  const r = { model: 'x', resident: { sizeGb: 3, gpuGb: 3 }, memory: { peakRssGb: 3.2, swapDeltaMb: 0 }, tools: { twoStep: { pct: 90 } } };
  assert.equal(verdict(r, { maxResidentGb: 3.5 }).fits, true);
  assert.match(verdict(r, { maxResidentGb: 3 }).why, /holds 3.2 GB/);
  assert.equal(verdict({ ...r, memory: { steadyRssGb: 2.9, peakRssGb: 4.8, swapDeltaMb: 0 } }, { maxResidentGb: 3 }).fits, true, 'judged by what it holds, not the load spike');
  assert.match(verdict({ ...r, resident: { sizeGb: 3, gpuGb: 1.5 } }, { maxResidentGb: 4 }).why, /on the GPU/);
  assert.match(verdict({ ...r, memory: { peakRssGb: 3, swapDeltaMb: 900 } }, { maxResidentGb: 4 }).why, /swap/);
  assert.equal(verdict({ error: 'boom' }).fits, false);
  assert.match(verdict({ ...r, memory: { steadyRssGb: 6, swapDeltaMb: 0 }, resident: { sizeGb: 12, gpuGb: 12 } }, { maxResidentGb: 11 }).why, /holds 12 GB/, 'Ollama\'s size counts when RSS reads low under pressure');
  assert.match(verdict({ ...r, memory: { steadyRssGb: 3, swapDeltaMb: 0, minMemLevel: 8 } }, { maxResidentGb: 4 }).why, /memory pressure/);
});

test('the bench never starts a model on a hot Mac or under 20% free memory (the owner uses it meanwhile)', () => {
  const cool = { warning: null, speedLimit: null };
  assert.equal(MIN_FREE_PCT, 20);
  assert.ok(mayStart(cool, 45)); assert.ok(mayStart(cool, null), 'an unknown level does not block');
  assert.ok(!mayStart(cool, 12)); assert.ok(!mayStart({ warning: 2, speedLimit: null }, 80)); assert.ok(!mayStart({ warning: null, speedLimit: 70 }, 80));
});

test('bench files are named by chip and RAM; inside the app they go to Kingmaker\'s one folder, never the Desktop or the bundle', () => {
  assert.equal(benchSlug('Apple M3', 8), 'm3-8gb');
  assert.equal(benchSlug('Apple M5 Pro', 24, 8), 'm5-pro-24gb-as-8gb');
  assert.ok(hasModel(['local/x:latest'], 'local/x')); assert.ok(!hasModel(['local/y'], 'local/x'));
  assert.equal(benchOutDir('file:///Applications/Kingmaker.app/Contents/Resources/sol-ghost/lib/bench-cli.mjs', '/Users/o', {}), '/Users/o/Library/Application Support/sol-ghost/Files/Bench', 'the hidden folder, never the Desktop');
  assert.equal(benchOutDir('file:///Applications/Kingmaker.app/Contents/Resources/sol-ghost/lib/bench-cli.mjs', '/Users/o', { KINGMAKER_HOME: '/Users/o/Library/Application Support/Kingmaker/Files' }), '/Users/o/Library/Application Support/Kingmaker/Files/Bench', 'follows Kingmaker\'s folder wherever it is');
  assert.match(benchOutDir('file:///Users/o/Projects/sol-ghost/lib/bench-cli.mjs', '/Users/o'), /sol-ghost\/catalog\/bench\/$/);
});

test('the brain-library script is found beside lib/ in a checkout, else in the source checkout, else a plain message names the path (no ENOENT from the installed app)', () => {
  const app = 'file:///Applications/Kingmaker.app/Contents/Resources/sol-ghost/lib/bench-cli.mjs';
  const has = (...paths) => (p) => paths.includes(p);
  assert.deepEqual(brainLibraryScript('file:///Users/o/Projects/sol-ghost/lib/bench-cli.mjs', {}, '/Users/o', has('/Users/o/Projects/sol-ghost/scripts/brain-library.mjs')), { path: '/Users/o/Projects/sol-ghost/scripts/brain-library.mjs' }, 'a source checkout uses its own');
  assert.deepEqual(brainLibraryScript(app, {}, '/Users/o', has('/Users/o/Projects/sol-ghost/scripts/brain-library.mjs')), { path: '/Users/o/Projects/sol-ghost/scripts/brain-library.mjs' }, 'the installed app falls back to ~/Projects/sol-ghost');
  assert.deepEqual(brainLibraryScript(app, { KINGMAKER_SOURCE: '/src/km' }, '/Users/o', has('/src/km/scripts/brain-library.mjs')), { path: '/src/km/scripts/brain-library.mjs' }, 'KINGMAKER_SOURCE wins');
  assert.deepEqual(brainLibraryScript(app, { KINGMAKER_SOURCE: '/src/km' }, '/Users/o', has()), { missing: '/src/km/scripts/brain-library.mjs' }, 'names the exact path it looked for');
  assert.deepEqual(brainLibraryScript(app, {}, '/Users/o', has()), { missing: '/Users/o/Projects/sol-ghost/scripts/brain-library.mjs' });
});

test('a bench file says what made it: the version and the commit, read from .git, never by running git', () => {
  const files = (map) => (u) => { const k = String(u).replace('file:///k/', ''); if (!(k in map)) throw new Error('ENOENT'); return map[k]; };
  const sha = 'a'.repeat(40), root = 'file:///k/';
  assert.deepEqual(benchProvenance(root, files({ 'package.json': '{"version":"0.2.5"}', '.git/HEAD': 'ref: refs/heads/main\n', '.git/refs/heads/main': `${sha}\n` })), { version: '0.2.5', commit: sha, branch: 'main' });
  assert.equal(benchProvenance(root, files({ '.git/HEAD': 'ref: refs/heads/x', '.git/packed-refs': `# pack-refs\n${sha} refs/heads/x\n` })).commit, sha, 'a packed ref');
  assert.deepEqual(benchProvenance(root, files({ '.git/HEAD': sha })), { version: null, commit: sha, branch: null }, 'a detached HEAD');
  assert.deepEqual(benchProvenance(root, files({ 'package.json': '{"version":"1"}' })), { version: '1', commit: null, branch: null }, 'no checkout (the app)');
});

test('a bench set is a named candidate list; there are no per-class sets anymore', () => {
  assert.deepEqual(benchSet('8'), BENCH_SETS[8].map((m) => m.tag));
  assert.deepEqual(benchSet(24), BENCH_SETS[24].map((m) => m.tag));
  assert.deepEqual(benchSet('8-wide'), BENCH_SETS['8-wide'].map((m) => m.tag));
  for (const id of ['16', '32', '48', '64']) assert.deepEqual(benchSet(id), [], `${id} is not a set (packs are retired)`);
  const all = benchSet('all'); assert.equal(new Set(all).size, all.length); assert.ok(BENCH_SETS[24].every((m) => all.includes(m.tag)));
  assert.deepEqual(benchSet('12'), []);
});
