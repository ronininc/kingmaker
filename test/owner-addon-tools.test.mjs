// The owner's add-on tooling (scripts/mint-entitlement.mjs, scripts/owner-install-ronin-addon.mjs), proved with THROWAWAY
// keys only — no real key is read here. A minted entitlement must verify in lib/addons.mjs / lib/addon-entitlement.mjs AND in
// the update host's verifier (update-host/worker.js); the built, signed Ronin add-on must install into a temp state dir and
// load, and not load without its entitlement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as core from '../lib/addons.mjs';
import { ADDON_CORE } from '../lib/addon-core.mjs';
import { makeAddonVerifiers, entitlementId } from '../lib/addon-entitlement.mjs';
import { buildAddon } from '../addons/build-addon.mjs';
import { signManifestBytes } from '../lib/release-signing.mjs';
import { mintEntitlement, ownerInstallId, parseArgs, readThisMac, run as mint, thisMacDeviceHash } from '../scripts/mint-entitlement.mjs';
import { ownerInstall, parseArgs as parseOwnerArgs } from '../scripts/owner-install-ronin-addon.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const SKU = 'addon.ronin-office';
const INSTALL = '3f2c9a10-5b7e-4d21-9c3a-0a1b2c3d4e5f';
const DEVICE = createHash('sha256').update('some-hardware-uuid\n').digest('hex');
const tmp = (p) => mkdtempSync(join(tmpdir(), `km-owner-${p}-`));
const ec = () => { const k = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }); return { priv: k.privateKey.export({ type: 'pkcs8', format: 'pem' }), pub: k.publicKey.export({ type: 'spki', format: 'pem' }) }; };
const rsa = () => { const k = generateKeyPairSync('rsa', { modulusLength: 2048 }); return { priv: k.privateKey.export({ type: 'pkcs8', format: 'pem' }), pub: k.publicKey.export({ type: 'spki', format: 'pem' }) }; };

// Throwaway keys, written the way the owner's are kept (0600), plus a wrong key of each kind.
const dir = tmp('keys');
const cert = ec(), wrongCert = ec(), release = rsa(), wrongRelease = rsa();
const file = (name, text) => { const p = join(dir, name); writeFileSync(p, text, { mode: 0o600 }); chmodSync(p, 0o600); return p; };
const certKey = file('cert-private.pem', cert.priv), wrongCertKey = file('wrong-cert-private.pem', wrongCert.priv);
const certPub = file('cert-public.pem', cert.pub), releasePub = file('release-public.pem', release.pub);
const releaseKey = file('release-private.pem', release.priv), wrongReleaseKey = file('wrong-release-private.pem', wrongRelease.priv);
const mac = { installId: INSTALL, deviceSha256: DEVICE, note: null };

const mintTo = (extra = [], io = {}) => {
  const out = join(tmp('ent'), 'e.json'), say = [], oops = [];
  const code = mint(['--sku', SKU, '--key', certKey, '--pub', certPub, '--out', out, ...extra], { out: (s) => say.push(s), err: (s) => oops.push(s), ...io });
  return { code, out, say: say.join('\n'), err: oops.join('\n'), env: existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null };
};

/* ---------- the update host's verifier, run from the real worker source ---------- */

const worker = (await import('data:text/javascript;base64,' + Buffer.from(readFileSync(join(ROOT, 'update-host/worker.js'), 'utf8')).toString('base64'))).default;
const b64 = (s) => Buffer.from(s).toString('base64');
const ZIP = Buffer.from('PK pretend zip');
const hostEnv = (signingKeyPem, revoked = new Set()) => ({
  CERT_SIGNING_KEY: signingKeyPem, UPDATE_KEYS: 'op-key',
  RELEASES: { get: async (k) => (k === `addons/ronin-office/${VERSION}/ronin-office-${VERSION}.zip` ? { size: ZIP.length, httpEtag: '"z"', writeHttpMetadata(h) { h.set('content-type', 'application/zip'); }, body: ZIP, range: undefined } : null) },
  DEVICES: { get: async (k) => (revoked.has(k) ? '1' : null), put: async () => {} },
});
const fetchZip = (envelope, env) => worker.fetch(new Request(`https://host/addons/ronin-office/${VERSION}/ronin-office-${VERSION}.zip`, { headers: { 'x-ronin-entitlement': b64(JSON.stringify(envelope)) } }), env);

