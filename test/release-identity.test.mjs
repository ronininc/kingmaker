// The Kingmaker Release signing identity: one certificate signs every Kingmaker, so every owner's macOS permissions
// survive every update; its public fingerprint is pinned and checked at build, install and update; its private key
// stays on the owner's release Mac (keychain + encrypted vault backup), never in a build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appRequirement, backupFile, certConfig, fileRequirement, leafFromRequirement, passphraseProblem, readPin, RELEASE_CERT_DAYS, sha1FromFingerprint } from '../lib/release-identity.mjs';
import { createIdentity, identityStatus, restoreIdentity } from '../scripts/kingmaker-release-identity.mjs';
// Ronin's signing helper needs its private signing scripts (operator tooling, not in the public repo).
const { resolveKingmakerSigning } = await import('../scripts/kingmaker-mac-signing.mjs').catch(() => ({}));
import { shipProblems } from '../lib/release-manifest.mjs';
import { applyUpdate } from '../lib/update.mjs';
import { generateReleaseKeypair, signManifestBytes } from '../lib/release-signing.mjs';

const SHA1 = 'A1B2C3D4E5F60718293A4B5C6D7E8F9012345678';
const FP = SHA1.match(/../g).join(':');
const place = () => mkdtempSync(join(tmpdir(), 'km-rid-'));

test('requirements name this app and exactly this certificate; fingerprints and codesign output are read right', () => {
  assert.equal(appRequirement(SHA1.toLowerCase()), `identifier "com.ronininc.solghost" and certificate leaf = H"${SHA1}"`);
  assert.equal(fileRequirement(SHA1), `certificate leaf = H"${SHA1}"`);
  assert.throws(() => appRequirement(null), /no pinned/);
  assert.equal(leafFromRequirement(`Executable=/x\ndesignated => identifier "com.ronininc.solghost" and certificate leaf = H"${SHA1.toLowerCase()}"`), SHA1);
  assert.equal(leafFromRequirement('designated => cdhash H"abc"'), null, 'ad hoc: no certificate');
  assert.equal(sha1FromFingerprint(`sha1 Fingerprint=${FP}`), SHA1);
  assert.equal(sha1FromFingerprint(`SHA1 Fingerprint=${FP}\n`), SHA1, 'OpenSSL and LibreSSL spell it differently');
  assert.match(certConfig(), /extendedKeyUsage = critical,codeSigning/); assert.match(certConfig(), /CA:false/); assert.match(certConfig(), /O = Ronin Inc\./);
  assert.ok(RELEASE_CERT_DAYS >= 30 * 365, 'thirty years: it must not expire under owners');
  assert.ok(passphraseProblem('short')); assert.ok(passphraseProblem('aaaaaaaaaaaaaaaa')); assert.equal(passphraseProblem('correct horse battery staple'), null);
});

test('the pin is the public fingerprint only; none yet reads as none, and builds fall back to this Mac\'s own identity', () => {
  const d = place(), f = join(d, 'pin.json');
  writeFileSync(f, '{"name":"Kingmaker Release","sha1":null}'); assert.equal(readPin(f), null);
  writeFileSync(f, JSON.stringify({ name: 'Kingmaker Release', sha1: SHA1.toLowerCase() })); assert.equal(readPin(f).sha1, SHA1);
  const shipped = readFileSync(new URL('../lib/release-identity.json', import.meta.url), 'utf8');
  assert.doesNotMatch(shipped, /-----BEGIN/, 'the shipped file never holds a key or certificate body');
  for (const k of Object.keys(JSON.parse(shipped))) assert.ok(['_comment', 'name', 'sha1', 'sha256', 'notAfter', 'createdAt'].includes(k), `only public facts: ${k}`);
  const listed = `  1) ${SHA1} "Kingmaker Release" (CSSMERR_TP_NOT_TRUSTED)\n  1 identities found`;
  if (resolveKingmakerSigning) {
    const plan = resolveKingmakerSigning({ env: {}, identitiesText: listed, pin: { name: 'Kingmaker Release', sha1: SHA1 } });
    assert.equal(plan.identity, SHA1, 'once pinned, builds sign with Kingmaker Release');
  }
  assert.match(shipProblems({ packs: [1] }, { pin: null }).join(' '), /no Kingmaker Release certificate is pinned/);
  assert.doesNotMatch(shipProblems({ packs: [1] }, { pin: { sha1: SHA1 } }).join(' '), /pinned/);
});

