// Tests for the one eviction policy (lib/eviction-policy.mjs): the intent→keep_alive table, admission
// through the reflex seat keeper's pair cap at REAL lane call sites (the fast router, the write lane's
// writer, the ad lane's script call, the image lane's free), and the legacy guarantee — on an inactive
// plan (kill switch, a pair that does not fit the measured memory, no keeper) every site's request
// bytes are what they were before the policy existed. All Ollama traffic is fakes; nothing here
// touches a live model.
// Run: node tests/eviction-policy.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DecisionRouter } from '../lib/decision-router.mjs';
import { MODEL_GB, GRANITE_8GB } from '../lib/mac-profiles.mjs';
import { createReflexSeatKeeper, reflexSeatPlan } from '../lib/reflex-seat.mjs';
import { createEvictionPolicy, declaredLoadGb, keepAliveForIntent, KEEP_ALIVE_BY_INTENT } from '../lib/eviction-policy.mjs';
import { routeLane } from '../lib/fast-route.mjs';
import { localModelTurn } from '../lib/local-turn.mjs';
import { writeScript } from '../lib/ad-video.mjs';
import { makeImage } from '../lib/image-lane.mjs';

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; console.log(`  ok - ${name}`); };

// The seat plan's inputs are MEASURED numbers now, not a device class (the metered-doctrine
// rework retired the profile table): this fixture is the free memory an 8 GB Mac reports —
// the old 8 GB profile's 4.8 GB budget — injected as a measurement, and the plan's budget is
// that measured figure.
const MEASURED_8 = { freeGb: 4.8, totalGb: 8 };
const plan8 = () => reflexSeatPlan({ measured: MEASURED_8, env: {} });
const PICK = DecisionRouter.pickDecisionModel();          // the registry's smallest sized model — the seat on every device, never assumed
const WRITER_8B = 'huihui_ai/qwen3-abliterated:8b';       // the 16 GB writer: MODEL_GB 5.0, over the measured pair budget

const fakeOllama = (initial = []) => {
  const loadedSet = new Set(initial); const calls = [];
  return {
    calls, loadedSet,
    async load(model, opts = {}) { calls.push(['load', model, opts]); loadedSet.add(model); },
    async unload(model) { calls.push(['unload', model]); loadedSet.delete(model); },
    async loaded() { return [...loadedSet]; },
  };
};
const activePolicy = async () => {
  const plan = plan8();
  const client = fakeOllama();
  const keeper = createReflexSeatKeeper({ plan, client });
  await keeper.pin();
  return { plan, client, keeper, policy: createEvictionPolicy({ plan, keeper }) };
};

/* ---------------- the intent table ---------------- */
{
  ok('pin is -1, the reflex seat keeper’s own value', keepAliveForIntent('pin') === -1);
  ok('warm is 30m, the value the warm sites already used', keepAliveForIntent('warm') === '30m');
  ok('transient is 0, the ad lane’s answer-and-unload', keepAliveForIntent('transient') === 0);
  ok('the table is exactly the three intents', Object.keys(KEEP_ALIVE_BY_INTENT).sort().join(',') === 'pin,transient,warm');
  let threw = false; try { keepAliveForIntent('forever'); } catch { threw = true; }
  ok('an unknown intent throws instead of defaulting', threw);
  // The pin row is not a copy of the keeper's value, it IS the keeper's value: pin through a keeper and compare.
  const client = fakeOllama();
  const keeper = createReflexSeatKeeper({ plan: plan8(), client });
  await keeper.pin();
  ok('the keeper pins with the table’s pin value', client.calls.find(([op]) => op === 'load')[2].keepAlive === keepAliveForIntent('pin'));
}

/* ---------------- declared sizes ---------------- */
{
  ok('a known model declares its MODEL_GB size', declaredLoadGb(GRANITE_8GB, { plan: plan8() }) === MODEL_GB[GRANITE_8GB]);
  ok('an unknown model declares the plan’s worker size — the worst case the plan was built against', declaredLoadGb('some/unlisted:tag', { plan: plan8() }) === plan8().workerGb);
  ok('no table entry and no plan declares null — never an invented size', declaredLoadGb('some/unlisted:tag') === null);
}

/* ---------------- inactive: legacy by reference ---------------- */
{
  const explodingKeeper = { loadWorker: async () => { throw new Error('must not be called'); }, unload: async () => { throw new Error('must not be called'); }, loaded: async () => { throw new Error('must not be called'); } };
  for (const [name, policy] of [
    ['no plan at all', createEvictionPolicy({})],
    ['an inactive plan (the pair does not fit the measured free memory)', createEvictionPolicy({ plan: reflexSeatPlan({ measured: { freeGb: 2.0, totalGb: 16 }, env: {} }), keeper: explodingKeeper })],
    ['the kill switch', createEvictionPolicy({ plan: reflexSeatPlan({ measured: MEASURED_8, env: { KINGMAKER_REFLEX_PIN: 'off' } }), keeper: explodingKeeper })],
  ]) {
    ok(`${name}: the policy is inactive`, policy.active === false);
    ok(`${name}: keepAlive returns each site’s legacy value untouched`, policy.keepAlive('warm', '30m') === '30m' && policy.keepAlive('warm', '10m') === '10m' && policy.keepAlive('transient', 0) === 0 && policy.keepAlive('warm', undefined) === undefined);
    const adm = await policy.admit({ model: WRITER_8B, intent: 'warm', legacy: '30m' });
    ok(`${name}: even an over-budget model is admitted as legacy — the keeper is never consulted`, adm.ok && adm.via === 'legacy' && adm.keepAlive === '30m');
    ok(`${name}: freeAll stands aside for the caller’s legacy free`, (await policy.freeAll()) === null);
  }
}