/* ---------- minting ---------- */

test('a minted entitlement verifies in lib/addons.mjs and in the update host, and writes the envelope the engine reads', async () => {
  const r = mintTo(['--install', INSTALL, '--device', DEVICE, '--order', 'ord_owner_1']);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(Object.keys(r.env).sort(), ['alg', 'payload', 'sig'], 'exactly { payload, sig, alg }');
  assert.equal(r.env.alg, 'ES256');
  assert.equal(statSync(r.out).mode & 0o777, 0o600);
  const claims = core.verifyEntitlementEnvelope(r.env, cert.pub);
  assert.deepEqual({ schema: claims.schema, issuer: claims.issuer, sku: claims.sku, installId: claims.installId, deviceSha256: claims.deviceSha256, order: claims.order, expiresAt: claims.expiresAt },
    { schema: 'ronin.entitlement/1', issuer: 'ronin-update-host', sku: SKU, installId: INSTALL, deviceSha256: DEVICE, order: 'ord_owner_1', expiresAt: null });
  assert.ok(Date.parse(claims.grantedAt) <= Date.now());
  const v = core.defaultVerifiers({ certKeyPem: cert.pub });
  assert.equal(v.verifyEntitlement(r.env, { sku: SKU, install: { installId: INSTALL, deviceSha256: DEVICE } }), true, 'the engine\'s own check');
  const res = await fetchZip(r.env, hostEnv(cert.priv));
  assert.equal(res.status, 200, 'the update host serves the add-on to it');
  assert.equal(Buffer.from(await res.arrayBuffer()).toString(), ZIP.toString());
});

test('a wrong key, an expired entitlement or a mismatched installId or device fails, in both verifiers', async () => {
  // wrong key: the CLI refuses to write it, and signed by another key it verifies nowhere
  const refused = mintTo(['--install', INSTALL], {});
  const bad = mint(['--sku', SKU, '--key', wrongCertKey, '--pub', certPub, '--out', join(tmp('bad'), 'e.json'), '--install', INSTALL], { out() {}, err() {} });
  assert.equal(bad, 1, 'a key that does not match the public key writes nothing');
  assert.equal(refused.code, 0);
  const forged = mintEntitlement({ privateKeyPem: wrongCert.priv, sku: SKU, installId: INSTALL, deviceSha256: DEVICE }).envelope;
  assert.equal(core.verifyEntitlementEnvelope(forged, cert.pub), null);
  assert.equal(core.defaultVerifiers({ certKeyPem: cert.pub }).verifyEntitlement(forged, { sku: SKU, install: { installId: INSTALL } }), false);
  assert.equal((await fetchZip(forged, hostEnv(cert.priv))).status, 401, 'the update host refuses a forged one');
  assert.equal((await fetchZip(refused.env, hostEnv(wrongCert.priv))).status, 401, 'and a host holding a different key refuses a genuine one');
  // expired: minted two days ago for one day
  const old = mintTo(['--install', INSTALL, '--days', '1'], { now: () => Date.now() - 2 * 86_400_000 });
  assert.equal(old.code, 0);
  assert.equal(core.defaultVerifiers({ certKeyPem: cert.pub }).verifyEntitlement(old.env, { sku: SKU, install: { installId: INSTALL } }), false, 'expired in the engine');
  assert.equal((await fetchZip(old.env, hostEnv(cert.priv))).status, 401, 'expired at the update host');
  const live = mintTo(['--install', INSTALL, '--days', '30']);
  assert.ok(Date.parse(JSON.parse(live.env.payload).expiresAt) > Date.now() + 29 * 86_400_000);
  assert.equal(core.defaultVerifiers({ certKeyPem: cert.pub }).verifyEntitlement(live.env, { sku: SKU, install: { installId: INSTALL } }), true);
  // mismatched installId / device / sku
  const v = core.defaultVerifiers({ certKeyPem: cert.pub });
  const good = mintTo(['--install', INSTALL, '--device', DEVICE]).env;
  assert.equal(v.verifyEntitlement(good, { sku: SKU, install: { installId: 'someone-elses-install' } }), false, 'installId');
  assert.equal(v.verifyEntitlement(good, { sku: SKU, install: { installId: INSTALL, deviceSha256: 'f'.repeat(64) } }), false, 'device');
  assert.equal(v.verifyEntitlement(good, { sku: 'addon.meeting-notes', install: { installId: INSTALL } }), false, 'sku');
  assert.equal((await fetchZip(good, hostEnv(cert.priv, new Set([`revoked:install:${encodeURIComponent(INSTALL)}`])))).status, 401, 'a revoked install');
});

