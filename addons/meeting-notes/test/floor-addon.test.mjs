// Proof for the add-on loader (lib/addons.mjs) and the meeting-notes entry register() — against fakes, no network.
// Covers: manifest validation, requires, the fail-closed signature/entitlement gates, atomic install + placement,
// list/remove, loadAddons calling register(host), tamper rejection, and register wiring the `floor` command.
//   node --test test/floor-addon.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign as cryptoSign, constants as C } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  manifestProblems, satisfies, checkRequires, verifyGates, installAddon, listAddons, removeAddon, loadAddons, makeHost, dispatchAddons, HOST_API_VERSION,
  verifyManifestSig, verifyEntitlementEnvelope, defaultVerifiers,
} from '../../../lib/addons.mjs';
import { register } from '../lib/floor-participant.mjs';

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const yes = async () => true;
const REQ = { kingmaker: '0.2.6', launcher: '0.3.0', arch: 'arm64' };

/** Stage a minimal add-on (manifest.json + files) in a fresh dir; returns { dir, manifest }. */
function stageAddon({ paid = true, files = { 'lib/entry.mjs': 'export function register(h){ h.log("hi"); return "ok"; }', 'vendor/x.mjs': 'export const x=1;' }, entry = 'lib/entry.mjs', version = '1.0.0' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'addon-stage-'));
  const fileEntries = Object.entries(files).map(([path, body]) => { const buf = Buffer.from(body); const d = join(dir, path); mkdirSync(dirname(d), { recursive: true }); writeFileSync(d, buf); return { path, size: buf.length, sha256: sha256(buf) }; });
  const manifest = {
    schema: 'ronin.addon/1', id: 'meeting-notes', name: 'Meeting notes', version, summary: 's', paid, sku: 'addon.meeting-notes',
    license: 'x', requires: { kingmaker: '>=0.2.6', launcher: '>=0.3.0', arch: 'arm64' },
    archive: { name: `meeting-notes-${version}.zip`, size: 1, sha256: sha256(Buffer.from('z')) },
    files: fileEntries, entry: { module: entry, export: 'register' }, commands: [{ name: 'floor', summary: 'x' }], permissions: ['microphone'],
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  return { dir, manifest };
}

test('manifestProblems accepts a good manifest and rejects bad ones', () => {
  const { manifest } = stageAddon();
  assert.deepEqual(manifestProblems(manifest), []);
  assert.ok(manifestProblems({ ...manifest, id: 'Bad Id' }).length);
  assert.ok(manifestProblems({ ...manifest, files: [{ path: '../escape', size: 1, sha256: 'x' }] }).length);
  assert.ok(manifestProblems({ ...manifest, entry: { module: 'nope.mjs', export: 'register' } }).some((p) => /not one of the files/.test(p)));
  assert.ok(manifestProblems({ schema: 'other' }).length);
  for (const bad of ['manifest.json', 'manifest.json.sig', 'entitlement.json', 'current.json'])
    assert.ok(manifestProblems({ ...manifest, files: [{ path: bad, size: 1, sha256: 'a'.repeat(64) }] }).length, `reserved name ${bad} rejected`);
});

test('satisfies / checkRequires compare versions and arch', () => {
  assert.ok(satisfies('0.2.6', '>=0.2.6') && satisfies('0.3.0', '>=0.2.6') && !satisfies('0.2.5', '>=0.2.6'));
  const { manifest } = stageAddon();
  assert.equal(checkRequires(manifest, REQ), null);
  assert.match(checkRequires(manifest, { ...REQ, kingmaker: '0.2.5' }), /needs Kingmaker/);
  assert.match(checkRequires(manifest, { ...REQ, arch: 'x64' }), /arm64/);
});

test('verifyGates fails closed: no verifier, bad signature, or missing entitlement all refuse', async () => {
  const { manifest } = stageAddon({ paid: true });
  assert.match(await verifyGates(manifest, {}), /no manifest-signature verifier/);
  assert.match(await verifyGates(manifest, { verifyManifest: async () => false }), /signature did not verify/);
  assert.match(await verifyGates(manifest, { verifyManifest: yes }), /no entitlement verifier/);
  assert.match(await verifyGates(manifest, { verifyManifest: yes, verifyEntitlement: yes }), /holds no entitlement/);
  assert.match(await verifyGates(manifest, { verifyManifest: yes, verifyEntitlement: async () => false, entitlement: {} }), /did not verify/);
  assert.equal(await verifyGates(manifest, { verifyManifest: yes, verifyEntitlement: yes, entitlement: { sku: 'addon.meeting-notes' } }), null);
  const free = stageAddon({ paid: false }).manifest;
  assert.equal(await verifyGates(free, { verifyManifest: yes }), null, 'a free add-on needs no entitlement');
});