/* ---------------- active: admission through the keeper ---------------- */
{
  const { client, policy } = await activePolicy();
  ok('the policy is active on the measured plan with a keeper', policy.active === true);
  const adm = await policy.admit({ model: GRANITE_8GB, intent: 'warm', legacy: undefined });
  ok('an under-budget writer load is admitted through the keeper', adm.ok && adm.via === 'keeper' && adm.keepAlive === '30m');
  ok('the keeper loaded the writer warm beside the seat', client.loadedSet.has(GRANITE_8GB) && client.loadedSet.has(PICK.name));
  ok('the writer load carried the policy’s warm keep_alive', client.calls.filter(([op, m]) => op === 'load' && m === GRANITE_8GB).at(-1)[2].keepAlive === '30m');
}
{
  const { client, policy } = await activePolicy();
  await policy.admit({ model: GRANITE_8GB, intent: 'warm' });
  const callsBefore = client.calls.length;
  const adm = await policy.admit({ model: WRITER_8B, intent: 'warm' });
  ok('an over-budget writer load is refused', adm.ok === false && adm.refused === true);
  ok('the refusal carries the keeper’s arithmetic', /pinned reflex seat/.test(adm.reason) && /budget of measured free memory/.test(adm.reason) && adm.pairGb > adm.budgetGb);
  ok('the refusal happened before anything was loaded or unloaded', client.calls.length === callsBefore && !client.loadedSet.has(WRITER_8B));
  ok('the seat and the resident worker are untouched', client.loadedSet.has(PICK.name) && client.loadedSet.has(GRANITE_8GB));
}
{
  const { client, plan, policy } = await activePolicy();
  const adm = await policy.admit({ model: PICK.name, intent: 'warm' });
  ok('the seat’s own model is admitted without keeper churn', adm.ok && adm.via === 'seat' && client.calls.filter(([op]) => op === 'load').length === 1);
  const over = await policy.admit({ model: 'some/unlisted:tag', intent: 'warm', gb: plan.budgetGb });
  ok('a caller-declared measured size is what the cap judges', over.ok === false && over.refused === true);
  const under = await policy.admit({ model: 'some/unlisted:tag', intent: 'warm', gb: 1.0 });
  ok('a small declared size is admitted', under.ok === true && under.via === 'keeper');
}
{
  const { client, policy } = await activePolicy();
  await policy.admit({ model: GRANITE_8GB, intent: 'warm' });
  await client.load('stray-model', { keepAlive: '30m' }); client.loadedSet.add('stray-model');
  const freed = await policy.freeAll();
  ok('freeAll unloads the worker and strays but spares the pinned seat', freed.spared === PICK.name && freed.unloaded.includes(GRANITE_8GB) && freed.unloaded.includes('stray-model') && client.loadedSet.has(PICK.name) && client.loadedSet.size === 1);
}

/* ---------------- a real lane: the fast router ---------------- */
const routerFetch = (lane, seen) => async (url, opts = {}) => {
  seen.push([url, JSON.parse(opts.body)]);
  return { ok: true, json: async () => ({ message: { content: JSON.stringify({ lane }) } }) };
};
{
  const { client, policy } = await activePolicy();
  const seen = [];
  const r = await routeLane('tell me something I cannot guess', { model: WRITER_8B, policy, fetchImpl: routerFetch('write', seen) });
  ok('router: an over-budget router load is refused and the lane falls to the governed brain', r.lane === 'act' && r.by === 'policy' && /budget of measured free memory/.test(r.refused));
  ok('router: the refusal sent nothing to Ollama', seen.length === 0);
  ok('router: the seat is untouched', client.loadedSet.has(PICK.name) && !client.calls.some(([op, m]) => op === 'unload' && m === PICK.name));
}
{
  const { policy } = await activePolicy();
  const seen = [];
  const r = await routeLane('tell me something I cannot guess', { model: GRANITE_8GB, policy, fetchImpl: routerFetch('write', seen) });
  ok('router: an under-budget router answers through the policy', r.lane === 'write' && r.by === 'router');
  ok('router: the call carried the policy’s warm keep_alive', seen[0][1].keep_alive === '30m');
}
{
  const seen = [];
  const r = await routeLane('tell me something I cannot guess', { model: GRANITE_8GB, fetchImpl: routerFetch('lookup', seen) });
  ok('router: without a policy the legacy call is byte-for-byte (literal 30m)', r.lane === 'lookup' && seen[0][1].keep_alive === '30m');
}