test('with no --order the update host keys revocation by installId:sku, as entitlementId does', async () => {
  const r = mintTo(['--install', INSTALL]);
  const claims = core.verifyEntitlementEnvelope(r.env, cert.pub);
  assert.equal(claims.order, undefined);
  assert.equal(entitlementId(claims), `${INSTALL}:${SKU}`);
  assert.equal((await fetchZip(r.env, hostEnv(cert.priv))).status, 200);
  assert.equal((await fetchZip(r.env, hostEnv(cert.priv, new Set([`revoked:ent:${encodeURIComponent(`${INSTALL}:${SKU}`)}`])))).status, 401);
});

test('the CLI never prints a key, takes the key only by path, and refuses nonsense', () => {
  const r = mintTo(['--install', INSTALL, '--device', DEVICE]);
  const seen = `${r.say}\n${r.err}`;
  assert.doesNotMatch(seen, /PRIVATE KEY|BEGIN /);
  for (const line of cert.priv.split('\n').filter((l) => l.length > 20)) assert.ok(!seen.includes(line) && !JSON.stringify(r.env).includes(line));
  assert.match(r.say, /verifies:\s+against public key/);
  // errors name the path, not the key
  const missing = mint(['--sku', SKU, '--install', INSTALL, '--key', join(dir, 'nope.pem'), '--out', join(tmp('x'), 'e.json')], { out() {}, err: (s) => assert.doesNotMatch(s, /BEGIN/) });
  assert.equal(missing, 1);
  const quiet = { out() {}, err() {} };
  assert.equal(mint([], quiet), 1, '--sku is required');
  assert.equal(mint(['--sku', SKU], quiet), 1, 'which Mac is required');
  assert.equal(mint(['--sku', SKU, '--install', INSTALL, '--this-mac'], quiet), 1);
  assert.equal(mint(['--sku', 'nope', '--install', INSTALL, '--key', certKey, '--pub', certPub], quiet), 1, 'sku must be addon.<id>');
  assert.equal(mint(['--sku', SKU, '--install', INSTALL, '--days', '5', '--no-expiry'], quiet), 2);
  assert.equal(mint(['--bogus'], quiet), 2);
  assert.throws(() => parseArgs(['--days', '0']));
  // a key that is not P-256 is refused
  assert.throws(() => mintEntitlement({ privateKeyPem: release.priv, sku: SKU, installId: INSTALL }), /P-256/);
});

