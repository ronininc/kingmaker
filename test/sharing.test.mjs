// Community sharing (lib/sharing.mjs): on by default, a real choice, nothing leaves before the box is shown.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { describePacket, fleetDraft, installationId, openSharing, SHARE_BOX, sharingWords } from '../lib/sharing.mjs';
import { newInstallationId, sanitizeForFleet, validatePacket } from '../vendor/fleet/fleet-packet.mjs';

const packet = { schema: 'solomon.fleet-contribution.v1', day: '2026-10-15', runtimeVersion: '0.9.0', deviceClass: 'darwin-arm64-24gb', artifacts: [{ kind: 'route_stats' }, { kind: 'route_stats' }, { kind: 'model_trial' }, { kind: 'preference_stats', prefs: [{ pref: 'price_first', polarity: 'always', n: 2 }] }] };
const fresh = (opts = {}) => {
  const sent = [];
  const s = openSharing({ state: mkdtempSync(join(tmpdir(), 'sharing-')), env: {}, buildPacket: async () => packet, send: async (p) => { sent.push(p); return { ok: true, receipt: 'r1' }; }, ...opts });
  return { s, sent };
};

test('on by default, but nothing leaves the Mac until the permissions box has been shown', async () => {
  const { s, sent } = fresh();
  assert.equal(s.enabled(), true);
  assert.equal(s.mayShare(), false);
  assert.deepEqual(await s.contribute(), { sent: false, why: 'box not shown' });
  assert.equal(sent.length, 0);
  const box = s.ask();
  assert.equal(box.defaultChoice, 'yes'); assert.equal(box.yes, SHARE_BOX.yes); assert.match(box.never, /words, files, screen/);
});

test('"Share" in the box: the next contribution is sent, logged exactly as sent, and the box is not asked again', async () => {
  const { s, sent } = fresh();
  assert.match(s.answer('yes'), /Sharing is on/);
  assert.equal(s.ask(), null);
  assert.equal((await s.contribute()).sent, true);
  assert.equal(sent.length, 1);
  const logged = JSON.parse(readFileSync(s.logPath, 'utf8').trim());
  assert.deepEqual(logged.packet, packet); assert.equal(logged.receipt, 'r1');
  const rec = JSON.parse(readFileSync(s.recordPath, 'utf8'));
  assert.equal(rec.on, true); assert.equal(rec.shown, true); assert.equal(rec.by, 'owner'); assert.equal(rec.wording, SHARE_BOX.version);
});

test('"Keep it on this Mac", "sharing off", learning off or the install: nothing is sent', async () => {
  const a = fresh(); a.s.answer('no');
  assert.equal(a.s.enabled(), false); assert.deepEqual(await a.s.contribute(), { sent: false, why: 'off' }); assert.equal(a.sent.length, 0);
  assert.match(await a.s.handle('sharing on'), /Sharing is on/); assert.equal(a.s.mayShare(), true);
  assert.match(await a.s.handle('Sharing off.'), /Kept on this Mac/); assert.equal(a.s.mayShare(), false);
  const b = fresh({ learningOn: () => false }); b.s.answer('yes');
  assert.equal(b.s.mayShare(), false, 'learning off stops sharing'); assert.equal(b.s.ask(), null);
  const c = fresh({ env: { KINGMAKER_SHARING: 'off' } }); c.s.answer('yes');
  assert.equal(c.s.mayShare(), false); assert.equal((await c.s.contribute()).sent, false);
});

test('an invalid packet is never sent; with no server yet it is logged locally as not sent', async () => {
  const bad = fresh({ validate: () => ({ ok: false, errors: ['free text'] }) }); bad.s.answer('yes');
  assert.deepEqual(await bad.s.contribute(), { sent: false, why: 'invalid packet' }); assert.equal(bad.sent.length, 0);
  assert.equal(existsSync(bad.s.logPath), false);
  const none = fresh({ send: null }); none.s.answer('yes');
  assert.deepEqual(await none.s.contribute(), { sent: false, why: 'no server' });
  assert.match(readFileSync(none.s.logPath, 'utf8'), /no community server yet/);
});

test('the bar words: "what have you shared" reads the log back; "forget what I shared" is honest when the server is not live', async () => {
  assert.deepEqual(sharingWords('what have you shared'), { op: 'log' });
  assert.deepEqual(sharingWords('Forget what I shared.'), { op: 'forget' });
  assert.equal(sharingWords('share this file with Maria'), null, 'ordinary requests are not sharing words');
  const { s } = fresh(); s.answer('yes');
  assert.match(await s.handle('what have you shared'), /Nothing has been shared/);
  await s.contribute();
  const line = await s.handle('what have you shared');
  assert.match(line, /2 route stats, 1 model trial, 1 preference stats \[price first always ×2\]/); assert.match(line, /darwin-arm64-24gb/);
  assert.match(await s.handle('forget what I shared'), /isn't live yet/);
  assert.equal(describePacket({}), '?: nothing (Kingmaker ?, device class not set)');
});

test('the packet this Mac builds: the engine\'s own sanitizer; a random install id kept on the Mac; preferences as kinds only', () => {
  const state = mkdtempSync(join(tmpdir(), 'sharing-'));
  const id = installationId(state, newInstallationId);
  assert.match(id, /^fi_[a-f0-9]{32}$/); assert.equal(installationId(state, newInstallationId), id, 'made once, then kept');
  const { packet: p } = sanitizeForFleet(fleetDraft({ id, version: '0.9.0', totalMemBytes: 8 * 1024 ** 3,
    preferences: [{ statement: 'Always give me the price first' }, { statement: 'email maria@acme.com every Monday' }] }));
  assert.equal(validatePacket(p).ok, true);
  assert.equal(p.deviceClass, 'darwin-arm64-8gb');
  assert.doesNotMatch(JSON.stringify(p), /maria|acme|monday|price first/i, 'no preference words travel');
  assert.match(describePacket(p), /price first always ×1/);
});
