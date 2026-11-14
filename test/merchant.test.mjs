// Merchant ops / Clover write-lane as a Kingmaker handle (lib/merchant.mjs, the `merchant` CLI verb, the
// kingmaker_merchant_dryrun MCP tool). Hermetic: the engine is a fake fetch. The governance shape is the point —
// a dry-run proposes (no nonce), apply is an owner write (operatorConfirmed + launch nonce), and the MCP surface
// can only dry-run, never apply.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyOutcome, cloverApplyBody, cloverIntentBody, diffLines } from '../lib/merchant.mjs';
import { callTool, TOOLS } from '../lib/mcp.mjs';
import { cloverApply, cloverDryRun } from '../lib/client.mjs';
import { DESKTOP_NONCE_HEADER } from '../lib/profile.mjs';
import { COMMAND_GROUPS } from '../lib/command-list.mjs';

function fakeEngine(answers = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const entry = { path, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : null };
    calls.push(entry);
    const res = answers[path]?.(entry) ?? { status: 200, json: { ok: false } };
    return { ok: (res.status ?? 200) < 400, status: res.status ?? 200, json: async () => res.json };
  };
  return { calls, fetchImpl };
}

test('cloverIntentBody: fixture sets fixtureMode; flags map to the engine fields; empties are omitted', () => {
  assert.deepEqual(cloverIntentBody({ fixture: true }), { fixtureMode: true });
  assert.deepEqual(cloverIntentBody({ merchant: 'Donatita', item: 'chilaquiles', maxSelections: 3 }), { merchantName: 'Donatita', targetItemLabel: 'chilaquiles', requestedMaxSelections: 3 });
  assert.deepEqual(cloverIntentBody({}), {});
  assert.deepEqual(cloverIntentBody({ maxSelections: 0 }), {}, '0 is not a valid selection count');
});

test('cloverApplyBody always carries operatorConfirmed and reuses the dry-run diff', () => {
  const b = cloverApplyBody({ fixtureMode: true }, { validatedTarget: { v: 1 }, dryRunDiff: { diffId: 'd1' } });
  assert.equal(b.operatorConfirmed, true);
  assert.equal(b.fixtureMode, true);
  assert.deepEqual(b.validatedTarget, { v: 1 });
  assert.deepEqual(b.validatedDryRunDiff, { diffId: 'd1' });
});

test('applyOutcome never reports a write that did not happen', () => {
  assert.equal(applyOutcome(200, { applied: true, missionActionLedgerId: 'L1', missionActionState: 'EXECUTED' }).applied, true);
  assert.equal(applyOutcome(409, { applied: false, error: 'CLOVER_WRITE_CONFIG_REQUIRED' }).applied, false);
  assert.match(applyOutcome(409, { error: 'CLOVER_WRITE_CONFIG_REQUIRED' }).line, /not touched|CLOVER_WRITE_CONFIG_REQUIRED/);
  assert.equal(applyOutcome(409, { error: 'CLOVER_APPLY_FAIL_CLOSED' }).applied, false);
});

test('diffLines summarizes stable fields only', () => {
  const lines = diffLines({ status: 'DRY_RUN_READY', applyEnabled: false, executionAllowed: false, validatedDryRunDiffId: 'd9', dryRunDiff: { operation: 'ADD_MODIFIER', merchantName: 'Donatita' }, validatedTarget: { validationStatus: 'VALIDATED' } });
  assert.match(lines[0], /DRY_RUN_READY/);
  assert.match(lines.join('\n'), /d9.*ADD_MODIFIER.*Donatita/s);
  assert.match(lines.join('\n'), /VALIDATED/);
});

test('client: a dry-run carries no nonce; apply refuses locally without one and sends operatorConfirmed + nonce with one', async () => {
  const engine = fakeEngine({
    '/api/merchant-ops/clover/dry-run': () => ({ status: 200, json: { ok: true, data: { status: 'DRY_RUN_READY', applyEnabled: false, dryRunDiff: { diffId: 'd1' } } } }),
    '/api/merchant-ops/clover/apply': (c) => (c.body?.operatorConfirmed === true ? { status: 409, json: { ok: false, error: 'CLOVER_WRITE_CONFIG_REQUIRED', data: { applied: false, status: 'CLOVER_WRITE_CONFIG_REQUIRED' } } } : { status: 409, json: { ok: false, error: 'CLOVER_APPLY_FAIL_CLOSED' } }),
  });
  const dr = await cloverDryRun(3001, { fixtureMode: true }, { fetchImpl: engine.fetchImpl });
  assert.equal(dr.json.data.status, 'DRY_RUN_READY');
  assert.ok(!Object.keys(engine.calls.at(-1).headers).some((h) => h === DESKTOP_NONCE_HEADER), 'dry-run sends no nonce');

  await assert.rejects(cloverApply(3001, { operatorConfirmed: true }, { fetchImpl: engine.fetchImpl }), /OWNER_NONCE_REQUIRED/);
  const nonce = 'z'.repeat(40);
  const ap = await cloverApply(3001, cloverApplyBody({ fixtureMode: true }, dr.json.data), { nonce, fetchImpl: engine.fetchImpl });
  const post = engine.calls.at(-1);
  assert.equal(post.headers[DESKTOP_NONCE_HEADER], nonce);
  assert.equal(post.body.operatorConfirmed, true);
  // with no live connector the engine refuses honestly — never a fabricated success
  assert.equal(applyOutcome(ap.status, ap.json?.data).applied, false);
});

test('MCP: kingmaker_merchant_dryrun proposes only, and there is NO apply tool', async () => {
  const names = TOOLS.map((t) => t.name);
  assert.ok(names.includes('kingmaker_merchant_dryrun'));
  assert.ok(!names.some((n) => /merchant.*apply|clover.*apply|_apply$/.test(n)), 'no Clover apply tool on the MCP surface');
  const engine = fakeEngine({ '/api/merchant-ops/clover/dry-run': () => ({ status: 200, json: { ok: true, data: { status: 'DRY_RUN_READY', applyEnabled: false, validatedDryRunDiffId: 'd1', dryRunDiff: { diffId: 'd1' } } } }) });
  const res = JSON.parse((await callTool('kingmaker_merchant_dryrun', { fixture: true }, { port: 3001, fetchImpl: engine.fetchImpl })).content[0].text);
  assert.equal(res.applyEnabled, false);
  assert.equal(res.status, 'DRY_RUN_READY');
  assert.match(res.note, /owner/i);
  const call = engine.calls.at(-1);
  assert.equal(call.path, '/api/merchant-ops/clover/dry-run');
  assert.deepEqual(call.body, { fixtureMode: true });
  assert.ok(!Object.keys(call.headers).some((h) => h === DESKTOP_NONCE_HEADER), 'MCP never sends the launch nonce');
});

test('the merchant handle is on the command list', () => {
  const said = COMMAND_GROUPS.flatMap((g) => g.items).map((i) => i.say ?? '').join(' \n ');
  assert.ok(said.includes('merchant clover dry-run …'), 'merchant is listed');
});
