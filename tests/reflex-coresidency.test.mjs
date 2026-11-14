// Tests for the reflex seat (lib/reflex-seat.mjs): the capped, non-evictable co-residency exception to
// one-model-at-a-time loading. Since the metered-doctrine rework (2026-11-14) the plan is pure arithmetic
// over MEASURED memory (this device's free GB), the floor worker's declared size and the decision
// registry's smallest sized model — no Mac class or profile is consulted (no number is hardcoded here
// that the tree doesn't carry). The keeper is exercised against a fake Ollama client — pin survival
// through worker churn, the pair-cap boundary, the never-evict rule, and the kill switch restoring the
// strict single slot. The engine env contract (lib/profile.mjs) is checked at the seam.
// Run: node tests/reflex-coresidency.test.mjs
import assert from 'node:assert/strict';
import { DecisionRouter, DECISION_MODEL_REGISTRY } from '../lib/decision-router.mjs';
import { FLOOR_ROLES, GRANITE_8GB, MODEL_GB } from '../lib/mac-profiles.mjs';
import { createOllamaSeatClient, createReflexSeatKeeper, REFLEX_SEAT_CONTEXT, REFLEX_SEAT_OVERHEAD_GB, reflexPinEnabled, reflexSeatLine, reflexSeatPlan, registryDownloadGb } from '../lib/reflex-seat.mjs';
import { profileRuntimeEnv } from '../lib/profile.mjs';

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; console.log(`  ok - ${name}`); };

const PICK = DecisionRouter.pickDecisionModel();   // the registry's own smallest sized pick — never assumed here
const SEAT_GB = Math.round((registryDownloadGb(PICK) + REFLEX_SEAT_OVERHEAD_GB) * 100) / 100;
const WORKER_GB = MODEL_GB[FLOOR_ROLES.writer];    // the floor worker's tabled size: the default beside-figure
const M8 = { freeGb: 4.8, totalGb: 8 };            // an 8 GB device with 4.8 GB measured free

/* ---------------- registry sizes ---------------- */
{
  ok('registry size parses MB', registryDownloadGb({ downloadSize: '812MB' }) === 0.812);
  ok('registry size parses a tilde GB estimate', registryDownloadGb({ downloadSize: '~450MB' }) === 0.45);
  ok('registry size parses GB', registryDownloadGb({ downloadSize: '4.5GB' }) === 4.5);
  ok('an unknown registry size parses to null', registryDownloadGb({ downloadSize: 'unknown' }) === null && registryDownloadGb({}) === null);
  ok('every registered model has a plannable size or is never planned on', DECISION_MODEL_REGISTRY.every((r) => registryDownloadGb(r) !== null || r.name !== PICK.name));
  ok('the pick is the smallest sized model in the registry', DECISION_MODEL_REGISTRY.filter((r) => registryDownloadGb(r) !== null).every((r) => registryDownloadGb(r) >= registryDownloadGb(PICK)));
}

/* ---------------- kill switch ---------------- */
{
  ok('kill switch: KINGMAKER_REFLEX_PIN=off disables', !reflexPinEnabled({ env: { KINGMAKER_REFLEX_PIN: 'off' } }));
  ok('kill switch: 0, false and no disable', !reflexPinEnabled({ env: { KINGMAKER_REFLEX_PIN: '0' } }) && !reflexPinEnabled({ env: { KINGMAKER_REFLEX_PIN: 'false' } }) && !reflexPinEnabled({ env: { KINGMAKER_REFLEX_PIN: 'no' } }));
  ok('kill switch: config on:false disables', !reflexPinEnabled({ env: {}, config: { on: false } }) && !reflexPinEnabled({ env: {}, config: false }));
  ok('kill switch: env beats config', !reflexPinEnabled({ env: { KINGMAKER_REFLEX_PIN: 'off' }, config: { on: true } }));
  ok('pin is on by default', reflexPinEnabled({ env: {} }) && reflexPinEnabled({ env: { KINGMAKER_REFLEX_PIN: 'on' } }));
}

