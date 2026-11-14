// The delegated approvals from Kingmaker's side (lib/approvals.mjs, lib/phone.mjs textOwner, lib/cli.mjs wiring):
// the kill switch words, :approvals on/off/status, problem alerts said only when awake and texted only to the
// owner's own number, never replayed, and the console wiring (typed-only enable, kill switch ahead of every lane).
import './_bind.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { approvalsCommand, createApprovalAlerts, isStopApproving, statusLine } from '../approvals.mjs';
import { textOwner } from '../../../lib/phone.mjs';

test('the kill switch words', () => {
  for (const s of ['stop approving', 'Pause approvals.', 'stop auto-approving now', 'turn approvals off', 'turn off approvals', 'Hey Seeker, stop approving', 'no more approvals'])
    assert.ok(isStopApproving(s), s);
  for (const s of ['approve it', 'stop the music', 'what are you approving?', 'how many approvals are pending', 'turn approvals on'])
    assert.ok(!isStopApproving(s), s);
});

test(':approvals on / off / status', () => {
  assert.equal(approvalsCommand(':approvals on'), 'on');
  assert.equal(approvalsCommand(':approvals off'), 'off');
  assert.equal(approvalsCommand(':approvals pause'), 'off');
  assert.equal(approvalsCommand(':approvals'), 'status');
  assert.equal(approvalsCommand('approvals on'), null, 'only the typed console command');
  assert.equal(approvalsCommand(':approvals yes'), null);
});

test('status lines say why it is off', () => {
  assert.match(statusLine({ state: 'no-token', seats: {} }), /:key ronin-approver/);
  assert.match(statusLine({ state: 'never-enabled', seats: { approver: true } }), /:approvals on/);
  assert.match(statusLine({ state: 'running', intervalMs: 240_000, localCeilingCents: 2000, maxPerTick: 5, seats: { approver: true, seeker: true, local: true }, docked: true }), /every 4 min, local ceiling \$20\.00/);
});

test('alerts: printed always, said only when awake, texted, each once, old snapshot not replayed', async () => {
  const out = []; const said = []; const texts = [];
  let awake = false;
  const on = createApprovalAlerts({ out: (l) => out.push(l), announce: (l) => said.push(l), isAwake: () => awake, text: async (t) => { texts.push(t); return { ok: true }; }, armedAtMs: Date.parse('2026-10-09T12:00:00Z') });
  await on({ type: 'approver.snapshot', data: { alerts: [{ id: 'old', kind: 'escalation', line: 'old one', at: '2026-10-09T11:00:00Z' }] } });
  assert.equal(out.length, 0, 'an alert from before this run is not replayed');
  await on({ type: 'approver.alert', data: { id: 'a1', kind: 'conflict_409', line: 'The CRM answered 409.', at: '2026-10-09T12:01:00Z' } });
  assert.deepEqual([out.length, said.length, texts.length], [1, 0, 1], 'asleep: printed + texted, not said');
  awake = true;
  await on({ type: 'approver.alert', data: { id: 'a2', kind: 'kronos_stale', line: 'Kronos is stale.', at: '2026-10-09T12:02:00Z' } });
  await on({ type: 'approver.alert', data: { id: 'a2', kind: 'kronos_stale', line: 'Kronos is stale.', at: '2026-10-09T12:02:00Z' } });
  assert.deepEqual([out.length, said.length, texts.length], [2, 1, 2], 'awake: said too; a repeat id is ignored');
  assert.match(texts[0], /^Kingmaker: /);
});

test('textOwner texts only the saved owner number, through Twilio Messages', async () => {
  const calls = [];
  const phone = { sid: `AC${'a'.repeat(32)}`, token: 'b'.repeat(32), from: '+16025550100', to: '+16025550199' };
  const r = await textOwner('A 409 on trade AAPL.', { phone, fetchImpl: async (url, init) => { calls.push({ url, body: String(init.body) }); return new Response('{"sid":"SM1"}', { status: 201 }); } });
  assert.ok(r.ok);
  assert.match(calls[0].url, /^https:\/\/api\.twilio\.com\/2010-04-01\/Accounts\/AC[a]{32}\/Messages\.json$/);
  const body = new URLSearchParams(calls[0].body);
  assert.equal(body.get('To'), '+16025550199');
  assert.equal(body.get('From'), '+16025550100');
  assert.equal((await textOwner('x', { phone: null })).ok, false, 'not set up: nothing sent');
});

test('cli wiring: kill switch first, enable typed only, Seeker undocks on stop, alert stream followed', () => {
  const cli = readFileSync(new URL('../../../lib/cli.mjs', import.meta.url), 'utf8');
  assert.match(cli, /const routeTurn = async \(text, opts, who\) => \{\s*(?:\/\/[^\n]*\n\s*)+const guarded = await barGuard\.handle\(text/, 'routeTurn runs the bar guard (kill switches, duress) before the desk, the brain or the core; behaviour is proven in bar-guard.test.mjs');
  assert.match(cli, /approvalsCommand\(line\)[\s\S]{0,200}approvals === 'on'[\s\S]{0,200}\/enable/, ':approvals on is in the typed console handler');
  assert.ok(!/onCommand:[^\n]*\/enable/.test(cli), 'voice never reaches /enable');
  assert.match(cli, /seats\/stop[\s\S]{0,200}\(supervisor \?\? backend\)\.stop\(\)/, 'undock before the core stops');
  assert.match(cli, /name: 'approver_alerts'/);
});
