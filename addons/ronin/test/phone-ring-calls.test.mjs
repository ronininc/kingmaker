// (Ronin add-on part of test/phone-ring.test.mjs) The CRM calls the owner on the phone (lib/phone-ring.mjs + lib/owner-call.mjs): the same call steps and the same meaning
// of every reply as a FaceTime call; and the Web Push that rings a closed app (lib/web-push.mjs), decrypted as a phone would.
import './_bind.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRinger, createPhoneRunners } from '../../../lib/phone-ring.mjs';
import { encryptPush, sendPush, vapidHeader, vapidKeys } from '../../../lib/web-push.mjs';
import { createOwnerCallLoop, placeOwnerCall } from '../owner-call.mjs';

/** A phone that answers, plays every line and replies `reply` when asked (or declines). */
function fakePhone({ reply = 'Thanks, got it.', decline = false } = {}) {
  const seen = []; let ringer = null;
  const broadcast = (event, data) => {
    seen.push([event, data]);
    setTimeout(() => {
      if (event === 'ring') return decline ? ringer.decline(data.id) : ringer.answer(data.id);
      if (event === 'ring-say') return ringer.played(data.id, data.seq);
      if (event === 'ring-listen') return ringer.heard(data.id, reply);
    }, 5);
  };
  ringer = createRinger({ broadcast, reachable: () => true });
  return { ringer, seen, said: () => seen.filter(([e]) => e === 'ring-say').map(([, d]) => d.text) };
}
const transport = () => { const calls = []; return { calls,
  start: async (b) => (calls.push(['start', b]), { ok: true, id: b.id, kind: 'message', caller: 'codex', caller_name: 'Codex', message: 'The deploy finished.' }),
  answered: async (b) => (calls.push(['answered', b]), { ok: true }), missed: async (b) => (calls.push(['missed', b]), { ok: true }),
  result: async (b) => (calls.push(['result', b]), { ok: true }) }; };
const call = { id: 'req-msg-1', kind: 'message', caller: 'codex', caller_name: 'Codex', message: 'The deploy finished.' };

test('a CRM message call on the phone: it rings, the message is spoken, the reply goes back as information', async () => {
  const phone = fakePhone({ reply: 'Great, tell them thanks.' }), t = transport();
  const r = await placeOwnerCall(call, { transport: t, mac: createPhoneRunners(phone.ringer, call), handle: '', sessionId: 's1', pollMs: 10 });
  assert.equal(r.outcome, 'reply'); assert.equal(r.transcript, 'Great, tell them thanks.');
  assert.deepEqual(t.calls.map(([k]) => k), ['start', 'answered', 'result']);
  assert.equal(t.calls[2][1].outcome, 'reply');
  assert.ok(phone.said().some((l) => /The deploy finished\./.test(l)), 'the message was said on the phone');
  assert.equal(phone.ringer.active(), null, 'the call is over');
  assert.equal(phone.seen.at(-1)[0], 'ring-end');
});

test('declined on the phone: a missed call, nothing reported as a reply', async () => {
  const phone = fakePhone({ decline: true }), t = transport();
  const r = await placeOwnerCall(call, { transport: t, mac: createPhoneRunners(phone.ringer, call), handle: '', sessionId: 's2', pollMs: 10, connectTimeoutMs: 400 });
  assert.equal(r.outcome, 'missed'); assert.ok(t.calls.some(([k]) => k === 'missed')); assert.ok(!t.calls.some(([k]) => k === 'result'));
});

test('the loop rings the phone first; with no phone it needs the FaceTime handle', async () => {
  const phone = fakePhone(), t = transport();
  const loop = createOwnerCallLoop({ paths: { state: '/nonexistent' }, readConfig: () => ({ enabled: true, voices: undefined }), readSecrets: () => ({ handle: '', token: 't'.repeat(32) }),
    roninLocked: () => true, api: () => ({ ...t, pending: async () => ({ calls: [call] }) }), phone: phone.ringer, sessionId: 'loop', callOptions: { pollMs: 10 } });
  const r = await loop.tick();
  assert.equal(r.outcome, 'reply');
  const none = createOwnerCallLoop({ paths: { state: '/nonexistent' }, readConfig: () => ({ enabled: true }), readSecrets: () => ({ handle: '', token: 't'.repeat(32) }),
    roninLocked: () => true, api: () => ({ ...t, pending: async () => ({ calls: [call] }) }), phone: createRinger({ reachable: () => false }), sessionId: 'loop2' });
  assert.equal((await none.tick()).reason, 'not_set_up');
});

