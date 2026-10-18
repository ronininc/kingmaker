#!/usr/bin/env node
// scripts/kingmaker-release-identity.mjs — make, back up, restore and check the Kingmaker Release signing identity
// (lib/release-identity.mjs says why). Run on the owner's release Mac only, by the owner.
//
//   node scripts/kingmaker-release-identity.mjs create            once, ever: the key + a 30-year certificate, into the
//                                                                  login keychain; an encrypted backup into the vault;
//                                                                  the public fingerprint into lib/release-identity.json
//   node scripts/kingmaker-release-identity.mjs restore <file.p12> a new or rebuilt release Mac: the backup back into the
//                                                                  keychain (refused unless it is the pinned certificate)
//   node scripts/kingmaker-release-identity.mjs status            pinned? in the keychain? backed up? years left?
//   node scripts/kingmaker-release-identity.mjs selftest          sign a scratch file and verify it against the pin
//   node scripts/kingmaker-release-identity.mjs sign-file <file>  <file>.sig: a detached signature (publish-update.sh
//                                                                  signs the installer script with it)
//
// Nothing to type (the owner, 2026-10-15: "no user is gonna be able to do that"). The backup's passphrase is made at
// random and kept in the login keychain ("Kingmaker Release backup"), where restore finds it again; it reaches openssl
// and the keychain through the environment and stdin, never a command line. codesign's first use of the key shows
// macOS's own "Always Allow" popup, once. Lose the key AND its backups and every owner re-grants their permissions once,
// after the next update signed with a new certificate.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { backupDir, backupFile, certConfig, fileRequirement, passphraseProblem, PIN_FILE, readPin, RELEASE_CERT_DAYS, RELEASE_IDENTITY_NAME, sha1FromFingerprint } from '../lib/release-identity.mjs';