/* ---------------- a real lane: the write lane's writer ---------------- */
const writerFetch = (seen) => async (url, opts = {}) => {
  seen.push([url, JSON.parse(opts.body)]);
  return { ok: true, json: async () => ({ message: { content: 'an answer' }, eval_count: 3 }) };
};
{
  const { client, policy } = await activePolicy();
  const seen = [];
  const err = await localModelTurn(WRITER_8B, 'write something', { policy, fetchImpl: writerFetch(seen) }).catch((e) => e);
  ok('writer: an over-budget writer load is refused before the call', err instanceof Error && err.refused === true && /budget of measured free memory/.test(err.message));
  ok('writer: no request was sent and the seat is untouched', seen.length === 0 && client.loadedSet.has(PICK.name));
}
{
  const { policy } = await activePolicy();
  const seen = [];
  const answer = await localModelTurn(GRANITE_8GB, 'write something', { policy, fetchImpl: writerFetch(seen) });
  ok('writer: an under-budget writer answers', answer === 'an answer');
  ok('writer: the call carried the policy’s warm keep_alive (30m, not Ollama’s 5m default)', seen[0][1].keep_alive === '30m');
}
{
  const seen = [];
  const answer = await localModelTurn(GRANITE_8GB, 'write something', { fetchImpl: writerFetch(seen) });
  ok('writer: without a policy the legacy call sends no keep_alive at all', answer === 'an answer' && !('keep_alive' in seen[0][1]));
}

/* ---------------- a real lane: the ad lane's transient script call ---------------- */
const scriptFetch = (seen) => async (url, opts = {}) => {
  seen.push([url, JSON.parse(opts.body)]);
  const script = { title: 'T', scenes: [{ demo: 'bar', voiceover: 'first scene words' }, { demo: 'draft', voiceover: 'second scene words' }] };
  return { ok: true, json: async () => ({ message: { content: JSON.stringify(script) }, eval_count: 3 }) };
};
{
  const { client, policy } = await activePolicy();
  const seen = [];
  const script = await writeScript({ request: 'an ad', model: GRANITE_8GB, facts: 'facts', policy, fetchImpl: scriptFetch(seen) });
  ok('ad: the script came from the model', script.by === GRANITE_8GB && script.scenes.length === 2);
  ok('ad: the call was transient — keep_alive 0, answer and leave', seen[0][1].keep_alive === 0);
  ok('ad: the load was released through the keeper; the seat never moved', !client.loadedSet.has(GRANITE_8GB) && client.loadedSet.has(PICK.name) && client.calls.some(([op, m]) => op === 'unload' && m === GRANITE_8GB));
}
{
  const { policy } = await activePolicy();
  const seen = [];
  const script = await writeScript({ request: 'an ad', model: WRITER_8B, facts: 'facts', policy, fetchImpl: scriptFetch(seen) });
  ok('ad: an over-budget script model is refused into the plain-facts fallback, with the reason attached', script.by === 'fallback' && /budget of measured free memory/.test(script.refused) && seen.length === 0);
}

/* ---------------- a real lane: the image lane's free ---------------- */
const imageSetup = () => {
  const out = mkdtempSync(join(tmpdir(), 'eviction-image-'));
  return { ready: true, bin: '/fake/sd-cli', diffusion: '/fake/d.gguf', vae: '/fake/v.safetensors', llm: '/fake/l.gguf', out };
};
const imageRun = (fileSink) => (bin, args, opts, cb) => { const f = args[args.indexOf('-o') + 1]; writeFileSync(f, 'png'); fileSink.push(f); cb(null); };
{
  const { client, policy } = await activePolicy();
  await policy.admit({ model: GRANITE_8GB, intent: 'warm' });
  const files = [];
  const r = await makeImage('a poster for taco night', { setup: imageSetup(), policy, run: imageRun(files), fetchImpl: async () => { throw new Error('the policy path must not use the legacy free'); } });
  ok('image: the drawing happened', r.ok === true && files.length === 1);
  ok('image: the worker was freed and the pinned seat survived the free', !client.loadedSet.has(GRANITE_8GB) && client.loadedSet.has(PICK.name));
}
{
  // Legacy, byte for byte: with no policy the lane unloads EVERYTHING /api/ps lists — the behavior
  // that runs today on the profiles where the image lane is on (the plan is never active there).
  const psNames = [PICK.name, GRANITE_8GB];
  const freed = [];
  const legacyFetch = async (url, opts = {}) => {
    if (url.endsWith('/api/ps')) return { json: async () => ({ models: psNames.map((name) => ({ name })) }) };
    freed.push(JSON.parse(opts.body).model);
    return { json: async () => ({}) };
  };
  const files = [];
  const r = await makeImage('a poster for taco night', { setup: imageSetup(), run: imageRun(files), fetchImpl: legacyFetch });
  ok('image: without a policy the legacy free unloads everything, as today', r.ok === true && freed.sort().join(',') === [...psNames].sort().join(','));
}

console.log(`\neviction-policy: ${passed} passed`);
