// lib/web-push.mjs — Web Push from the Mac to the owner's paired phone, so a call from Kingmaker (and the CRM's calls to
// the owner) rings even when the app is closed. iPhone delivers Web Push to a Home Screen web app (iOS 16.4+), on the
// owner's say-so (the "Allow calls" switch in the app). Standard Web Push, nothing else: VAPID (RFC 8292) to identify
// this Mac to the push service, and the message encrypted to the phone's own keys (RFC 8291, aes128gcm), so the push
// service carries it without being able to read it. The VAPID key lives in the data folder (0600) and never leaves it.
import { createECDH, createPrivateKey, createCipheriv, hkdfSync, randomBytes, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s || ''), 'base64url');

/** This Mac's VAPID key pair, made once in `dir` (0600). → { publicKey (65-byte uncompressed point, base64url), privateKey: KeyObject } */
export function vapidKeys(dir) {
  const file = join(dir, 'vapid.json');
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const ec = createECDH('prime256v1'); ec.generateKeys();
    writeFileSync(file, JSON.stringify({ d: b64u(ec.getPrivateKey()), pub: b64u(ec.getPublicKey()) }), { mode: 0o600 });
  }
  const { d, pub } = JSON.parse(readFileSync(file, 'utf8'));
  const p = fromB64u(pub);
  const privateKey = createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d, x: b64u(p.subarray(1, 33)), y: b64u(p.subarray(33, 65)) }, format: 'jwk' });
  return { publicKey: pub, privateKey };
}

/** The VAPID Authorization header for one push service origin (RFC 8292), good for 12 hours. Pure apart from the clock. */
export function vapidHeader(endpoint, { publicKey, privateKey }, { subject = 'mailto:ronininc2026@gmail.com', now = Date.now() } = {}) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
  const sig = sign('sha256', Buffer.from(`${head}.${claims}`), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${publicKey}`;
}

/** Encrypt one message to a subscription's keys (RFC 8291, aes128gcm, a single record). → Buffer (the request body). */
export function encryptPush(payload, { p256dh, auth }, { salt = randomBytes(16), ephemeral = null } = {}) {
  const ua = fromB64u(p256dh), secret = fromB64u(auth);
  if (ua.length !== 65 || secret.length !== 16) throw new Error('bad subscription keys');
  const as = ephemeral || createECDH('prime256v1'); if (!ephemeral) as.generateKeys();
  const asPub = as.getPublicKey(), shared = as.computeSecret(ua);
  const ikm = Buffer.from(hkdfSync('sha256', shared, secret, Buffer.concat([Buffer.from('WebPush: info\0'), ua, asPub]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const c = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPub.length]), asPub, body]);
}

/** Send one push. → { ok, status, gone } (gone: the phone dropped this subscription; forget it). */
export async function sendPush(subscription, payload, vapid, { fetchImpl = fetch, ttl = 60, urgency = 'high', subject } = {}) {
  const endpoint = String(subscription?.endpoint || '');
  if (!/^https:\/\//.test(endpoint)) return { ok: false, status: 0, gone: true };
  const body = encryptPush(JSON.stringify(payload), subscription.keys || {});
  const r = await fetchImpl(endpoint, { method: 'POST', body, signal: AbortSignal.timeout(10_000), headers: {
    authorization: vapidHeader(endpoint, vapid, { subject }), 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: String(ttl), urgency } })
    .catch(() => ({ ok: false, status: 0 }));
  return { ok: r.status >= 200 && r.status < 300, status: r.status, gone: r.status === 404 || r.status === 410 };
}

