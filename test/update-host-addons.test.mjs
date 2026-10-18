// Proof for the update host's paid-add-on route (update-host/worker.js, docs/addons.md §4): GET|HEAD
// /addons/<id>/<version>/<file> serves the R2 zip only to a request carrying a valid, unexpired, unrevoked
// entitlement for addon.<id>, and anything else gets 401 with no body. Also covers /cert-status answering for
// entitlement ids. The worker is a Cloudflare module-worker (export default); we load the real source via a data: URL
// so this runs under plain Node, and drive it with stub R2 (RELEASES) and KV (DEVICES) bindings plus a real ES256 key.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const enc = new TextEncoder();
const b64 = (bytes) => { let s = ''; for (const byte of bytes) s += String.fromCharCode(byte); return btoa(s); };
function derLen(n) { return n < 0x80 ? [n] : [0x81, n]; }
function derInt(bytes) { let i = 0; while (i < bytes.length - 1 && bytes[i] === 0x00) i++; let v = [...bytes.slice(i)]; if (v[0] & 0x80) v = [0x00, ...v]; return [0x02, ...derLen(v.length), ...v]; }
function ecdsaRawToDer(raw) { const r = derInt(raw.slice(0, 32)); const s = derInt(raw.slice(32, 64)); const body = [...r, ...s]; return Uint8Array.from([0x30, ...derLen(body.length), ...body]); }

// crypto.subtle.timingSafeEqual is a Cloudflare Workers API (used by the worker's bearer-key check) that Node's
// WebCrypto lacks; shim it for the test so the /cert-status auth path runs here. Constant-time isn't needed in a test.
if (typeof crypto.subtle.timingSafeEqual !== 'function') {
  crypto.subtle.timingSafeEqual = (a, b) => {
    const x = new Uint8Array(a); const y = new Uint8Array(b);
    if (x.length !== y.length) return false;
    let d = 0; for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
    return d === 0;
  };
}

// Load the real worker source as ESM regardless of the package's module type.
const src = readFileSync(new URL('../update-host/worker.js', import.meta.url), 'utf8');
const worker = (await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'))).default;

// A P-256 key pair; its private half, as a PKCS#8 PEM, plays the host's CERT_SIGNING_KEY.
const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
const CERT_SIGNING_KEY = '-----BEGIN PRIVATE KEY-----\n' + b64(pkcs8).replace(/(.{64})/g, '$1\n') + '\n-----END PRIVATE KEY-----\n';

async function mintEntitlement(claims) {
  const payload = JSON.stringify(claims);
  const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, enc.encode(payload)));
  return { payload, sig: b64(ecdsaRawToDer(raw)), alg: 'ES256' };
}
const headerFor = (ent) => b64(enc.encode(JSON.stringify(ent)));
const goodClaims = (over = {}) => ({ schema: 'ronin.entitlement/1', issuer: 'ronin-update-host', installId: 'install-1', deviceSha256: 'dev', sku: 'addon.meeting-notes', grantedAt: '2026-01-01T00:00:00Z', expiresAt: null, order: 'ord_1', ...over });

const ZIP = Buffer.from('PK\u0003\u0004 pretend zip bytes');
function makeEnv({ revoked = new Set(), withKey = true } = {}) {
  return {
    CERT_SIGNING_KEY: withKey ? CERT_SIGNING_KEY : undefined,
    UPDATE_KEYS: 'op-key',
    RELEASES: {
      get: async (key) => (key === 'addons/meeting-notes/1.0.0/meeting-notes-1.0.0.zip'
        ? { size: ZIP.length, httpEtag: '"z"', writeHttpMetadata(h) { h.set('content-type', 'application/zip'); }, body: ZIP, range: undefined }
        : null),
    },
    DEVICES: { get: async (k) => (revoked.has(k) ? '1' : null), put: async () => {} },
  };
}
const ADDON_URL = 'https://host/addons/meeting-notes/1.0.0/meeting-notes-1.0.0.zip';
const reqWith = (ent, { method = 'GET', url = ADDON_URL } = {}) =>
  new Request(url, { method, headers: ent ? { 'x-ronin-entitlement': headerFor(ent) } : {} });