const realRun = (cmd, args, { env = {}, input } = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', env: { ...process.env, ...env }, input });
  return { status: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' };
};
const say = (...a) => console.log(...a);

/** The keychain's code-signing identities (trust-agnostic: a self-signed one is "not trusted", and that's fine). */
export function keychainHas(sha1, { run = realRun } = {}) {
  const r = run('security', ['find-identity', '-p', 'codesigning']);
  return `${r.stdout}${r.stderr}`.toUpperCase().includes(String(sha1).toUpperCase());
}
export function keychainHasName(name, { run = realRun } = {}) {
  const r = run('security', ['find-identity', '-p', 'codesigning']);
  return `${r.stdout}${r.stderr}`.includes(`"${name}"`);
}

/** The certificate's facts from its PEM: { sha1, sha256, notAfter }. */
function certFacts(certPath, run) {
  const f1 = run('openssl', ['x509', '-in', certPath, '-noout', '-fingerprint', '-sha1']);
  const f2 = run('openssl', ['x509', '-in', certPath, '-noout', '-fingerprint', '-sha256']);
  const end = run('openssl', ['x509', '-in', certPath, '-noout', '-enddate']);
  const sha256 = (/fingerprint\s*=\s*([0-9A-F:]+)/i.exec(f2.stdout)?.[1] ?? '').replace(/:/g, '').toUpperCase() || null;
  return { sha1: sha1FromFingerprint(f1.stdout), sha256, notAfter: (/notAfter=(.+)/.exec(end.stdout)?.[1] ?? '').trim() || null };
}

/** openssl pkcs12 export, the passphrase by environment variable; classic algorithms, which macOS's importer reads. */
const p12Args = ({ keyPath, certPath, out, passEnv, name }) => ['pkcs12', '-export', '-inkey', keyPath, '-in', certPath, '-name', name, '-out', out,
  '-passout', `env:${passEnv}`, '-keypbe', 'PBE-SHA1-3DES', '-certpbe', 'PBE-SHA1-3DES', '-macalg', 'sha1'];

export const PASS_SERVICE = 'Kingmaker Release backup';
/** The backup passphrase into the login keychain, by stdin (`security -i`), never argv. */
export function savePassphrase(pass, { run = realRun } = {}) {
  if (!/^[0-9a-f]{32,}$/.test(pass)) throw new Error('a generated passphrase is hex');
  return run('security', ['-i'], { input: `add-generic-password -U -s "${PASS_SERVICE}" -a passphrase -l "${PASS_SERVICE}" -w ${pass}\n` }).status === 0;
}
/** The backup passphrase from the login keychain (macOS may ask, with its own Allow popup), or null. */
export function readPassphrase({ run = realRun } = {}) {
  const r = run('security', ['find-generic-password', '-s', PASS_SERVICE, '-a', 'passphrase', '-w']);
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

/** Into the login keychain, with codesign allowed to use the key: with the login password when given, else macOS's
 *  own "Always Allow" popup the first time codesign signs. */
function importIntoKeychain({ keyPath, certPath, name, work, run, keychainPassword }) {
  const transient = run('openssl', ['rand', '-hex', '16']).stdout.trim();
  if (!transient) throw new Error('openssl could not make a random transient passphrase');
  const p12 = join(work, 'import.p12');
  const pack = run('openssl', p12Args({ keyPath, certPath, out: p12, passEnv: 'KM_TRANSIENT', name }), { env: { KM_TRANSIENT: transient } });
  if (pack.status !== 0) throw new Error(`openssl pkcs12 failed: ${pack.stderr.trim()}`);
  const login = run('security', ['login-keychain']).stdout.trim().replace(/^"|"$/g, '');
  const imp = run('security', ['import', p12, '-k', login, '-P', transient, '-T', '/usr/bin/codesign', '-T', '/usr/bin/security']);
  if (imp.status !== 0) throw new Error(`security import failed: ${imp.stderr.trim()}`);
  if (!keychainPassword) return { partitionOk: false, login };
  const part = run('security', ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', keychainPassword, login]);
  return { partitionOk: part.status === 0, login };
}

const pinRecord = (facts, now) => ({
  _comment: 'The PUBLIC fingerprint of the Kingmaker Release signing certificate (lib/release-identity.mjs). Never the private key.',
  name: RELEASE_IDENTITY_NAME, sha1: facts.sha1, sha256: facts.sha256, notAfter: facts.notAfter, createdAt: now.toISOString(),
});
/** The public facts of a backup whose create was cut off before the pin was written (kept beside the backup), or null. */
export const pendingPinFile = (env = process.env) => join(backupDir(env), 'pending-pin.json');
export function readPendingPin(env = process.env) { return readPin(pendingPinFile(env)); }

/**
 * Make the identity, once. Refuses when one is pinned or already in the keychain: a second certificate would make every
 * owner re-grant. → { sha1, sha256, notAfter, backup }
 */
export function createIdentity({ passphrase = null, run = realRun, env = process.env, pinFile = PIN_FILE, now = new Date(), keychainPassword = env.KINGMAKER_KEYCHAIN_PASSWORD || '' } = {}) {
  const pinned = readPin(pinFile);
  if (pinned) throw new Error(`A Kingmaker Release certificate is already pinned (${pinned.sha1}). Never make a second: every owner would re-grant. On a new Mac, use restore with its backup.`);
  if (keychainHasName(RELEASE_IDENTITY_NAME, { run })) throw new Error(`The keychain already holds a "${RELEASE_IDENTITY_NAME}" identity. Pin it rather than make another (status shows its fingerprint).`);
  // A passphrase given (KINGMAKER_BACKUP_PASSPHRASE) is the owner's to keep; otherwise one is made and kept in the
  // keychain BEFORE anything is encrypted with it, so there is never a backup nobody can open.
  const generated = !passphrase;
  if (generated) passphrase = randomBytes(24).toString('hex');
  const problem = passphraseProblem(passphrase);
  if (problem) throw new Error(`Backup passphrase: ${problem}`);
  const backup = backupFile(env);
  if (existsSync(backup)) throw new Error(`${backup} already exists; it may be the only copy of a key. Move it somewhere safe first.`);
  if (generated && !savePassphrase(passphrase, { run })) throw new Error('could not keep the backup passphrase in the login keychain; nothing was made');
  const work = mkdtempSync(join(tmpdir(), 'km-release-'));
  try {
    const keyPath = join(work, 'release.key'), certPath = join(work, 'release.pem'), cnf = join(work, 'openssl.cnf');
    writeFileSync(cnf, certConfig(), { mode: 0o600 });
    const gen = run('openssl', ['req', '-x509', '-newkey', 'rsa:3072', '-sha256', '-days', String(RELEASE_CERT_DAYS), '-nodes', '-keyout', keyPath, '-out', certPath, '-config', cnf]);
    if (gen.status !== 0) throw new Error(`openssl could not make the certificate: ${gen.stderr.trim()}`);
    chmodSync(keyPath, 0o600);
    const facts = certFacts(certPath, run);
    if (!facts.sha1) throw new Error('openssl gave no fingerprint for the new certificate');
    // The backup first: a key that made it into the keychain but not into a backup is one disk failure from gone.
    mkdirSync(backupDir(env), { recursive: true, mode: 0o700 }); chmodSync(backupDir(env), 0o700);
    const bk = run('openssl', p12Args({ keyPath, certPath, out: backup, passEnv: 'KM_BACKUP_PASS', name: RELEASE_IDENTITY_NAME }), { env: { KM_BACKUP_PASS: passphrase } });
    if (bk.status !== 0 || !existsSync(backup)) throw new Error(`the encrypted backup could not be written: ${bk.stderr.trim()}`);
    chmodSync(backup, 0o600);
    // From here the backup exists, so a failure must not strand it: its public facts go beside it first, and `restore`
    // finishes the job from them (imports the key, then writes the pin) instead of refusing an unpinned backup.
    writeFileSync(pendingPinFile(env), `${JSON.stringify(pinRecord(facts, now), null, 2)}\n`, { mode: 0o600 });
    let partitionOk;
    try {
      ({ partitionOk } = importIntoKeychain({ keyPath, certPath, name: RELEASE_IDENTITY_NAME, work, run, keychainPassword }));
      if (!keychainHas(facts.sha1, { run })) throw new Error('the identity was imported but the keychain does not list it as a code-signing identity');
    } catch (e) {
      throw new Error(`${e.message}. The encrypted backup ${backup} is kept: run restore to finish (it imports that key and pins it).`);
    }
    writeFileSync(pinFile, `${JSON.stringify(pinRecord(facts, now), null, 2)}\n`);
    rmSync(pendingPinFile(env), { force: true });
    return { ...facts, backup, partitionOk, passphraseInKeychain: generated };
  } finally { rmSync(work, { recursive: true, force: true }); }   // the unencrypted key never outlives this
}

/** A backup back into the keychain, only if it is the pinned certificate. → { sha1 } */
export function restoreIdentity(p12, { passphrase, run = realRun, pinFile = PIN_FILE, env = process.env, now = new Date(), keychainPassword = process.env.KINGMAKER_KEYCHAIN_PASSWORD || '' } = {}) {
  // Normally the pinned certificate; after a create cut off before pinning, the one recorded beside its backup.
  const pending = readPin(pinFile) ? null : readPendingPin(env);
  const pinned = readPin(pinFile) ?? pending;
  if (!pinned) throw new Error('Nothing is pinned yet: restore puts back the pinned certificate (create makes the first one).');
  if (!existsSync(p12)) throw new Error(`No backup at ${p12}.`);
  if (keychainHas(pinned.sha1, { run })) {
    if (pending) { writeFileSync(pinFile, `${JSON.stringify(pinRecord(pending, new Date(pending.createdAt || now)), null, 2)}\n`); rmSync(pendingPinFile(env), { force: true }); }
    return { sha1: pinned.sha1, already: true, ...(pending ? { pinnedNow: true } : {}) };
  }
  const work = mkdtempSync(join(tmpdir(), 'km-restore-'));
  try {
    const keyPath = join(work, 'release.key'), certPath = join(work, 'release.pem');
    const k = run('openssl', ['pkcs12', '-in', p12, '-nocerts', '-nodes', '-passin', 'env:KM_BACKUP_PASS', '-out', keyPath], { env: { KM_BACKUP_PASS: passphrase } });
    const c = run('openssl', ['pkcs12', '-in', p12, '-clcerts', '-nokeys', '-passin', 'env:KM_BACKUP_PASS', '-out', certPath], { env: { KM_BACKUP_PASS: passphrase } });
    if (k.status !== 0 || c.status !== 0) throw new Error('That passphrase does not open this backup.');
    chmodSync(keyPath, 0o600);
    const facts = certFacts(certPath, run);
    if (facts.sha1 !== pinned.sha1) throw new Error(`This backup holds ${facts.sha1}, not the pinned ${pinned.sha1}. Not restored.`);
    importIntoKeychain({ keyPath, certPath, name: RELEASE_IDENTITY_NAME, work, run, keychainPassword });
    if (!keychainHas(pinned.sha1, { run })) throw new Error('imported, but the keychain does not list it');
    if (pending) { writeFileSync(pinFile, `${JSON.stringify(pinRecord(facts, new Date(pending.createdAt || now)), null, 2)}\n`); rmSync(pendingPinFile(env), { force: true }); }
    return { sha1: pinned.sha1, ...(pending ? { pinnedNow: true } : {}) };
  } finally { rmSync(work, { recursive: true, force: true }); }
}

/** Pinned? In this keychain? Backed up in the vault (and only the owner can read it)? */
export function identityStatus({ run = realRun, env = process.env, pinFile = PIN_FILE, now = new Date() } = {}) {
  const pin = readPin(pinFile), backup = backupFile(env);
  let backupMode = null; try { backupMode = statSync(backup).mode & 0o777; } catch { /* none */ }
  const yearsLeft = pin?.notAfter ? +((Date.parse(pin.notAfter) - now.getTime()) / (365.25 * 86_400_000)).toFixed(1) : null;
  return { pinned: pin?.sha1 ?? null, inKeychain: pin ? keychainHas(pin.sha1, { run }) : false, backup: backupMode == null ? null : backup, backupPrivate: backupMode === 0o600, yearsLeft };
}

/** <file>.sig: a detached signature by the pinned identity (and verified against the pin before it's kept). */
export function signFile(file, { run = realRun, pinFile = PIN_FILE } = {}) {
  const pin = readPin(pinFile);
  if (!pin) throw new Error('No Kingmaker Release certificate is pinned.');
  const sig = `${file}.sig`; rmSync(sig, { force: true });
  const s = run('codesign', ['--force', '--sign', pin.sha1, '--detached', sig, file]);
  if (s.status !== 0) throw new Error(`codesign could not sign ${file}: ${s.stderr.trim()}`);
  const v = run('codesign', ['--verify', '--detached', sig, `-R=${fileRequirement(pin.sha1)}`, file]);
  if (v.status !== 0) { rmSync(sig, { force: true }); throw new Error(`the signature does not verify against the pin: ${v.stderr.trim()}`); }
  return sig;
}

async function ask(question, { hidden = true } = {}) {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) rl._writeToOutput = (s) => { if (/\n|\r/.test(s) || s === question) rl.output.write(s); };
  return new Promise((done) => rl.question(question, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); done(a); }));
}
async function passphraseFromOwner({ confirm }) {
  if (process.env.KINGMAKER_BACKUP_PASSPHRASE) return process.env.KINGMAKER_BACKUP_PASSPHRASE;
  const kept = readPassphrase();
  if (kept) return kept;
  if (!process.stdin.isTTY) throw new Error('Run this in a terminal (it asks for the backup passphrase), or set KINGMAKER_BACKUP_PASSPHRASE.');
  const a = await ask('Backup passphrase (12+ characters; keep it in your password manager, apart from the backup): ');
  if (!confirm) return a;
  const b = await ask('The same passphrase again: ');
  if (a !== b) throw new Error('The two passphrases differ.');
  return a;
}

