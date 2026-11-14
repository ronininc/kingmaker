// The inbound DM bridge from Kingmaker's side (lib/dms.mjs, lib/cli.mjs wiring, lib/profile.mjs switch): the pause
// words, :dms on/off/status, the status line, and the console wiring (typed-only enable, pause ahead of every lane).
import './_bind.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { dmsCommand, dmsStatusLine, isStopForwarding } from '../dms.mjs';

test('the pause words', () => {
  for (const s of ['stop forwarding', 'pause forwarding', 'Stop forwarding my DMs', 'pause message forwarding', 'stop sending my messages to the CRM', 'turn off forwarding', 'hey seeker, pause forwarding now']) assert.ok(isStopForwarding(s), s);
  for (const s of ['forward this to Dana', 'stop approving', 'what came in', 'resume forwarding', 'brief me']) assert.ok(!isStopForwarding(s), s);
});

test(':dms on / off / status', () => {
  assert.equal(dmsCommand(':dms on'), 'on');
  assert.equal(dmsCommand(':dms off'), 'off');
  assert.equal(dmsCommand(':dms pause'), 'off');
  assert.equal(dmsCommand(':dms'), 'status');
  assert.equal(dmsCommand(':dms status'), 'status');
  assert.equal(dmsCommand('dms on'), null, 'only the typed console command');
  assert.equal(dmsCommand(':approvals on'), null);
});

test('status lines say why it is off and that replies stay drafts', () => {
  assert.match(dmsStatusLine({ state: 'running', scope: 'all' }), /on: forwarding everything, tagged.*never sent/);
  assert.match(dmsStatusLine({ state: 'running', scope: 'business' }), /business only/);
  assert.match(dmsStatusLine({ state: 'never-enabled' }), /:dms on/);
  assert.match(dmsStatusLine({ state: 'paused', pausedVia: 'voice' }), /paused \(voice\)/);
  assert.match(dmsStatusLine({ state: 'no-crm' }), /no CRM/);
  assert.match(dmsStatusLine(null), /did not answer/);
});

test('cli wiring: pause before every lane, enable typed only; profile carries the one-line scope switch', () => {
  const cli = readFileSync(new URL('../../../lib/cli.mjs', import.meta.url), 'utf8');
  assert.match(cli, /const routeTurn = async \(text, opts, who\) => \{\s*(?:\/\/[^\n]*\n\s*)+const guarded = await barGuard\.handle\(text/, 'routeTurn runs the bar guard (kill switches, duress) before the desk, the brain or the core; behaviour is proven in bar-guard.test.mjs');
  assert.match(cli, /dmsCommand\(line\)[\s\S]{0,200}dms === 'on'[\s\S]{0,200}DMS_ROUTE\}\/enable/, ':dms on is in the typed console handler');
  assert.ok(!/onCommand:[^\n]*dms\/enable/.test(cli), 'voice never reaches /dms/enable');
  const lock = readFileSync(new URL('../crm-lock.mjs', import.meta.url), 'utf8');
  assert.match(lock, /^\s*SOLOMON_DM_FORWARD_SCOPE: 'all',$/m, 'one line flips it to business');
});
