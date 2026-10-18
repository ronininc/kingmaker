// The CRM calls the owner on the phone (lib/phone-ring.mjs + lib/owner-call.mjs): the same call steps and the same meaning
// of every reply as a FaceTime call; and the Web Push that rings a closed app (lib/web-push.mjs), decrypted as a phone would.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRinger, createPhoneRunners } from '../lib/phone-ring.mjs';
import { encryptPush, sendPush, vapidHeader, vapidKeys } from '../lib/web-push.mjs';

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

test('one ring at a time; a stale phone action is refused', async () => {
  const r = createRinger({ reachable: () => true });
  await r.ring({ id: 'a' });
  await assert.rejects(r.ring({ id: 'b' }));
  assert.equal(r.answer('b'), false); assert.equal(r.answer('a'), true); assert.equal(r.connected(), true);
  r.end(); assert.equal(r.connected(), false); assert.equal(r.heard('a', 'x'), false);
});

test('web push: the message decrypts with the phone\'s keys (RFC 8291) and the VAPID token verifies (RFC 8292)', async () => {
  const ua = createECDH('prime256v1'); ua.generateKeys(); const auth = randomBytes(16);
  const sub = { endpoint: 'https://web.push.apple.com/QSomething', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
  const body = encryptPush(JSON.stringify({ type: 'ring', id: 'x', caller: 'Codex' }), sub.keys);
  // Decrypt as the phone does.
  const salt = body.subarray(0, 16), idlen = body[20], asPub = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  const shared = ua.computeSecret(asPub);
  const ikm = Buffer.from(hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPub]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = createDecipheriv('aes-128-gcm', cek, nonce); d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.equal(plain.at(-1), 2); assert.deepEqual(JSON.parse(plain.subarray(0, -1)), { type: 'ring', id: 'x', caller: 'Codex' });
  // VAPID: a JWT for the push service's origin, signed by this Mac's key (kept in the data folder).
  const dir = mkdtempSync(join(tmpdir(), 'km-vapid-'));
  try {
    const v = vapidKeys(dir); assert.equal(vapidKeys(dir).publicKey, v.publicKey, 'made once, then the same');
    const h = vapidHeader(sub.endpoint, v, { now: 1_800_000_000_000 });
    const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(h); const [hd, cl, sig] = jwt.split('.');
    assert.equal(JSON.parse(Buffer.from(cl, 'base64url')).aud, 'https://web.push.apple.com');
    const p = Buffer.from(k, 'base64url'), pub = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: p.subarray(1, 33).toString('base64url'), y: p.subarray(33).toString('base64url') }, format: 'jwk' });
    assert.ok(verify('sha256', Buffer.from(`${hd}.${cl}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
    const sent = []; const r = await sendPush(sub, { type: 'ring' }, v, { fetchImpl: async (u, o) => (sent.push([u, o]), { status: 201 }) });
    assert.equal(r.ok, true); assert.equal(sent[0][1].headers['content-encoding'], 'aes128gcm'); assert.match(sent[0][1].headers.authorization, /^vapid t=/);
    assert.equal((await sendPush(sub, {}, v, { fetchImpl: async () => ({ status: 410 }) })).gone, true, 'a dropped subscription is forgotten');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