async function main(argv = process.argv.slice(2)) {
  if (process.platform !== 'darwin') { say('The Kingmaker Release identity lives in a macOS keychain: run this on the release Mac.'); return 1; }
  const [cmd, arg] = argv;
  try {
    if (cmd === 'create') {
      const r = createIdentity({ passphrase: process.env.KINGMAKER_BACKUP_PASSPHRASE || null });
      say(`✓ Kingmaker Release certificate made: ${r.sha1} (valid until ${r.notAfter}).`);
      say(`✓ Encrypted backup: ${r.backup} (only you can read it).`);
      say('✓ Public fingerprint pinned in lib/release-identity.json: commit that file. It is the only part that ships.');
      if (r.passphraseInKeychain) say(`✓ Its passphrase is in your login keychain as "${PASS_SERVICE}" (restore finds it there).`);
      if (!r.partitionOk) say('· The first time a build is signed, macOS asks to use the key: click Always Allow.');
      say('ONE THING LEFT: copy that backup file to a USB stick, or into Apple Passwords as an attachment. With this Mac');
      say('gone, that copy (and the passphrase: Keychain Access → "Kingmaker Release backup" → Show password) is how releases continue.');
      return 0;
    }
    if (cmd === 'restore') {
      const r = restoreIdentity(resolve(arg || backupFile()), { passphrase: await passphraseFromOwner({ confirm: false }) });
      say(r.already ? `✓ ${r.sha1} is already in this keychain.` : `✓ Restored ${r.sha1} into the login keychain.`);
      if (r.pinnedNow) say('✓ The unfinished create is done: its public fingerprint is pinned in lib/release-identity.json. Commit that file.');
      return 0;
    }
    if (cmd === 'status') {
      const s = identityStatus();
      say(s.pinned ? `pinned        ${s.pinned} (${s.yearsLeft ?? '?'} years left)` : 'pinned        none yet (run create)');
      say(`in keychain   ${s.inKeychain ? 'yes' : 'NO: releases cannot be signed on this Mac (restore the backup)'}`);
      say(`vault backup  ${s.backup ? `${s.backup}${s.backupPrivate ? '' : ' — NOT 0600, fix: chmod 600'}` : 'none on this Mac'}`);
      return s.pinned && s.inKeychain ? 0 : 1;
    }
    if (cmd === 'selftest') {
      const dir = mkdtempSync(join(tmpdir(), 'km-selftest-')), f = join(dir, 'probe.txt');
      try { writeFileSync(f, `kingmaker ${Date.now()}\n`); signFile(f); say('✓ Signed a scratch file with Kingmaker Release and verified it against the pin.'); return 0; }
      finally { rmSync(dir, { recursive: true, force: true }); }
    }
    if (cmd === 'sign-file' && arg) { say(`✓ ${signFile(resolve(arg))}`); return 0; }
    say('usage: kingmaker-release-identity.mjs create | restore [<file.p12>] | status | selftest | sign-file <file>');
    return 2;
  } catch (error) { console.error(`✗ ${error.message}`); return 1; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then((c) => process.exit(c));