/** A stand-in for openssl and security that does what they would, on files, and records every call. */
function fakeTools({ listed = '' } = {}) {
  const calls = []; let keychain = listed;
  const run = (cmd, args, opts = {}) => {
    calls.push({ cmd, args, env: opts.env ?? {} });
    const at = (flag) => args[args.indexOf(flag) + 1];
    if (cmd === 'openssl' && args[0] === 'req') { writeFileSync(at('-keyout'), 'UNENCRYPTED KEY'); writeFileSync(at('-out'), 'CERT'); return { status: 0, stdout: '', stderr: '' }; }
    if (cmd === 'openssl' && args[0] === 'x509' && args.includes('-sha1')) return { status: 0, stdout: `sha1 Fingerprint=${FP}\n`, stderr: '' };
    if (cmd === 'openssl' && args[0] === 'x509' && args.includes('-sha256')) return { status: 0, stdout: 'sha256 Fingerprint=AA:BB\n', stderr: '' };
    if (cmd === 'openssl' && args[0] === 'x509') return { status: 0, stdout: 'notAfter=Oct 10 00:00:00 2056 GMT\n', stderr: '' };
    if (cmd === 'openssl' && args[0] === 'rand') return { status: 0, stdout: 'f00d\n', stderr: '' };
    if (cmd === 'openssl' && args[0] === 'pkcs12') { if (args.includes('-export')) writeFileSync(at('-out'), 'P12'); else writeFileSync(at('-out'), args.includes('-nokeys') ? 'CERT' : 'KEY'); return { status: 0, stdout: '', stderr: '' }; }
    if (cmd === 'security' && args[0] === 'login-keychain') return { status: 0, stdout: '"/k/login.keychain-db"\n', stderr: '' };
    if (cmd === 'security' && args[0] === 'import') { keychain += `\n  1) ${SHA1} "Kingmaker Release" (CSSMERR_TP_NOT_TRUSTED)`; return { status: 0, stdout: '', stderr: '' }; }
    if (cmd === 'security' && args[0] === 'find-identity') return { status: 0, stdout: keychain, stderr: '' };
    if (cmd === 'security' && args[0] === '-i') { calls.at(-1).input = opts.input; return { status: 0, stdout: '', stderr: '' }; }
    return { status: 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}

test('create: once ever; the key goes to the keychain and an encrypted vault backup, the fingerprint to the pin', () => {
  const home = place(), pinFile = join(home, 'pin.json'), env = { HOME: home };
  writeFileSync(pinFile, '{"name":"Kingmaker Release","sha1":null}');
  const t = fakeTools();
  assert.throws(() => createIdentity({ passphrase: 'short', run: t.run, env, pinFile }), /Backup passphrase/);
  const pass = 'correct horse battery staple';
  const r = createIdentity({ passphrase: pass, run: t.run, env, pinFile, now: new Date('2026-10-15T00:00:00Z') });
  assert.equal(r.sha1, SHA1);
  assert.deepEqual(readPin(pinFile), { _comment: readPin(pinFile)._comment, name: 'Kingmaker Release', sha1: SHA1, sha256: 'AABB', notAfter: 'Oct 10 00:00:00 2056 GMT', createdAt: '2026-10-15T00:00:00.000Z' });
  assert.equal(r.backup, backupFile(env)); assert.equal(statSync(r.backup).mode & 0o777, 0o600); assert.equal(statSync(join(home, '.solomon-secure', 'kingmaker-release')).mode & 0o777, 0o700);
  // The passphrase never goes on a command line (where `ps` shows it), and the unencrypted key never outlives the run.
  for (const c of t.calls) assert.ok(!c.args.some((a) => String(a).includes(pass)), `${c.cmd} ${c.args[0]} took the passphrase as an argument`);
  assert.ok(t.calls.some((c) => c.env.KM_BACKUP_PASS === pass), 'it went through the environment');
  const keyPath = t.calls.find((c) => c.args[0] === 'req').args.find((a, i, all) => all[i - 1] === '-keyout');
  assert.equal(existsSync(keyPath), false);
  assert.ok(t.calls.find((c) => c.args[0] === 'req').args.includes('rsa:3072'));
  // Never a second one.
  assert.throws(() => createIdentity({ passphrase: pass, run: t.run, env, pinFile }), /already pinned/);
  const fresh = join(home, 'pin2.json'); writeFileSync(fresh, '{"sha1":null}');
  assert.throws(() => createIdentity({ passphrase: pass, run: fakeTools({ listed: `1) ${SHA1} "Kingmaker Release"` }).run, env: { HOME: place() }, pinFile: fresh }), /already holds/);
  assert.throws(() => createIdentity({ passphrase: pass, run: fakeTools().run, env, pinFile: fresh }), /already exists; it may be the only copy/, 'an existing backup is never overwritten');
  assert.deepEqual(identityStatus({ run: t.run, env, pinFile, now: new Date('2026-10-15T00:00:00Z') }), { pinned: SHA1, inKeychain: true, backup: r.backup, backupPrivate: true, yearsLeft: 30 });
});

test('create needs nothing typed: the passphrase is made and kept in the keychain first, by stdin, never argv', () => {
  const home = place(), pinFile = join(home, 'pin.json'), env = { HOME: home };
  writeFileSync(pinFile, '{"sha1":null}');
  const t = fakeTools();
  const r = createIdentity({ run: t.run, env, pinFile });
  assert.equal(r.passphraseInKeychain, true); assert.equal(r.partitionOk, false, 'no login password asked: macOS\'s Always Allow popup instead');
  const saved = t.calls.find((c) => c.args[0] === '-i');
  const pass = /-w ([0-9a-f]{48})\n$/.exec(saved.input)?.[1];
  assert.ok(pass, 'a 48-character random passphrase went in by stdin');
  assert.ok(t.calls.indexOf(saved) < t.calls.findIndex((c) => c.args.includes('-export') && c.env.KM_BACKUP_PASS), 'kept before anything is encrypted with it');
  assert.equal(t.calls.find((c) => c.env.KM_BACKUP_PASS)?.env.KM_BACKUP_PASS, pass);
  for (const c of t.calls) assert.ok(!c.args.some((a) => String(a).includes(pass)), 'never on a command line');
  assert.ok(!t.calls.some((c) => c.args[0] === 'set-key-partition-list'));
});

test('restore puts back only the pinned certificate', () => {
  const home = place(), pinFile = join(home, 'pin.json'), p12 = join(home, 'b.p12');
  writeFileSync(p12, 'P12');
  writeFileSync(pinFile, JSON.stringify({ name: 'Kingmaker Release', sha1: 'F'.repeat(40) }));
  assert.throws(() => restoreIdentity(p12, { passphrase: 'x', run: fakeTools().run, pinFile }), /holds A1B2.*not the pinned F{40}/);
  writeFileSync(pinFile, JSON.stringify({ name: 'Kingmaker Release', sha1: SHA1 }));
  assert.deepEqual(restoreIdentity(p12, { passphrase: 'x', run: fakeTools().run, pinFile }), { sha1: SHA1 });
});

test('an update runs only an installer script signed by the pinned certificate, and hands the pin on', async () => {
  const home = place(), engine = '#!/bin/bash\necho hi\n', sha = createHash('sha256').update(engine).digest('hex');
  mkdirSync(join(home, 'logs'), { recursive: true });
  // The manifest is signed by the offline release key (main's layer); this test is about the engine's own signature.
  const { publicKeyPem, privateKeyPem } = generateReleaseKeypair();
  const manifest = `${JSON.stringify({ schema: 'kingmaker.release/1', tag: 'v0.3.0', engine: { name: 'engine.sh', sha256: sha } })}\n`;
  const manifestSig = signManifestBytes(Buffer.from(manifest), privateKeyPem);
  const files = (withSig) => async (url) => { const p = new URL(url).pathname; const body = { '/v0.3.0/engine.sh': engine, '/v0.3.0/kingmaker-manifest.json': manifest, '/v0.3.0/kingmaker-manifest.json.sig': manifestSig, ...(withSig ? { '/v0.3.0/engine.sh.sig': 'SIG' } : {}) }[p];
    return body == null ? { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0), text: async () => '' } : { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(body).buffer, text: async () => body, json: async () => JSON.parse(body) }; };
  const cfg = { url: 'https://u', key: 'k' }, offer = { tag: 'v0.3.0', engineSha256: sha }, pin = { sha1: SHA1 };
  let spawned = null; const spawnImpl = (cmd, args, o) => { spawned = o; return { unref() {} }; };
  await assert.rejects(applyUpdate(cfg, offer, { dataDir: home, wakeWord: 'Nova', home, pin, publicKeyPem, fetchImpl: files(false), spawnImpl, verifyImpl: () => true }), /not signed by the Kingmaker Release/);
  await assert.rejects(applyUpdate(cfg, offer, { dataDir: home, wakeWord: 'Nova', home, pin, publicKeyPem, fetchImpl: files(true), spawnImpl, verifyImpl: () => false }), /not signed by the Kingmaker Release/);
  assert.equal(spawned, null, 'nothing ran');
  let checked = null;
  await applyUpdate(cfg, offer, { dataDir: home, wakeWord: 'Nova', home, pin, publicKeyPem, fetchImpl: files(true), spawnImpl, verifyImpl: (f, s, h) => { checked = [f.endsWith('engine.sh'), s.endsWith('engine.sh.sig'), h]; return true; } });
  assert.deepEqual(checked, [true, true, SHA1]);
  assert.equal(spawned.env.KINGMAKER_EXPECT_LEAF, SHA1, 'the engine installs only an app signed by the pin THIS Kingmaker carries');
});

test('a create cut off after the backup is finished by restore, never stranded', () => {
  const home = place(), pinFile = join(home, 'pin.json'), env = { HOME: home };
  writeFileSync(pinFile, '{"sha1":null}');
  const t = fakeTools();
  const broken = (cmd, args, opts) => (cmd === 'security' && args[0] === 'import' ? { status: 1, stdout: '', stderr: 'denied' } : t.run(cmd, args, opts));
  assert.throws(() => createIdentity({ passphrase: 'correct horse battery staple', run: broken, env, pinFile, now: new Date('2026-10-15T00:00:00Z') }), /backup .* is kept: run restore/);
  assert.equal(readPin(pinFile), null, 'not pinned yet');
  assert.ok(existsSync(backupFile(env)));
  const r = restoreIdentity(backupFile(env), { passphrase: 'correct horse battery staple', run: t.run, pinFile, env });
  assert.deepEqual(r, { sha1: SHA1, pinnedNow: true });
  assert.equal(readPin(pinFile).sha1, SHA1); assert.equal(readPin(pinFile).createdAt, '2026-10-15T00:00:00.000Z');
  assert.equal(existsSync(join(home, '.solomon-secure', 'kingmaker-release', 'pending-pin.json')), false);
});