/* ---------------- the plan, on the tree's own numbers ---------------- */
{
  const plan = reflexSeatPlan({ measured: M8, env: {} });
  ok('the plan is active when the pair fits the measured free memory', plan.active);
  ok('the seat model is the registry pick', plan.model === PICK.name);
  ok('the budget is the measured free memory', plan.budgetGb === 4.8);
  ok('the device is recorded on the plan', plan.device.freeGb === 4.8 && plan.device.totalGb === 8);
  ok('the worker beside-figure defaults to the floor worker\'s tabled size', plan.workerGb === WORKER_GB);
  ok('the seat size is the registry size plus the measured runner allowance', plan.seatGb === SEAT_GB);
  ok('the seat cap is what the free memory leaves beside the worker', plan.seatCapGb === Math.round((4.8 - WORKER_GB) * 100) / 100);
  ok('the seat fits its cap', plan.seatGb <= plan.seatCapGb);
  ok('the planned pair fits the budget: worker + seat <= free', plan.pairGb === Math.round((plan.workerGb + plan.seatGb) * 100) / 100 && plan.pairGb <= plan.budgetGb);
  ok('the exception allows exactly one extra loaded model', plan.maxLoadedModels === 2);
  ok('the line names the seat, the pair and the budget', reflexSeatLine(plan).includes(plan.model) && reflexSeatLine(plan).includes(String(plan.pairGb)) && reflexSeatLine(plan).includes(String(plan.budgetGb)));
}
{
  // A registry pick too big for the cap never pins: the plan refuses on the measured arithmetic.
  const big = reflexSeatPlan({ measured: M8, env: {}, pick: () => ({ name: 'huge', downloadSize: '9.5GB' }) });
  ok('an oversize pick is refused by the seat cap', !big.active && big.seatGb > big.seatCapGb && /leaves only/.test(big.reason));
  const unknown = reflexSeatPlan({ measured: M8, env: {}, pick: () => ({ name: 'mystery', downloadSize: 'unknown' }) });
  ok('an unknown-size pick is refused', !unknown.active && /unknown size/.test(unknown.reason));
  const none = reflexSeatPlan({ measured: M8, env: {}, pick: () => { throw new Error('none'); } });
  ok('no registered pick means no seat', !none.active && /no registered decision model/.test(none.reason));
  const notInstalled = reflexSeatPlan({ measured: M8, env: {}, installed: ['some/other-model:latest'] });
  ok('a seat is only planned for an installed model', !notInstalled.active && /not installed/.test(notInstalled.reason));
  const installed = reflexSeatPlan({ measured: M8, env: {}, installed: [`${PICK.name}:latest`] });
  ok('an installed pick (tag form) plans active', installed.active);
}
{
  // The same arithmetic at every size — the seat is not a small-Mac exception anymore: a bigger device
  // with room plans it too, and a tight device of any size does not.
  const big = reflexSeatPlan({ measured: { freeGb: 12, totalGb: 16 }, env: {} });
  ok('a 16 GB device with room plans the seat by the same arithmetic', big.active && big.maxLoadedModels === 2);
  const tight = reflexSeatPlan({ measured: { freeGb: 2.5, totalGb: 8 }, env: {} });
  ok('a tight device does not plan it (worker + seat > free)', !tight.active && tight.maxLoadedModels === 1 && /leaves only/.test(tight.reason));
  const unmeasured = reflexSeatPlan({ measured: null, env: {} });
  ok('no measured memory, no plan — never a guess', !unmeasured.active && /no measured free memory/.test(unmeasured.reason));
  const off = reflexSeatPlan({ measured: M8, env: { KINGMAKER_REFLEX_PIN: 'off' } });
  ok('kill switch off: the plan is inactive and the single slot stands', !off.active && off.maxLoadedModels === 1 && /kill switch/.test(off.reason));
  ok('kill switch off: the line says the strict rule stands', /strict 1-model rule stands/.test(reflexSeatLine(off)));
}

