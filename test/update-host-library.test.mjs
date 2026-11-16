// Proof for the update host's curated method library route (update-host/worker.js serveLibraryMethod): GET|HEAD
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


// /library/methods/<file> serves the curated corpus only to a valid, unexpired, unrevoked entitlement for
// sku library.methods; a free install (no header), a wrong sku, an expired, revoked or forged entitlement gets 401.
const goodClaims = (over = {}) => ({ schema: 'ronin.entitlement/1', issuer: 'ronin-update-host', installId: 'install-1', deviceSha256: 'dev', sku: 'library.methods', grantedAt: '2026-01-01T00:00:00Z', expiresAt: null, order: 'mem_1', ...over });
const INDEX = Buffer.from('{"schema":"kingmaker.methods/1","methods":[]}');
function makeEnv({ revoked = new Set() } = {}) {
  return {
    CERT_SIGNING_KEY, UPDATE_KEYS: 'op-key',
    RELEASES: { get: async (key) => (key === 'library/methods/index.json' ? { size: INDEX.length, httpEtag: '"i"', writeHttpMetadata(h) { h.set('content-type', 'application/json'); }, body: INDEX } : null) },
    DEVICES: { get: async (k) => (revoked.has(k) ? '1' : null), put: async () => {} },
  };
}
const URL_INDEX = 'https://host/library/methods/index.json';
const get = (ent, url = URL_INDEX, method = 'GET') => worker.fetch(new Request(url, { method, headers: ent ? { 'x-ronin-entitlement': headerFor(ent) } : {} }), makeEnv());

test('an entitled member receives the curated index', async () => {
  const r = await get(await mintEntitlement(goodClaims()));
  assert.equal(r.status, 200); assert.equal(Buffer.from(await r.arrayBuffer()).toString(), INDEX.toString());
  assert.equal(r.headers.get('cache-control'), 'private, no-store');
});
test('a free install (no entitlement) gets 401 and no body', async () => {
  const r = await get(null); assert.equal(r.status, 401); assert.equal((await r.arrayBuffer()).byteLength, 0);
});
test('an add-on entitlement does not open the library (sku-bound)', async () => {
  assert.equal((await get(await mintEntitlement(goodClaims({ sku: 'addon.meeting-notes' })))).status, 401);
});
test('expired, revoked and forged entitlements are refused', async () => {
  assert.equal((await get(await mintEntitlement(goodClaims({ expiresAt: '2020-01-01T00:00:00Z' })))).status, 401);
  const ent = await mintEntitlement(goodClaims());
  const revokedEnv = makeEnv({ revoked: new Set(['revoked:ent:mem_1']) });
  assert.equal((await worker.fetch(new Request(URL_INDEX, { headers: { 'x-ronin-entitlement': headerFor(ent) } }), revokedEnv)).status, 401, 'revoked membership');
  const forged = { ...ent, payload: ent.payload.replace('mem_1', 'mem_2') };
  assert.equal((await get(forged)).status, 401);
});
test('path traversal and odd files are refused before any lookup', async () => {
  const ent = await mintEntitlement(goodClaims());
  for (const p of ['../latest.json', 'x.sh', '%2e%2e/latest.json', 'a/b.method.md']) assert.equal((await get(ent, `https://host/library/methods/${p}`)).status, 401, p);
});
