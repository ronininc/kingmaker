// Kingmaker's Little Brother client (lib/armor-little-brother.mjs). The end-to-end run against a real Armor lb-host/2
// process (test issuer, 127.0.0.1 fixture) is proofs/release-readiness-2026-11-17/repro/kingmaker-lb-e2e.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ArmorUnavailableError } from '../lib/armor-connection.mjs';
import { LB_EVENTS, armorIdentityDir, lbEventToPanel, littleBrotherAccess, runLittleBrother } from '../lib/armor-little-brother.mjs';

test('no usable Armor: access reports the refusal; a run throws before anything is spawned', async () => {
  const locate = () => { throw new ArmorUnavailableError('ARMOR_MISSING', 'none'); };
  const a = await littleBrotherAccess({ locate });
  assert.equal(a.allowed, false); assert.equal(a.state, 'armor-unavailable'); assert.equal(a.code, 'ARMOR_MISSING');
  await assert.rejects(runLittleBrother({ locate, scopeId: 's1', plan: [] }), (e) => e.code === 'ARMOR_MISSING');
  await assert.rejects(runLittleBrother({ locate, scopeId: '../x', plan: [] }), /LB_SCOPE_ID_REQUIRED/);
});

test('panel mapping carries only real counts — never a percentage', () => {
  const ev = (type, extra) => ({ schema: LB_EVENTS, runId: 'r', seq: 1, at: 'x', type, ...extra });
  assert.deepEqual(lbEventToPanel(ev('start', { stepsTotal: 2 })), { phase: 'started', steps: { done: 0, total: 2 } });
  const p = lbEventToPanel(ev('progress', { phase: 'tool-stats', stepsCompleted: 1, stepsTotal: 2, counts: { requests: 2, total: 3 }, findingsSoFar: 1 }));
  assert.deepEqual(p, { phase: 'tool-stats', steps: { done: 1, total: 2 }, tool: { requests: 2, total: 3 }, findings: 1 });
  assert.equal(lbEventToPanel({ type: 'progress' }), null, 'foreign events are ignored');
  for (const t of ['start', 'progress', 'output', 'finding', 'error', 'done']) assert.doesNotMatch(JSON.stringify(lbEventToPanel(ev(t, { stepsTotal: 1, stepsCompleted: 1, tool: 'curl', line: 'x', stage: 's', code: 'c', message: 'm', status: 'completed', findings: 0 }))), /percent/i);
});

test('identity folder: Armor standalone default, overridable for tests', () => {
  assert.match(armorIdentityDir({ HOME: '/h' }), /\/h\/\.scripture-armor$/);
  assert.equal(armorIdentityDir({ HOME: '/h', KINGMAKER_ARMOR_IDENTITY_DIR: '/x' }), '/x');
});