/* ---------------- the keeper, against a fake Ollama ---------------- */
const fakeOllama = (initial = []) => {
  const loadedSet = new Set(initial); const calls = [];
  return {
    calls, loadedSet,
    async load(model, opts = {}) { calls.push(['load', model, opts]); loadedSet.add(model); },
    async unload(model) { calls.push(['unload', model]); loadedSet.delete(model); },
    async loaded() { return [...loadedSet]; },
  };
};
const plan8 = () => reflexSeatPlan({ measured: M8, env: {} });

{
  const client = fakeOllama();
  const keeper = createReflexSeatKeeper({ plan: plan8(), client });
  const pin = await keeper.pin();
  ok('pin loads the registry pick', pin.pinned && client.loadedSet.has(PICK.name));
  const pinCall = client.calls.find(([op, m]) => op === 'load' && m === PICK.name);
  ok('the seat loads pinned: keep_alive -1, never to expire', pinCall[2].keepAlive === -1);
  ok('the seat loads capped: the 2k seat context', pinCall[2].numCtx === REFLEX_SEAT_CONTEXT);
  // Worker churn: writer -> coder -> vision -> writer. The seat survives every cycle.
  ok('worker loads beside the seat', (await keeper.loadWorker(GRANITE_8GB, 2.5)).ok);
  ok('coder swap loads', (await keeper.loadWorker('coder-model', 1.3)).ok);
  ok('the outgoing worker was evicted by the swap', !client.loadedSet.has(GRANITE_8GB));
  ok('vision swap loads', (await keeper.loadWorker('vision-model', 2.2)).ok);
  ok('the seat survived every churn cycle', client.loadedSet.has(PICK.name) && client.loadedSet.size === 2);
  ok('no unload call ever named the seat', !client.calls.some(([op, m]) => op === 'unload' && m === PICK.name));
  const st = keeper.status();
  ok('status reports the pinned seat and the live pair vs budget', st.pinned && st.model === PICK.name && st.pairGb === Math.round((st.seatGb + 2.2) * 100) / 100 && st.budgetGb === 4.8 && st.headroomGb > 0);
}
{
  const client = fakeOllama();
  const keeper = createReflexSeatKeeper({ plan: plan8(), client });
  await keeper.pin();
  await keeper.loadWorker(GRANITE_8GB, 2.5);
  const refused = await keeper.unload(PICK.name);
  ok('an explicit unload of the pinned seat is refused', refused.refused === true && /never evicts/.test(refused.reason));
  ok('the seat is still loaded after the refused unload', client.loadedSet.has(PICK.name));
  const gone = await keeper.unload(GRANITE_8GB);
  ok('a worker unload still works', gone.ok && !client.loadedSet.has(GRANITE_8GB));
}
{
  // The pair cap fires at the arithmetic boundary: exactly at the budget loads; a hair over is refused
  // before anything is loaded or unloaded.
  const plan = plan8();
  const client = fakeOllama();
  const keeper = createReflexSeatKeeper({ plan, client });
  await keeper.pin();
  const atCap = await keeper.loadWorker('at-cap-worker', plan.budgetGb - plan.seatGb);
  ok('a worker exactly filling the budget loads', atCap.ok && atCap.pairGb === plan.budgetGb);
  const callsBefore = client.calls.length;
  const over = await keeper.loadWorker('over-cap-worker', plan.budgetGb - plan.seatGb + 0.01);
  ok('a worker a hair over the budget is refused', over.refused === true && over.pairGb > over.budgetGb);
  ok('the refusal carries the arithmetic', /over the plan's/.test(over.reason) && over.reason.includes('pinned reflex seat'));
  ok('a refused load touched nothing', client.calls.length === callsBefore && client.loadedSet.has('at-cap-worker') && !client.loadedSet.has('over-cap-worker'));
  const noSize = await keeper.loadWorker('unsized', Number.NaN).catch((e) => e);
  ok('a worker load must declare its size', noSize instanceof Error);
}
{
  // Kill switch: the keeper is the legacy single slot again — pinning is a no-op and a worker load evicts
  // the decision model, the exact contention this module exists to remove.
  const legacyPlan = reflexSeatPlan({ measured: M8, env: { KINGMAKER_REFLEX_PIN: 'off' } });
  const client = fakeOllama([PICK.name]);
  const keeper = createReflexSeatKeeper({ plan: legacyPlan, client });
  ok('kill switch: pin is a no-op', (await keeper.pin()).pinned === false && !client.calls.some(([op]) => op === 'load'));
  const r = await keeper.loadWorker(GRANITE_8GB, 2.5);
  ok('kill switch: the worker loads under the strict single slot', r.ok && client.loadedSet.has(GRANITE_8GB));
  ok('kill switch: the decision model is evicted, exactly as before', !client.loadedSet.has(PICK.name) && client.loadedSet.size === 1);
  ok('kill switch: status shows no pin and no extra slot', keeper.status().pinned === false && keeper.status().maxLoadedModels === 1);
}
{
  // The real client speaks Ollama's endpoints: an empty generate with keep_alive loads/unloads; /api/ps lists.
  const seen = [];
  const fetchImpl = async (url, opts = {}) => {
    seen.push([url, opts.body ? JSON.parse(opts.body) : null]);
    return { ok: true, json: async () => ({ models: [{ name: PICK.name }, { name: GRANITE_8GB }] }) };
  };
  const client = createOllamaSeatClient({ baseUrl: 'http://127.0.0.1:11434/', fetchImpl });
  await client.load(PICK.name, { keepAlive: -1, numCtx: REFLEX_SEAT_CONTEXT });
  ok('client load posts an empty generate with keep_alive and the seat context', seen[0][0].endsWith('/api/generate') && seen[0][1].keep_alive === -1 && seen[0][1].options.num_ctx === REFLEX_SEAT_CONTEXT && seen[0][1].model === PICK.name);
  await client.unload(PICK.name);
  ok('client unload posts keep_alive 0', seen[1][1].keep_alive === 0);
  ok('client lists resident models from /api/ps', (await client.loaded()).includes(GRANITE_8GB) && seen[2][0].endsWith('/api/ps'));
}

/* ---------------- the engine env contract (lib/profile.mjs) ---------------- */
{
  const on = profileRuntimeEnv([`${PICK.name}:latest`], 8, {}, 4.8);
  ok('env: the seat installed and the pair fits allows the pair', on.OLLAMA_MAX_LOADED_MODELS === '2');
  ok('env: the pinned seat is named for the engine', on.KINGMAKER_REFLEX_PINNED_MODEL === PICK.name);
  const off = profileRuntimeEnv([`${PICK.name}:latest`], 8, { KINGMAKER_REFLEX_PIN: 'off' }, 4.8);
  ok('env: kill switch restores the strict single slot, no pin named', off.OLLAMA_MAX_LOADED_MODELS === '1' && !('KINGMAKER_REFLEX_PINNED_MODEL' in off));
  const missing = profileRuntimeEnv([], 8, {}, 4.8);
  ok('env: no seat installed, no exception', missing.OLLAMA_MAX_LOADED_MODELS === '1' && !('KINGMAKER_REFLEX_PINNED_MODEL' in missing));
  const big = profileRuntimeEnv([`${PICK.name}:latest`], 16, {}, 12);
  ok('env: a bigger device plans the seat by the same measured arithmetic', big.OLLAMA_MAX_LOADED_MODELS === '2' && big.KINGMAKER_REFLEX_PINNED_MODEL === PICK.name);
  const tight = profileRuntimeEnv([`${PICK.name}:latest`], 8, {}, 2.5);
  ok('env: a tight device keeps the single slot', tight.OLLAMA_MAX_LOADED_MODELS === '1' && !('KINGMAKER_REFLEX_PINNED_MODEL' in tight));
}

console.log(`\nreflex-coresidency: ${passed} passed`);
