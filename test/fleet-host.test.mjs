// The collective's front door (fleet-host/worker.js) and the Mac's side of it (lib/fleet-transport.mjs), end to end in
// memory: a real Ed25519 key pair, in-memory R2/KV, the Mac's packet from the engine's own sanitizer.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import worker, { MAX_PACKETS_PER_DAY } from '../fleet-host/worker.js';
import { fleetConfig, fleetTransport, installSecret, receiptValid } from '../lib/fleet-transport.mjs';
import { fleetDraft, installationId } from '../lib/sharing.mjs';
import { newInstallationId, sanitizeForFleet } from '../vendor/fleet/fleet-packet.mjs';

function memEnv() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const kv = new Map(), r2 = new Map();
  return {
    FLEET_SIGNING_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    FLEET_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }),
    FLEET: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); }, delete: async (k) => { kv.delete(k); } },
    PACKETS: {
      put: async (k, v) => { r2.set(k, v); }, get: async (k) => (r2.has(k) ? { body: r2.get(k) } : null),
      delete: async (keys) => { for (const k of [].concat(keys)) r2.delete(k); },
      list: async ({ prefix }) => ({ objects: [...r2.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false }),
    },
    _r2: r2, _kv: kv,
  };
}
const macWith = (env) => {
  const state = mkdtempSync(join(tmpdir(), 'fleet-mac-'));
  mkdirSync(join(state, 'fleet'), { recursive: true });
  writeFileSync(join(state, 'fleet', 'fleet.json'), JSON.stringify({ url: 'https://fleet.example', publicKeyPem: env.FLEET_PUBLIC_KEY }));
  const fetchImpl = (url, init) => worker.fetch(new Request(url, init), env, {});
  const id = installationId(state, newInstallationId);
  const packet = () => sanitizeForFleet(fleetDraft({ id, version: '0.9.0', totalMemBytes: 24 * 1024 ** 3, preferences: [{ statement: 'always give me the price first' }] })).packet;
  return { state, id, packet, t: fleetTransport({ state, env: {}, fetchImpl }), fetchImpl };
};

test('no server configured: nothing to send with (sharing logs locally)', () => {
  const state = mkdtempSync(join(tmpdir(), 'fleet-mac-'));
  assert.equal(fleetConfig(state, {}), null);
  assert.deepEqual(fleetTransport({ state, env: {} }), { send: null, forgetRemote: null });
  assert.equal(fleetConfig(state, { KINGMAKER_FLEET_URL: 'http://plain.example', KINGMAKER_FLEET_KEY: '-----BEGIN PUBLIC KEY-----x' }), null, 'never over plain http');
});

test('a Mac shares a packet: stored, a receipt signed by the pinned key, verified on the Mac', async () => {
  const env = memEnv(); const mac = macWith(env);
  const p = mac.packet();
  const r = await mac.t.send(p);
  assert.equal(r.ok, true); assert.equal(r.receipt.accepted, true);
  assert.ok([...env._r2.keys()].some((k) => k === `packets/${mac.id}/${p.day}/${p.packetId}.json`));
  assert.equal(receiptValid({ ...r.receipt, accepted: false }, { publicKeyPem: env.FLEET_PUBLIC_KEY, installationId: mac.id, packetId: p.packetId }), false, 'a tampered receipt fails');
  const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
  assert.equal(receiptValid(r.receipt, { publicKeyPem: other, installationId: mac.id, packetId: p.packetId }), false, 'another key fails');
  assert.ok(![...env._kv.values()].includes(installSecret(mac.state)), 'the server keeps only the proof\'s hash');
});

test('hostile and careless requests are refused, and nothing refused is stored', async () => {
  const env = memEnv(); const mac = macWith(env);
  const p = mac.packet();
  // Free text smuggled into a packet: refused with a signed reason, not stored.
  const bad = { ...p, artifacts: [{ kind: 'preference_stats', prefs: [{ pref: 'price_first', polarity: 'always', n: 1, note: 'email maria@acme.com' }] }] };
  const rb = await mac.t.send(bad);
  assert.equal(rb.ok, false); assert.ok(rb.refused?.length); assert.equal([...env._r2.keys()].length, 0);
  assert.doesNotMatch(JSON.stringify(rb), /maria|acme/, 'the refusal never echoes the content');
  // The Mac's proof is registered on its first contribution: a stranger using the same install id is refused.
  const res = await mac.fetchImpl('https://fleet.example/contribute', { method: 'POST', headers: { 'content-type': 'application/json', 'x-fleet-install': mac.id, 'x-fleet-proof': 'f'.repeat(64) }, body: JSON.stringify({ packet: p }) });
  assert.equal(res.status, 403, 'a different proof for the same install is refused');
  const mismatch = await mac.fetchImpl('https://fleet.example/contribute', { method: 'POST', headers: { 'content-type': 'application/json', 'x-fleet-install': newInstallationId(), 'x-fleet-proof': installSecret(mac.state) }, body: JSON.stringify({ packet: p }) });
  assert.equal(mismatch.status, 400, "a packet under another install's id is refused");
  assert.equal([...env._r2.keys()].length, 0);
  const big = await mac.fetchImpl('https://fleet.example/contribute', { method: 'POST', headers: { 'content-length': String(300 * 1024) }, body: 'x' });
  assert.equal(big.status, 413);
});

test('a few packets a day per install, then "enough for today"', async () => {
  const env = memEnv(); const mac = macWith(env);
  for (let i = 0; i < MAX_PACKETS_PER_DAY; i++) assert.equal((await mac.t.send(mac.packet())).ok, true);
  assert.equal((await mac.t.send(mac.packet())).status, 429);
});

test('"forget what I shared": every packet, the bundle and the proof are erased; a stranger cannot erase it', async () => {
  const env = memEnv(); const mac = macWith(env);
  await mac.t.send(mac.packet()); await mac.t.send(mac.packet());
  env._r2.set(`bundles/${mac.id}.json`, '{}');
  const stranger = await mac.fetchImpl('https://fleet.example/forget', { method: 'POST', headers: { 'x-fleet-install': mac.id, 'x-fleet-proof': 'a'.repeat(64) } });
  assert.equal(stranger.status, 403);
  const f = await mac.t.forgetRemote(mac.id);
  assert.deepEqual(f, { ok: true, packets: 2 });
  assert.equal([...env._r2.keys()].length, 0); assert.equal(env._kv.has(`proof:${mac.id}`), false);
});