test('a valid entitlement serves the add-on zip', async () => {
  const res = await worker.fetch(reqWith(await mintEntitlement(goodClaims())), makeEnv());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'private, max-age=0');
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  assert.equal(Buffer.from(await res.arrayBuffer()).toString(), ZIP.toString());
});

test('HEAD returns headers and no body', async () => {
  const res = await worker.fetch(reqWith(await mintEntitlement(goodClaims()), { method: 'HEAD' }), makeEnv());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-length'), String(ZIP.length));
  assert.equal((await res.arrayBuffer()).byteLength, 0);
});

test('no entitlement header → 401, no body', async () => {
  const res = await worker.fetch(reqWith(null), makeEnv());
  assert.equal(res.status, 401);
  assert.equal((await res.text()), '');
});

test('wrong sku → 401', async () => {
  const res = await worker.fetch(reqWith(await mintEntitlement(goodClaims({ sku: 'addon.something-else' }))), makeEnv());
  assert.equal(res.status, 401);
});

test('expired entitlement → 401', async () => {
  const res = await worker.fetch(reqWith(await mintEntitlement(goodClaims({ expiresAt: '2000-01-01T00:00:00Z' }))), makeEnv());
  assert.equal(res.status, 401);
});

test('wrong schema or issuer → 401', async () => {
  assert.equal((await worker.fetch(reqWith(await mintEntitlement(goodClaims({ schema: 'x/1' }))), makeEnv())).status, 401);
  assert.equal((await worker.fetch(reqWith(await mintEntitlement(goodClaims({ issuer: 'someone-else' }))), makeEnv())).status, 401);
});

test('tampered signature → 401', async () => {
  const ent = await mintEntitlement(goodClaims());
  ent.payload = ent.payload.replace('meeting-notes', 'meeting-notes" , "x":"1'); // payload no longer matches the sig
  const res = await worker.fetch(reqWith(ent), makeEnv());
  assert.equal(res.status, 401);
});

test('revoked entitlement id → 401', async () => {
  const res = await worker.fetch(reqWith(await mintEntitlement(goodClaims())), makeEnv({ revoked: new Set(['revoked:ent:ord_1']) }));
  assert.equal(res.status, 401);
});

test('revoked install id → 401', async () => {
  const res = await worker.fetch(reqWith(await mintEntitlement(goodClaims())), makeEnv({ revoked: new Set(['revoked:install:install-1']) }));
  assert.equal(res.status, 401);
});

test('revocation of an order id with reserved characters is matched losslessly → 401', async () => {
  const ent = await mintEntitlement(goodClaims({ order: 'ord/1+a' }));
  const marker = `revoked:ent:${encodeURIComponent('ord/1+a')}`; // the operator's documented marker key
  assert.equal((await worker.fetch(reqWith(ent), makeEnv({ revoked: new Set([marker]) }))).status, 401);
  // not revoked without the exact marker: the special characters must not have been stripped away
  assert.equal((await worker.fetch(reqWith(ent), makeEnv())).status, 200);
});

test('no CERT_SIGNING_KEY → fails closed (401)', async () => {
  const res = await worker.fetch(reqWith(await mintEntitlement(goodClaims())), makeEnv({ withKey: false }));
  assert.equal(res.status, 401);
});

test('path traversal / unknown file → 401 or 404, never served', async () => {
  const bad = new Request('https://host/addons/meeting-notes/1.0.0/..%2f..%2fsecret', { method: 'GET', headers: { 'x-ronin-entitlement': headerFor(await mintEntitlement(goodClaims())) } });
  const res = await worker.fetch(bad, makeEnv());
  assert.ok(res.status === 401 || res.status === 404);
});

test('/cert-status answers for an entitlement id with a recognized key', async () => {
  const req = new Request('https://host/cert-status?entitlement=ord_1&install=install-1', { headers: { Authorization: 'Bearer op-key' } });
  const res = await worker.fetch(req, makeEnv({ revoked: new Set(['revoked:ent:ord_1']) }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { revoked: true });
});

test('/cert-status reports not-revoked when no marker is set', async () => {
  const req = new Request('https://host/cert-status?entitlement=ord_9&install=install-9', { headers: { Authorization: 'Bearer op-key' } });
  const res = await worker.fetch(req, makeEnv());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { revoked: false });
});