test('--this-mac reads the installId and device hash from the install certificate in the Keychain', () => {
  const certJson = JSON.stringify({ payload: JSON.stringify({ schema: 'ronin.install-cert/1', installId: INSTALL, deviceSha256: DEVICE, bundleId: 'x', issuer: 'ronin-update-host' }), sig: 'AA==', alg: 'ES256' });
  let called;
  const got = readThisMac({ run: (cmd, args) => { called = [cmd, args]; return certJson + '\n'; }, deviceHash: () => DEVICE });
  assert.deepEqual([got.installId, got.deviceSha256, got.note, got.source], [INSTALL, DEVICE, null, 'certificate']);
  assert.equal(called[0], '/usr/bin/security');
  assert.deepEqual(called[1], ['find-generic-password', '-s', 'com.ronininc.ronin-launcher', '-a', 'kingmaker-install-cert', '-w']);
  assert.equal(readThisMac({ run: () => Buffer.from(certJson).toString('hex'), deviceHash: () => DEVICE }).installId, INSTALL, '-w hex form');
  assert.match(readThisMac({ run: () => certJson, deviceHash: () => 'a'.repeat(64) }).note, /differs/);
  assert.throws(() => readThisMac({ run: () => { throw Object.assign(new Error('locked'), { status: 36 }); } }), /could not read the install certificate/, 'a locked Keychain is not "no certificate"');
  assert.throws(() => readThisMac({ run: () => 'garbage' }), /not readable/);
  const ioreg = '| |   "IOPlatformUUID" = "ABCD-1234"\n';
  assert.equal(thisMacDeviceHash(() => ioreg), createHash('sha256').update('ABCD-1234\n').digest('hex'), 'the installer\'s ioreg | awk | shasum');
  const r = mintTo(['--this-mac'], { thisMac: () => mac });
  assert.equal(r.code, 0, r.err);
  const claims = core.verifyEntitlementEnvelope(r.env, cert.pub);
  assert.deepEqual([claims.installId, claims.deviceSha256], [INSTALL, DEVICE]);
});

test('--this-mac on a Mac with no install certificate falls back to owner-<hostname> and the installer\'s device hash, and says so', async () => {
  const notFound = () => { throw Object.assign(new Error('The specified item could not be found in the keychain.'), { status: 44 }); };
  const ioreg = '| |   "IOPlatformUUID" = "ABCD-1234"\n';
  const want = createHash('sha256').update('ABCD-1234\n').digest('hex');
  const got = readThisMac({ run: notFound, deviceHash: () => thisMacDeviceHash(() => ioreg), hostId: () => ownerInstallId((cmd) => 'Yordans-Mac-mini\n') });
  assert.deepEqual([got.installId, got.deviceSha256, got.source], ['owner-yordans-mac-mini', want, 'derived']);
  assert.match(got.note, /no install certificate is stored/);
  assert.equal(ownerInstallId(() => { throw new Error('no scutil'); }, () => 'My_Mac.local'), 'owner-my-mac');
  assert.ok(ownerInstallId(() => 'x'.repeat(200)).length <= 64);
  // through the CLI: minted, verifies, and the output and note say it was derived
  const r = mintTo(['--this-mac'], { thisMac: () => got });
  assert.equal(r.code, 0, r.err);
  assert.match(r.say, /DERIVED: no install certificate on this Mac/);
  assert.match(r.err, /no install certificate is stored/);
  const claims = core.verifyEntitlementEnvelope(r.env, cert.pub);
  assert.deepEqual([claims.installId, claims.deviceSha256], ['owner-yordans-mac-mini', want]);
  assert.equal(core.defaultVerifiers({ certKeyPem: cert.pub }).verifyEntitlement(r.env, { sku: SKU, install: { installId: 'owner-yordans-mac-mini', deviceSha256: want } }), true);
  assert.equal((await fetchZip(r.env, hostEnv(cert.priv))).status, 200, 'the update host accepts it');
  // and the one-command flow installs with it
  const f = await flow({}, { thisMac: () => got });
  assert.equal(f.code, 0, `${f.say}\n${f.err}`);
  assert.match(f.say, /DERIVED/); assert.match(f.err, /no install certificate is stored/);
});

/* ---------- the add-on: built, signed, installed into a temp state dir, loaded ---------- */

const REQ = { kingmaker: VERSION, launcher: '0.3.0', arch: 'arm64' };
const verifiers = ({ revoked = false, install = {} } = {}) => makeAddonVerifiers({
  install, certKeyPem: cert.pub, releaseKeyPem: release.pub, config: { url: 'https://host.test', key: 'k' }, cacheDir: join(tmp('cache'), 'c'),
  fetchImpl: async () => ({ ok: true, json: async () => ({ revoked }) }),
});

