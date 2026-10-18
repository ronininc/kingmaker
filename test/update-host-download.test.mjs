// Proof for the update host's public installer download (update-host/worker.js): GET|HEAD /download/<name>.dmg|.zip
// serves R2 `public/<name>` with no key (ronininc.org links it), a bad name or a missing object is 404, a Range gets a
// 206, and every other path still needs an operator or un-revoked device key. Loaded the same way as
// update-host-addons.test.mjs: the real worker source via a data: URL, with stub R2 (RELEASES) and KV (DEVICES).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// Workers-only API that Node's WebCrypto lacks (see update-host-addons.test.mjs).
if (typeof crypto.subtle.timingSafeEqual !== 'function') {
  crypto.subtle.timingSafeEqual = (a, b) => {
    const x = new Uint8Array(a); const y = new Uint8Array(b);
    if (x.length !== y.length) return false;
    let d = 0; for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
    return d === 0;
  };
}
const src = readFileSync(new URL('../update-host/worker.js', import.meta.url), 'utf8');
const worker = (await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'))).default;

const DMG = Buffer.from('0123456789abcdefghij');
const sha = (s) => createHash('sha256').update(s).digest('hex');
function makeEnv({ devices = {} } = {}) {
  const objects = {
    'public/Kingmaker-0.2.8.dmg': DMG,
    'public/Kingmaker.zip': Buffer.from('PKzip'),
    'latest.json': Buffer.from('{"tag":"v0.2.8"}'),
    'v0.2.8/secret.dmg': Buffer.from('release bytes'),
  };
  const puts = [];
  return {
    UPDATE_KEYS: 'op-key, op-key-2',
    puts,
    RELEASES: {
      async get(key, opts = {}) {
        const buf = objects[key];
        if (!buf) return null;
        const m = /^bytes=(\d+)-(\d*)$/.exec(opts.range?.get?.('range') || '');
        const o = { size: buf.length, httpEtag: '"e"', writeHttpMetadata(h) { h.set('content-type', 'application/x-apple-diskimage'); }, body: buf, async json() { return JSON.parse(buf.toString()); } };
        if (m) { const offset = Number(m[1]); const end = m[2] ? Number(m[2]) : buf.length - 1; o.range = { offset, length: end - offset + 1 }; o.body = buf.subarray(offset, end + 1); }
        return o;
      },
    },
    DEVICES: {
      async get(k) { return k in devices ? devices[k] : null; },
      async put(k, v) { puts.push([k, v]); },
    },
  };
}
const at = (path, { method = 'GET', headers = {} } = {}) => new Request('https://host' + path, { method, headers });
const withKey = (k) => ({ authorization: `Bearer ${k}` });
const devEnv = () => makeEnv({ devices: { [`key:${sha('dev-key')}`]: { device: 'd', revoked: false }, [`key:${sha('old-key')}`]: { device: 'o', revoked: true } } });

test('a public DMG and ZIP are served without any key, as attachments, cacheable for 5 minutes', async () => {
  const res = await worker.fetch(at('/download/Kingmaker-0.2.8.dmg'), makeEnv());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-disposition'), 'attachment; filename="Kingmaker-0.2.8.dmg"');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=300');
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  assert.equal(res.headers.get('content-length'), String(DMG.length));
  assert.equal(Buffer.from(await res.arrayBuffer()).toString(), DMG.toString());
  assert.equal((await worker.fetch(at('/download/Kingmaker.zip'), makeEnv())).status, 200);
});

test('HEAD on a public download returns headers and no body', async () => {
  const res = await worker.fetch(at('/download/Kingmaker-0.2.8.dmg', { method: 'HEAD' }), makeEnv());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-length'), String(DMG.length));
  assert.equal((await res.arrayBuffer()).byteLength, 0);
});

test('a bad name is 404, and nothing outside public/ is reachable through /download', async () => {
  const env = makeEnv();
  for (const p of ['/download/', '/download/notes.txt', '/download/Kingmaker.dmg.exe', '/download/..%2Flatest.json', '/download/v0.2.8/secret.dmg', '/download/a b.dmg', '/download/latest.json']) {
    assert.equal((await worker.fetch(at(p), env)).status, 404, p);
  }
});

test('a missing public object is 404', async () => {
  assert.equal((await worker.fetch(at('/download/Nope-9.9.9.dmg'), makeEnv())).status, 404);
});