test('installAddon places files atomically, writes current.json + entitlement; tamper/fail-closed throw', async () => {
  const root = mkdtempSync(join(tmpdir(), 'addons-root-'));
  const { dir } = stageAddon();
  const ent = { sku: 'addon.meeting-notes', installId: 'i1' };
  const r = await installAddon({ stagedDir: dir, root, entitlement: ent, requires: REQ, verifyManifest: yes, verifyEntitlement: yes });
  assert.deepEqual(r, { id: 'meeting-notes', version: '1.0.0' });
  assert.ok(existsSync(join(root, 'meeting-notes', '1.0.0', 'lib', 'entry.mjs')));
  assert.equal(JSON.parse(readFileSync(join(root, 'meeting-notes', 'current.json'), 'utf8')).version, '1.0.0');
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'meeting-notes', '1.0.0', 'entitlement.json'), 'utf8')), ent);
  // fail closed: no verifier.
  await assert.rejects(() => installAddon({ stagedDir: dir, root, entitlement: ent, requires: REQ }), /fail closed/);
  // tamper a staged file so it no longer matches the manifest → install refuses on integrity (size or hash).
  writeFileSync(join(dir, 'lib', 'entry.mjs'), 'export function register(){} // tampered');
  await assert.rejects(() => installAddon({ stagedDir: dir, root, entitlement: ent, requires: REQ, verifyManifest: yes, verifyEntitlement: yes }), /mismatch/);
  rmSync(root, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true });
});

test('list / remove', async () => {
  const root = mkdtempSync(join(tmpdir(), 'addons-root-'));
  const { dir } = stageAddon();
  await installAddon({ stagedDir: dir, root, entitlement: { sku: 'addon.meeting-notes' }, requires: REQ, verifyManifest: yes, verifyEntitlement: yes });
  assert.deepEqual(listAddons({ root }), [{ id: 'meeting-notes', version: '1.0.0' }]);
  assert.ok(removeAddon({ root, id: 'meeting-notes' }));
  assert.deepEqual(listAddons({ root }), []);
  rmSync(root, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true });
});

test('loadAddons re-verifies and calls register(host); a tampered install is skipped', async () => {
  const root = mkdtempSync(join(tmpdir(), 'addons-root-'));
  const { dir } = stageAddon();
  await installAddon({ stagedDir: dir, root, entitlement: { sku: 'addon.meeting-notes' }, requires: REQ, verifyManifest: yes, verifyEntitlement: yes });
  const calls = [];
  const importer = async (url) => ({ register: (h) => { calls.push({ url, api: h.apiVersion }); } });
  const host = makeHost({ version: '0.2.6', paths: {}, log: () => {} });
  const loaded = await loadAddons(host, { root, requires: REQ, verifyManifest: yes, verifyEntitlement: yes, importer });
  assert.deepEqual(loaded, ['meeting-notes']);
  assert.equal(calls.length, 1); assert.match(calls[0].url, /lib\/entry\.mjs$/); assert.equal(calls[0].api, HOST_API_VERSION);
  // tamper the PLACED file → loadAddons skips it.
  writeFileSync(join(root, 'meeting-notes', '1.0.0', 'lib', 'entry.mjs'), '// tampered');
  const logs = []; const loaded2 = await loadAddons(host, { root, requires: REQ, verifyManifest: yes, verifyEntitlement: yes, importer, log: (e, d) => logs.push({ e, ...d }) });
  assert.deepEqual(loaded2, []);
  assert.ok(logs.some((l) => l.e === 'addon_skip' && /mismatch/.test(l.why)), 'tampered file rejected on integrity (size/hash)');
  rmSync(root, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true });
});

test('dispatchAddons handles list/remove/install and reports refusals', async () => {
  const root = mkdtempSync(join(tmpdir(), 'addons-root-'));
  const { dir } = stageAddon();
  const deps = { root, requires: REQ, verifyManifest: yes, verifyEntitlement: yes, entitlement: { sku: 'addon.meeting-notes' } };
  const inst = await dispatchAddons(['install', dir], deps);
  assert.ok(inst.ok && /installed meeting-notes 1\.0\.0/.test(inst.output), 'exit-0 on install');
  assert.match((await dispatchAddons(['list'], deps)).output, /meeting-notes 1\.0\.0/);
  // a fail-closed install (requires met, but no signature verifier) reports the refusal, doesn't throw, and is not ok.
  const fail = await dispatchAddons(['install', dir], { root, requires: REQ });
  assert.ok(!fail.ok && /failed:.*fail closed/.test(fail.output), 'non-zero exit on refusal');
  const rm = await dispatchAddons(['remove', 'meeting-notes'], deps);
  assert.ok(rm.ok && /removed meeting-notes/.test(rm.output));
  assert.ok(!(await dispatchAddons(['remove', 'nope'], deps)).ok, 'removing a missing add-on is not ok');
  rmSync(root, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true });
});