function stageSigned(signKey = release.priv) {
  const out = tmp('build');
  const { dir: built, manifest, archivePath } = buildAddon('ronin', { out });
  const staged = tmp('staged');
  assert.equal(spawnSync('unzip', ['-q', archivePath, '-d', staged]).status, 0);
  const bytes = readFileSync(join(built, 'manifest.json'));
  writeFileSync(join(staged, 'manifest.json'), bytes);
  writeFileSync(join(staged, 'manifest.json.sig'), signManifestBytes(bytes, signKey));
  return { staged, manifest };
}

test('the built and signed add-on installs into a temp state dir and loads with the Ronin features; without its entitlement it does not', async () => {
  const { staged, manifest } = stageSigned();
  const ent = mintTo(['--install', INSTALL, '--device', DEVICE]).env;
  const state = tmp('state'), root = join(state, 'addons');
  const r = await core.installAddon({ stagedDir: staged, root, entitlement: ent, requires: REQ, ...verifiers() });
  assert.deepEqual(r, { id: 'ronin-office', version: manifest.version });
  assert.equal(statSync(join(root, 'ronin-office', manifest.version, 'entitlement.json')).mode & 0o777, 0o600);

  core.forgetAddons();
  assert.equal(core.ronin, null);
  const events = [];
  const host = core.makeHost({ version: VERSION, paths: root, log: (e, d) => events.push([e, d]), services: { lib: ADDON_CORE } });
  const loaded = await core.loadAddons(host, { root, requires: REQ, ...verifiers(), log: (e, d) => events.push([e, d]) });
  assert.deepEqual(loaded, ['ronin-office'], JSON.stringify(events));
  for (const f of ['roninCommand', 'isStopApproving', 'activeCrmLock', 'startPairing', 'ownerCallCommand', 'setCrmLock']) assert.equal(typeof core.ronin[f], 'function', `Ronin feature ${f} is present`);
  core.forgetAddons();

  // the entitlement removed from the installed copy: it does not load
  rmSync(join(root, 'ronin-office', manifest.version, 'entitlement.json'));
  const events2 = [];
  assert.deepEqual(await core.loadAddons(host, { root, requires: REQ, ...verifiers(), log: (e, d) => events2.push([e, d]) }), []);
  assert.equal(core.ronin, null, 'the free edition again');
  assert.match(JSON.stringify(events2), /holds no entitlement/);

  // and it will not install without one (or with a bad one)
  const fresh = join(tmp('state'), 'addons');
  await assert.rejects(core.installAddon({ stagedDir: staged, root: fresh, entitlement: null, requires: REQ, ...verifiers() }), /holds no entitlement/);
  await assert.rejects(core.installAddon({ stagedDir: staged, root: fresh, entitlement: mintEntitlement({ privateKeyPem: wrongCert.priv, sku: SKU, installId: INSTALL }).envelope, requires: REQ, ...verifiers() }), /entitlement did not verify/);
  await assert.rejects(core.installAddon({ stagedDir: staged, root: fresh, entitlement: ent, requires: REQ, ...verifiers({ revoked: true }) }), /entitlement did not verify/, 'revoked');
  await assert.rejects(core.installAddon({ stagedDir: staged, root: fresh, entitlement: ent, requires: REQ, ...verifiers({ install: { installId: 'another-mac' } }) }), /entitlement did not verify/, 'installId mismatch');
  assert.deepEqual(core.listAddons({ root: fresh }), []);
});

test('a manifest signed by the wrong release key does not install', async () => {
  const { staged } = stageSigned(wrongRelease.priv);
  const ent = mintTo(['--install', INSTALL]).env;
  await assert.rejects(core.installAddon({ stagedDir: staged, root: join(tmp('state'), 'addons'), entitlement: ent, requires: REQ, ...verifiers() }), /manifest signature did not verify/);
});

