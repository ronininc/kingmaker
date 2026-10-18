import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyUpdate, checkForUpdate, compareVersions, readUpdateConfig, takeUpdateLock, writeUpdateConfig } from '../lib/update.mjs';
import { generateReleaseKeypair, signManifestBytes } from '../lib/release-signing.mjs';

const host = (files) => async (url, opts) => {
  assert.equal(opts.headers.Authorization, 'Bearer k1');
  const body = files[new URL(url).pathname];
  if (body === undefined) return { ok: false, status: 404 };
  return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => String(body), arrayBuffer: async () => Buffer.from(body) };
};

test('versions compare numerically', () => {
  assert.equal(compareVersions('0.2.10', '0.2.9'), 1);
  assert.equal(compareVersions('0.2.1', '0.2.1'), 0);
  assert.equal(compareVersions('0.2', '0.2.1'), -1);
});

test('config: https only, 0600, env wins', () => {
  const d = mkdtempSync(join(tmpdir(), 'km-upd-'));
  assert.throws(() => writeUpdateConfig(d, { url: 'http://x', key: 'k' }));
  writeUpdateConfig(d, { url: 'https://u.example/', key: 'k1' });
  assert.equal(statSync(join(d, 'update.json')).mode & 0o777, 0o600);
  assert.deepEqual(readUpdateConfig(d, {}), { url: 'https://u.example', key: 'k1' });
  assert.deepEqual(readUpdateConfig(d, { KINGMAKER_UPDATE_URL: 'https://e', KINGMAKER_UPDATE_KEY: 'k2' }), { url: 'https://e', key: 'k2' });
});

test('check: newer is available, same is not', async () => {
  const f = host({ '/latest.json': '{"version":"0.2.1","tag":"v0.2.1","engineSha256":"x"}' });
  assert.equal((await checkForUpdate({ url: 'https://u', key: 'k1' }, { current: '0.2.0', fetchImpl: f })).available, true);
  assert.equal((await checkForUpdate({ url: 'https://u', key: 'k1' }, { current: '0.2.1', fetchImpl: f })).available, false);
});

test('apply: authenticates the signed manifest, pins the engine to it, runs detached with the key in env', async () => {
  const home = mkdtempSync(join(tmpdir(), 'km-home-'));
  const { publicKeyPem, privateKeyPem } = generateReleaseKeypair();
  const engine = '#!/bin/bash\necho ok\n';
  const sha = createHash('sha256').update(engine).digest('hex');
  const manifest = `${JSON.stringify({ schema: 'kingmaker.release/1', tag: 'v0.2.1', engine: { name: 'engine.sh', sha256: sha } })}\n`;
  const sig = signManifestBytes(Buffer.from(manifest), privateKeyPem);
  const cfg = { url: 'https://u', key: 'k1' };
  // Both layers: the manifest signed by the offline key, and the engine signed by the pinned Kingmaker Release certificate.
  const pin = { sha1: 'A'.repeat(40) };
  const verifyImpl = (file, sigFile, sha1) => sha1 === pin.sha1 && readFileSync(sigFile, 'utf8') === 'ENGINE-SIG';
  const files = { '/v0.2.1/engine.sh': engine, '/v0.2.1/engine.sh.sig': 'ENGINE-SIG', '/v0.2.1/kingmaker-manifest.json': manifest, '/v0.2.1/kingmaker-manifest.json.sig': sig };
  const opts = { dataDir: home, wakeWord: 'Nova', fetchImpl: host(files), home, publicKeyPem, pin, verifyImpl };

  // An engine without the Kingmaker Release signature, or with a bad one, is refused even under a good manifest.
  const { '/v0.2.1/engine.sh.sig': _drop, ...noEngineSig } = files;
  await assert.rejects(applyUpdate(cfg, { tag: 'v0.2.1' }, { ...opts, fetchImpl: host(noEngineSig) }), /not signed by the Kingmaker Release certificate/);
  await assert.rejects(applyUpdate(cfg, { tag: 'v0.2.1' }, { ...opts, fetchImpl: host({ ...files, '/v0.2.1/engine.sh.sig': 'FORGED' }) }), /not signed by the Kingmaker Release certificate/);

  // An unsigned release is refused (no .sig served).
  await assert.rejects(applyUpdate(cfg, { tag: 'v0.2.1' }, { ...opts, fetchImpl: host({ '/v0.2.1/engine.sh': engine, '/v0.2.1/kingmaker-manifest.json': manifest }) }), /not signed/);
  // A tampered manifest (signature no longer matches) is refused.
  await assert.rejects(applyUpdate(cfg, { tag: 'v0.2.1' }, { ...opts, fetchImpl: host({ ...files, '/v0.2.1/kingmaker-manifest.json': manifest.replace('v0.2.1', 'v9.9.9') }) }), /not signed/);
  // An engine that doesn't match the signed manifest's pinned hash is refused.
  await assert.rejects(applyUpdate(cfg, { tag: 'v0.2.1' }, { ...opts, fetchImpl: host({ ...files, '/v0.2.1/engine.sh': '#!/bin/bash\necho evil\n' }) }), /does not match the signed manifest/);

  // The good path: runs detached, key in env (never on the command line), with --require-signed and the pinned key.
  let call;
  const spawnImpl = (cmd, args, o) => { call = { cmd, args, o }; return { unref() {} }; };
  const r = await applyUpdate(cfg, { tag: 'v0.2.1' }, { ...opts, spawnImpl });
  assert.equal(call.o.env.KINGMAKER_EXPECT_LEAF, pin.sha1, 'the pin rides into the engine');
  assert.equal(r.started, true);
  assert.equal(call.o.detached, true);
  assert.equal(call.o.env.KINGMAKER_UPDATE_KEY, 'k1');
  assert.ok(!call.args.includes('k1'), 'the key never goes on the command line');
  assert.deepEqual(call.args.slice(1, 5), ['--wake-word', 'Nova', '--base-url', 'https://u/v0.2.1']);
  assert.ok(call.args.includes('--require-signed'), 'the engine is told to require a signature too');
  assert.equal(readFileSync(call.args[0], 'utf8'), engine);
});

test('lock: one update at a time, stale lock released', () => {
  const d = mkdtempSync(join(tmpdir(), 'km-lock-'));
  assert.equal(takeUpdateLock(d, { now: 1000 }), true);
  assert.equal(takeUpdateLock(d, { now: 2000 }), false);
  assert.equal(takeUpdateLock(d, { now: 1000 + 3 * 3600 * 1000 }), true);
});