test('a Range request gets 206 with Content-Range, and HEAD+Range has no body', async () => {
  const res = await worker.fetch(at('/download/Kingmaker-0.2.8.dmg', { headers: { range: 'bytes=5-9' } }), makeEnv());
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes 5-9/${DMG.length}`);
  assert.equal(res.headers.get('content-length'), '5');
  assert.equal(Buffer.from(await res.arrayBuffer()).toString(), '56789');
  const head = await worker.fetch(at('/download/Kingmaker-0.2.8.dmg', { method: 'HEAD', headers: { range: 'bytes=0-3' } }), makeEnv());
  assert.equal(head.status, 206);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
});

test('POST /download/... is not public (falls to the method check)', async () => {
  assert.equal((await worker.fetch(at('/download/Kingmaker.zip', { method: 'POST' }), makeEnv())).status, 405);
});

test('every other path still needs a key: none, an unknown key, or a revoked device key is 401', async () => {
  const env = devEnv();
  for (const p of ['/latest.json', '/v0.2.8/secret.dmg', '/public/Kingmaker-0.2.8.dmg']) {
    assert.equal((await worker.fetch(at(p), env)).status, 401, `${p} without a key`);
    assert.equal((await worker.fetch(at(p, { headers: withKey('nope') }), env)).status, 401, `${p} unknown key`);
    assert.equal((await worker.fetch(at(p, { headers: withKey('old-key') }), env)).status, 401, `${p} revoked device`);
  }
});

test('operator keys and live device keys still reach releases; a latest.json check-in is still recorded', async () => {
  const env = devEnv();
  assert.equal((await worker.fetch(at('/v0.2.8/secret.dmg', { headers: withKey('op-key-2') }), env)).status, 200);
  assert.equal((await worker.fetch(at('/v0.2.8/secret.dmg', { headers: withKey('dev-key') }), env)).status, 200);
  assert.equal(env.puts.length, 0, 'only latest.json records a check-in');
  const res = await worker.fetch(at('/latest.json', { headers: { ...withKey('dev-key'), 'x-kingmaker-version': '0.2.8' } }), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(env.puts.length, 1);
  assert.equal(env.puts[0][0], `seen:${sha('dev-key').slice(0, 16)}`);
  assert.equal(JSON.parse(env.puts[0][1]).version, '0.2.8');
});

test('/cert-status still answers a revoked device with {revoked:true}, an active one with false, an unknown key 401', async () => {
  const env = devEnv();
  assert.deepEqual(await (await worker.fetch(at('/cert-status', { headers: withKey('old-key') }), env)).json(), { revoked: true });
  assert.deepEqual(await (await worker.fetch(at('/cert-status', { headers: withKey('dev-key') }), env)).json(), { revoked: false });
  assert.deepEqual(await (await worker.fetch(at('/cert-status', { headers: withKey('op-key') }), env)).json(), { revoked: false });
  assert.equal((await worker.fetch(at('/cert-status', { headers: withKey('nope') }), env)).status, 401);
});

test('/enroll is unchanged: POST only, and it needs the enroll token', async () => {
  const env = { ...devEnv(), ENROLL_TOKEN: 'tok' };
  assert.equal((await worker.fetch(at('/enroll'), env)).status, 405);
  assert.equal((await worker.fetch(at('/enroll', { method: 'POST', headers: withKey('wrong') }), env)).status, 401);
  const res = await worker.fetch(new Request('https://host/enroll', { method: 'POST', headers: withKey('tok'), body: JSON.stringify({ device: 'abcdef0123456789abcd', name: 'Test Mac' }) }), env);
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.url, 'https://host');
  assert.match(out.key, /^[0-9a-f]{64}$/);
});

test('/enroll keeps no computer name: an older installer\'s name is dropped, and the installer sends none', async () => {
  const env = { ...devEnv(), ENROLL_TOKEN: 'tok' };
  const res = await worker.fetch(new Request('https://host/enroll', { method: 'POST', headers: withKey('tok'), body: JSON.stringify({ device: 'abcdef0123456789abcd', name: "Jane's MacBook Pro" }) }), env);
  assert.equal(res.status, 200);
  const stored = env.puts.filter(([k]) => /^(key|device):/.test(k)).map(([, v]) => String(v));
  assert.ok(stored.length >= 2, 'the key and device records were written');
  assert.ok(stored.every((v) => !/Jane|MacBook|"name"/.test(v)), stored.join(' | '));
  const engine = readFileSync(new URL('../installer/engine.sh', import.meta.url), 'utf8');
  assert.doesNotMatch(engine, /scutil --get ComputerName|\\"name\\":/, 'the installer never reads or sends the computer name');
});