/* ---------- the owner's one-command flow, against a stand-in installed app ---------- */

// A stand-in Kingmaker.app whose CLI does what lib/cli.mjs does for `addons install|list` (the entitlement on stdin) and
// loads add-ons for `crm-lock status` — with the throwaway public keys the pinned ones cannot be swapped for.
function fakeApp({ version = VERSION, hook = true } = {}) {
  const app = join(tmp('app'), 'Kingmaker.app'), eng = join(app, 'Contents', 'Resources', 'sol-ghost');
  mkdirSync(join(eng, 'bin'), { recursive: true }); mkdirSync(join(eng, 'lib'), { recursive: true });
  writeFileSync(join(eng, 'package.json'), JSON.stringify({ name: 'kingmaker', version }));
  if (hook) writeFileSync(join(eng, 'lib', 'addons.mjs'), '// the add-on loader\n');
  const u = (p) => pathToFileURL(join(ROOT, p)).href;
  writeFileSync(join(eng, 'engine.mjs'), `
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as core from ${JSON.stringify(u('lib/addons.mjs'))};
import { makeAddonVerifiers } from ${JSON.stringify(u('lib/addon-entitlement.mjs'))};
import { ADDON_CORE } from ${JSON.stringify(u('lib/addon-core.mjs'))};
const [cmd, ...args] = process.argv.slice(2);
const root = join(process.env.SOL_GHOST_HOME, 'addons');
const deps = { root, requires: { kingmaker: ${JSON.stringify(version)}, arch: process.arch === 'arm64' ? 'arm64' : process.arch }, install: {},
  ...makeAddonVerifiers({ install: {}, cacheDir: join(root, '.cache'), config: { url: 'https://host.test', key: 'k' },
    certKeyPem: readFileSync(process.env.KM_TEST_CERT_PUB), releaseKeyPem: readFileSync(process.env.KM_TEST_RELEASE_PUB),
    fetchImpl: async () => ({ ok: true, json: async () => ({ revoked: false }) }) }) };
if (cmd === 'addons') {
  if (args[0] === 'install') { let t = ''; for await (const c of process.stdin) t += c; if (t.trim()) deps.entitlement = JSON.parse(t); }
  const r = await core.dispatchAddons(args, deps); if (r.output) console.log(r.output); process.exit(r.ok ? 0 : 1);
}
if (cmd === 'crm-lock') {
  await core.loadAddons(core.makeHost({ version: ${JSON.stringify(version)}, paths: root, services: { lib: ADDON_CORE } }), deps);
  if (!core.ronin) { console.error(core.roninOnly('kingmaker crm-lock')); process.exit(2); }
  console.log('Not locked: no CRM is attached unless the owner connects one.'); process.exit(0);
}
process.exit(2);
`);
  const cli = join(eng, 'bin', 'kingmaker');
  writeFileSync(cli, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(eng, 'engine.mjs'))} "$@"\n`, { mode: 0o755 });
  return { app, cli };
}

async function flow(over = {}, ioOver = {}) {
  const { app } = over.app ? { app: over.app } : fakeApp();
  const state = over.state ?? tmp('flow-state'), say = [], oops = [];
  const env = { SOL_GHOST_HOME: state, KM_TEST_CERT_PUB: certPub, KM_TEST_RELEASE_PUB: releasePub };
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    const o = parseOwnerArgs(['--sign-key', releaseKey, '--cert-key', certKey, '--app', app, ...(over.args ?? [])], {});
    const code = await ownerInstall(o, { say: (s) => say.push(s), err: (s) => oops.push(s), thisMac: () => mac, releasePub: release.pub, certPub, ...ioOver });
    return { code, say: say.join('\n'), err: oops.join('\n'), state, app };
  } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
const engine = (r, args) => spawnSync(join(r.app, 'Contents/Resources/sol-ghost/bin/kingmaker'), args, { encoding: 'utf8', env: { ...process.env, SOL_GHOST_HOME: r.state, KM_TEST_CERT_PUB: certPub, KM_TEST_RELEASE_PUB: releasePub } });

test('owner flow: builds, signs, mints this Mac\'s entitlement and installs with the installed app\'s own engine; re-running works; secrets are never printed', async () => {
  const r = await flow();
  assert.equal(r.code, 0, `${r.say}\n${r.err}`);
  assert.match(r.say, /1\/5 Built ronin-office/); assert.match(r.say, /2\/5 Signed/); assert.match(r.say, /3\/5 Staged/); assert.match(r.say, /4\/5 Minted addon\.ronin-office for install /); assert.match(r.say, /5\/5 Installed .*installed ronin-office/s);
  assert.match(r.say, /installed and loads/);
  const everything = `${r.say}\n${r.err}`;
  assert.doesNotMatch(everything, /BEGIN [A-Z ]*KEY/);
  for (const pem of [cert.priv, release.priv]) for (const line of pem.split('\n').filter((l) => l.length > 20)) assert.ok(!everything.includes(line));
  const root = join(r.state, 'addons', 'ronin-office');
  assert.equal(JSON.parse(readFileSync(join(root, 'current.json'), 'utf8')).version, VERSION);
  assert.equal(statSync(join(root, VERSION, 'entitlement.json')).mode & 0o777, 0o600);
  assert.equal(engine(r, ['addons', 'list']).stdout.trim(), `ronin-office ${VERSION}`);
  assert.equal(engine(r, ['crm-lock', 'status']).status, 0, 'the Ronin commands load');
  // re-run over the same state dir
  const again = await flow({ app: r.app, state: r.state });
  assert.equal(again.code, 0, `${again.say}\n${again.err}`);
  assert.equal(engine(r, ['addons', 'list']).stdout.trim(), `ronin-office ${VERSION}`);
  // without the entitlement the installed copy does not load: the Ronin commands say so
  rmSync(join(root, VERSION, 'entitlement.json'));
  const off = engine(r, ['crm-lock', 'status']);
  assert.equal(off.status, 2);
  assert.match(off.stderr, /part of the Ronin add-on/);
});

test('owner flow: --dry-run installs nothing; a wrong key, a version mismatch or an app without add-on support stops it with nothing installed', async () => {
  const dry = await flow({ args: ['--dry-run'] });
  assert.equal(dry.code, 0, dry.err); assert.match(dry.say, /dry-run/);
  assert.equal(existsSync(join(dry.state, 'addons')), false);

  const wrongSign = await flow({ args: ['--sign-key', wrongReleaseKey] });
  assert.equal(wrongSign.code, 1); assert.match(wrongSign.err, /does not verify against the pinned release public key/);
  assert.equal(existsSync(join(wrongSign.state, 'addons')), false);

  const wrongMint = await flow({ args: ['--cert-key', wrongCertKey] });
  assert.equal(wrongMint.code, 1); assert.match(wrongMint.err, /could not mint the entitlement/);
  assert.equal(existsSync(join(wrongMint.state, 'addons')), false);

  const mismatch = await flow({ app: fakeApp({ version: '9.9.9' }).app });
  assert.equal(mismatch.code, 1); assert.match(mismatch.err, /installed one is 9\.9\.9/);

  const old = await flow({ app: fakeApp({ hook: false }).app });
  assert.equal(old.code, 1); assert.match(old.err, /no add-on support yet/);

  const none = await flow({ app: join(tmp('none'), 'Kingmaker.app') });
  assert.equal(none.code, 1); assert.match(none.err, /no Kingmaker found/);
});

test('owner flow arguments', () => {
  assert.equal(parseOwnerArgs([], { KINGMAKER_RELEASE_SIGNING_KEY: '/k.pem' }).signKey, '/k.pem');
  assert.equal(parseOwnerArgs([], {}).app, '/Applications/Kingmaker.app');
  assert.throws(() => parseOwnerArgs(['--bogus'], {}));
});