// Ephemeral keys that stand in for the pinned Release / install-cert keys, so the real verify paths run in CI.
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const relPem = rsa.publicKey.export({ type: 'spki', format: 'pem' });
const certPem = ec.publicKey.export({ type: 'spki', format: 'pem' });
const signManifest = (bytes) => cryptoSign('sha256', bytes, { key: rsa.privateKey, padding: C.RSA_PKCS1_PSS_PADDING, saltLength: C.RSA_PSS_SALTLEN_DIGEST }).toString('base64');
const makeEnt = (claims) => { const payload = JSON.stringify(claims); return { schema: 'ronin.entitlement/1', payload, sig: cryptoSign('sha256', Buffer.from(payload, 'utf8'), { key: ec.privateKey, dsaEncoding: 'der' }).toString('base64'), alg: 'ES256' }; };

test('built-in verifiers match the RSA-PSS manifest + ES256 entitlement conventions and reject tampering', () => {
  const bytes = Buffer.from(JSON.stringify({ schema: 'ronin.addon/1', x: 1 }));
  const sig = signManifest(bytes);
  assert.equal(verifyManifestSig(bytes, sig, relPem), true);
  assert.equal(verifyManifestSig(Buffer.concat([bytes, Buffer.from('!')]), sig, relPem), false, 'tampered bytes rejected');
  assert.equal(verifyManifestSig(bytes, '', relPem), false, 'no signature rejected');
  const ent = makeEnt({ sku: 'addon.meeting-notes', installId: 'i1', deviceSha256: 'd1', grantedAt: '2026-01-01T00:00:00Z', expiresAt: null });
  assert.equal(verifyEntitlementEnvelope(ent, certPem).sku, 'addon.meeting-notes');
  assert.equal(verifyEntitlementEnvelope({ ...ent, payload: ent.payload + ' ' }, certPem), null, 'tampered payload rejected');
  const v = defaultVerifiers({ releaseKeyPem: relPem, certKeyPem: certPem });
  assert.equal(v.verifyEntitlement(ent, { sku: 'addon.meeting-notes', install: { installId: 'i1', deviceSha256: 'd1' } }), true);
  assert.equal(v.verifyEntitlement(ent, { sku: 'other' }), false, 'sku mismatch');
  assert.equal(v.verifyEntitlement(ent, { sku: 'addon.meeting-notes', install: { installId: 'other' } }), false, 'wrong Mac');
  const expired = makeEnt({ sku: 'addon.meeting-notes', installId: 'i1', expiresAt: '2000-01-01T00:00:00Z' });
  assert.equal(v.verifyEntitlement(expired, { sku: 'addon.meeting-notes' }), false, 'expired');
});

test('end-to-end: a correctly signed add-on installs and loads with the built-in verifiers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'addons-root-'));
  const { dir } = stageAddon();
  // Sign the manifest's exact bytes → the .sig sidecar, as the release step would.
  writeFileSync(join(dir, 'manifest.json.sig'), signManifest(readFileSync(join(dir, 'manifest.json'))));
  const ent = makeEnt({ sku: 'addon.meeting-notes', installId: 'i1', deviceSha256: 'd1', expiresAt: null });
  const v = defaultVerifiers({ releaseKeyPem: relPem, certKeyPem: certPem });
  const install = { installId: 'i1', deviceSha256: 'd1' };
  await installAddon({ stagedDir: dir, root, entitlement: ent, requires: REQ, install, ...v });
  const calls = [];
  await loadAddons(makeHost({ version: '0.2.6' }), { root, requires: REQ, install, ...v, importer: async () => ({ register: () => calls.push(1) }) });
  assert.equal(calls.length, 1, 'the signed add-on loaded and registered');
  // A wrong-Mac entitlement is refused at install.
  await assert.rejects(() => installAddon({ stagedDir: dir, root, entitlement: makeEnt({ sku: 'addon.meeting-notes', installId: 'other' }), requires: REQ, install, ...v }), /entitlement did not verify/);
  rmSync(root, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true });
});

test('the pinned public keys committed in lib/ load as valid keys', () => {
  const v = defaultVerifiers(); // reads lib/kingmaker-release-public.pem + lib/ronin-install-cert-public.pem
  assert.equal(typeof v.verifyManifest, 'function');
  assert.equal(typeof v.verifyEntitlement, 'function');
  assert.equal(v.verifyManifest(Buffer.from('x'), 'notbase64=='), false, 'a bogus signature fails against the real pinned key');
});

test('register wires the floor command and refuses with no CRM configured', async () => {
  const commands = {};
  const host = makeHost({ version: '0.2.6', paths: {}, log: () => {}, command: (n, fn) => { commands[n] = fn; }, services: {} });
  const api = await register(host);
  assert.equal(typeof api.start, 'function');
  assert.ok(commands.floor, 'the floor command is registered');
  const saved = { ...process.env }; delete process.env.RONIN_CRM_MCP_URL; delete process.env.RONIN_CRM_MCP_TOKEN; delete process.env.RONIN_CRM_TOKEN; delete process.env.SOLOMON_CRM_TOKEN;
  try { assert.match(await commands.floor([]), /No CRM configured/); } finally { Object.assign(process.env, saved); }
});
