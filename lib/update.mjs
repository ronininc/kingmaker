// Auto-update (operator 2026-10-08: "auto apply updates to the kingmaker … when I publish them").
//
// The operator publishes a release folder to the update host (scripts/publish-update.sh: a private R2 bucket behind
// a Worker that answers only to the update key). Kingmaker checks when it starts and when the Mac wakes (the menu bar
// agent runs `kingmaker update --auto` on both events; nothing polls on a timer). A newer version is installed by the
// release's own installer engine, the same one a fresh install runs: every part checked against its sha256, staged,
// moved into place journaled (a failure puts everything back), the running Kingmaker asked to quit, the new one opened.
// The wake word stays cemented. The engine runs detached, so quitting Kingmaker does not stop it.
//
//   update.json (Kingmaker's data folder, 0600): {"url": "https://…", "key": "…"}; written by the installer when it
//   was given KINGMAKER_UPDATE_URL / KINGMAKER_UPDATE_KEY, or by `kingmaker update --setup`.
//   <url>/latest.json: {"version": "0.2.1", "tag": "v0.2.1", "engineSha256": "…", "notes": "what changed, spoken"}
//   <url>/<tag>/: the release parts, kingmaker-manifest.json and engine.sh
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPayload } from './payload.mjs';
import { pidAlive } from './paths.mjs';
import { appRequirement, fileRequirement, readPin } from './release-identity.mjs';
import { verifyManifestBytes } from './release-signing.mjs';
import { RELEASE_PUBLIC_KEY_PEM } from './release-pubkey.mjs';

export const UPDATE_FILE = 'update.json';

/** The running Kingmaker's version (its own package.json, beside lib/). */
export function runningVersion() {
  try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || '0.0.0'; } catch { return '0.0.0'; }
}

/** -1, 0 or 1. Plain dotted numbers ("0.2.10" > "0.2.9"); anything else counts as 0. Pure. */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** {url, key} or null: the environment first (KINGMAKER_UPDATE_URL / _KEY), then update.json. */
export function readUpdateConfig(dataDir, env = process.env) {
  if (env.KINGMAKER_UPDATE_URL && env.KINGMAKER_UPDATE_KEY) return { url: env.KINGMAKER_UPDATE_URL.replace(/\/+$/, ''), key: env.KINGMAKER_UPDATE_KEY };
  try {
    const j = JSON.parse(readFileSync(join(dataDir, UPDATE_FILE), 'utf8'));
    if (typeof j.url === 'string' && /^https:\/\//.test(j.url) && typeof j.key === 'string' && j.key) return { url: j.url.replace(/\/+$/, ''), key: j.key };
  } catch { /* none */ }
  return null;
}

export function writeUpdateConfig(dataDir, { url, key }) {
  if (!/^https:\/\//.test(String(url))) throw new Error('The update host must be an https:// URL.');
  if (!key) throw new Error('No update key.');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, UPDATE_FILE), JSON.stringify({ schema: 'kingmaker.update/1', url: url.replace(/\/+$/, ''), key }, null, 2) + '\n', { mode: 0o600 });
}

async function get(url, key, fetchImpl, as = 'json') {
  const r = await fetchImpl(url, { headers: { Authorization: `Bearer ${key}`, 'X-Kingmaker-Version': runningVersion() }, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`${r.status} from the update host`);
  if (as === 'json') return r.json();
  if (as === 'text') return r.text();
  return Buffer.from(await r.arrayBuffer());
}

/**
 * Release notes as Kingmaker says them: what changes for the person, at most two sentences and 240 characters
 * (operator 2026-10-08: "described as an outcome, I don't wanna hear a whole damn codebase read to me"). Pure.
 */
export function spokenNotes(notes) {
  const text = String(notes ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const two = (text.match(/[^.!?]+[.!?]+/g) ?? [text]).slice(0, 2).map((x) => x.trim()).join(' ');
  return two.length <= 240 ? two : `${two.slice(0, two.lastIndexOf(' ', 237))}…`;
}

export const PROVENANCE_FILE = 'installed-release.json';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const APP_ROOT = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const BOUND_FILES = ['Contents/MacOS/Kingmaker', 'Contents/MacOS/KingmakerEngine', 'Contents/Resources/sol-ghost/payload.json', 'Contents/Info.plist', 'Contents/_CodeSignature/CodeResources'];

function authenticatedManifest(bytes, signature, publicKeyPem) {
  if (!publicKeyPem || !signature || !verifyManifestBytes(bytes, signature.trim(), publicKeyPem)) throw new Error('Update unconfirmed: release manifest signature is invalid.');
  let m;
  try { m = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { throw new Error('Update unconfirmed: signed manifest did not parse.'); }
  if (m.schema !== 'kingmaker.release/1' || m.product !== 'Kingmaker' || m.app?.bundleId !== 'com.ronininc.solghost' ||
      !/^\d+\.\d+\.\d+$/.test(m.version) || m.app?.version !== m.version || !/^v?[\w.-]+$/.test(m.tag ?? '') ||
      !/^[a-f0-9]{64}$/.test(m.app?.sha256 ?? '') || !/^[a-f0-9]{64}$/.test(m.engine?.sha256 ?? '')) throw new Error('Update unconfirmed: signed release identity is incomplete.');
  return { ...m, manifestSha256: digest(bytes) };
}

export function verifyInstalledBundle(appRoot, pin = readPin(), run = spawnSync) {
  if (!pin) return false;
  return run('/usr/bin/codesign', ['--verify', '--deep', '--strict', `-R=${appRequirement(pin.sha1)}`, appRoot], { encoding: 'utf8' }).status === 0;
}
function installedSnapshot(dataDir, appRoot) {
  return { appRoot, receipt: digest(readFileSync(join(dataDir, PROVENANCE_FILE))), files: BOUND_FILES.map(f => digest(readFileSync(join(appRoot, f)))) };
}

/** Receipt is written by the verified install transaction, never by checking/downloading an offer. */
export function installedRelease({ dataDir = join(homedir(), 'Library/Application Support/sol-ghost'), appRoot = APP_ROOT, publicKeyPem = RELEASE_PUBLIC_KEY_PEM, verifyInstalledImpl = verifyInstalledBundle } = {}) {
  try {
    if (!verifyInstalledImpl(appRoot)) return null;
    const receipt = JSON.parse(readFileSync(join(dataDir, PROVENANCE_FILE), 'utf8'));
    if (receipt.schema !== 'kingmaker.installed-release/1' || !BOUND_FILES.every((f) => receipt.files?.[f] === digest(readFileSync(join(appRoot, f))))) return null;
    if (!checkPayload(join(appRoot, 'Contents/Resources/sol-ghost'), { deep: true, installed: true }).ok) return null;
    return authenticatedManifest(Buffer.from(receipt.manifest, 'base64'), receipt.signature, publicKeyPem);
  } catch { return null; }
}

/** Signed createdAt orders revisions only within one version; equal/invalid timestamps never authorize replacement. */
export function releaseDecision(candidate, installed, current) {
  if (compareVersions(candidate.version, current) < 0) return { available: false, reason: 'rollback' };
  if (!installed || installed.version !== current) return { available: false, reason: 'unknown-provenance' };
  if (compareVersions(candidate.version, current) > 0) return { available: true, reason: 'version-upgrade' };
  if (candidate.app.sha256 === installed.app.sha256) return { available: false, reason: 'identical' };
  const a = Date.parse(candidate.createdAt), b = Date.parse(installed.createdAt);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) return { available: false, reason: 'unordered-revision' };
  return a > b ? { available: true, reason: 'signed-revision' } : { available: false, reason: 'rollback' };
}

export async function checkForUpdate(config, { current = runningVersion(), fetchImpl = fetch, publicKeyPem = RELEASE_PUBLIC_KEY_PEM, dataDir, appRoot, verifyInstalledImpl = verifyInstalledBundle } = {}) {
  const latest = await get(`${config.url}/latest.json`, config.key, fetchImpl);
  if (!latest || typeof latest.version !== 'string' || !/^v?[\w.-]+$/.test(String(latest.tag || ''))) throw new Error('The update host sent a bad latest.json.');
  const base = `${config.url}/${latest.tag}`;
  const bytes = await get(`${base}/kingmaker-manifest.json`, config.key, fetchImpl, 'bytes');
  const signature = await get(`${base}/kingmaker-manifest.json.sig`, config.key, fetchImpl, 'text');
  const candidate = authenticatedManifest(bytes, signature, publicKeyPem);
  if (candidate.tag !== latest.tag || candidate.version !== latest.version) throw new Error('Update unconfirmed: release pointer disagrees with signed manifest.');
  return { ...releaseDecision(candidate, installedRelease({ dataDir, appRoot, publicKeyPem, verifyInstalledImpl }), current), current, latest: candidate.version,
    tag: candidate.tag, manifestSha256: candidate.manifestSha256, engineSha256: candidate.engine.sha256, notes: spokenNotes(candidate.notes) };
}

/** Is `file` signed (detached, `sig`) by exactly the pinned certificate? macOS's own codesign decides. */
export function verifyDetached(file, sig, sha1, run = spawnSync) {
  const r = run('/usr/bin/codesign', ['--verify', '--detached', sig, `-R=${fileRequirement(sha1)}`, file], { encoding: 'utf8' });
  return (r.status ?? 1) === 0;
}

/**
 * Download the release's engine + manifest, check the engine against latest.json's sha256, and start it detached.
 * With a Kingmaker Release certificate pinned in THIS Kingmaker (lib/release-identity.mjs), the engine must also carry
 * that certificate's signature (engine.sh.sig): latest.json and the engine come from the same host, so a checksum alone
 * proves nothing if the host is taken. The pin rides into the engine, which installs only an app signed by it.
 * Returns {started, log}. The engine itself quits this Kingmaker and opens the new one.
 */
export async function applyUpdate(config, offer, { dataDir, wakeWord, fetchImpl = fetch, spawnImpl = spawn, home = homedir(), appRoot = APP_ROOT, verifyInstalledImpl = verifyInstalledBundle, current = runningVersion(), pin = readPin(), verifyImpl = verifyDetached, publicKeyPem = RELEASE_PUBLIC_KEY_PEM } = {}) {
  if (!wakeWord) throw new Error('No cemented wake word to keep.');
  const dir = join(home, 'Library', 'Caches', 'Kingmaker Installer', 'updates', offer.tag);
  mkdirSync(dir, { recursive: true });
  const base = `${config.url}/${offer.tag}`;
  // Authenticate the release BEFORE running any of it. The engine we download also does signature checks, but trust
  // can't come from the code we're about to execute — a compromised update host could swap the engine for one that
  // skips them. So this trusted, already-installed client verifies first, then hands the engine a verified manifest:
  //   1. Download the manifest and its detached signature; verify the signature against the key pinned in THIS build.
  //   2. Verify the downloaded engine against the engine sha256 inside that now-authenticated manifest (not the
  //      unsigned latest.json). Missing signed identity or engine hash fails closed.
  //   3. Run the engine with --require-signed so it refuses an unsigned manifest too (defense in depth).
  const manifest = await get(`${base}/kingmaker-manifest.json`, config.key, fetchImpl, 'bytes');
  let sig = null;
  try { sig = await get(`${base}/kingmaker-manifest.json.sig`, config.key, fetchImpl, 'text'); } catch { sig = null; }
  if (!publicKeyPem) throw new Error('This Kingmaker has no pinned release key to authenticate an update; not updating.');
  if (!sig || !verifyManifestBytes(manifest, sig.trim(), publicKeyPem)) {
    throw new Error('The update manifest is not signed by Ronin Inc.; refusing to run this update.');
  }
  const candidate = authenticatedManifest(manifest, sig, publicKeyPem);
  if (candidate.tag !== offer.tag || !offer.manifestSha256 || candidate.manifestSha256 !== offer.manifestSha256) throw new Error('Update unconfirmed: release changed after checking.');
  const approved = installedSnapshot(dataDir, appRoot);
  const decision = releaseDecision(candidate, installedRelease({ dataDir, appRoot, publicKeyPem, verifyInstalledImpl }), current);
  if (!decision.available) throw new Error(`Update unconfirmed: ${decision.reason}.`);
  if (JSON.stringify(installedSnapshot(dataDir, appRoot)) !== JSON.stringify(approved)) throw new Error('Update unconfirmed: installed app changed during validation.');

  const engine = await get(`${base}/engine.sh`, config.key, fetchImpl, 'bytes');
  const sha = createHash('sha256').update(engine).digest('hex');
  if (sha !== candidate.engine.sha256) throw new Error('The update engine does not match the signed manifest; not running it.');
  writeFileSync(join(dir, 'engine.sh'), engine, { mode: 0o700 });
  writeFileSync(join(dir, 'kingmaker-manifest.json'), manifest);
  writeFileSync(join(dir, 'kingmaker-manifest.json.sig'), sig);
  // And, with a Kingmaker Release certificate pinned, the engine itself must carry that certificate's signature.
  if (pin) {
    const unsigned = 'The update installer is not signed by the Kingmaker Release certificate; not running it.';
    const engineSig = await get(`${base}/engine.sh.sig`, config.key, fetchImpl, 'bytes').catch(() => null);
    if (!engineSig) throw new Error(unsigned);
    writeFileSync(join(dir, 'engine.sh.sig'), engineSig);
    if (!verifyImpl(join(dir, 'engine.sh'), join(dir, 'engine.sh.sig'), pin.sha1)) throw new Error(unsigned);
  }
  // Drop THIS build's pinned public key beside the downloaded engine, so engine.sh's own --require-signed check uses
  // the key baked into the already-trusted app — not one that could ride along with a swapped download. (The app
  // bundle may be replaced mid-update, so we copy the key out rather than point at a path inside the bundle.)
  const pubkeyPath = join(dir, 'kingmaker-release-public.pem');
  writeFileSync(pubkeyPath, publicKeyPem);
  if (!installedRelease({ dataDir, appRoot, publicKeyPem, verifyInstalledImpl }) || JSON.stringify(installedSnapshot(dataDir, appRoot)) !== JSON.stringify(approved)) throw new Error('Update unconfirmed: installed app or receipt changed during download.');
  const log = join(dataDir, 'logs', 'update.log');
  mkdirSync(join(dataDir, 'logs'), { recursive: true });
  const fd = openSync(log, 'a');
  try {
    const child = spawnImpl('/bin/bash', [join(dir, 'engine.sh'), '--wake-word', wakeWord, '--base-url', base, '--manifest', join(dir, 'kingmaker-manifest.json'), '--require-signed', '--release-pubkey', pubkeyPath, '--guard-installed-update'], {
      detached: true, stdio: ['ignore', fd, fd],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '', KINGMAKER_UPDATE_KEY: config.key, KINGMAKER_EXPECT_LEAF: pin?.sha1 ?? '', KINGMAKER_UPDATE_EXPECTED_APP: approved.appRoot, KINGMAKER_UPDATE_EXPECTED_RECEIPT: approved.receipt, KINGMAKER_UPDATE_EXPECTED_FILES: approved.files.join(' ') },
    });
    child.unref();
    // From here the installer owns the update lock: it removes it when it ends (installer/engine.sh, on exit), and if
    // it is killed outright, its pid is gone and the next update does not wait (takeUpdateLock).
    if (child.pid) handUpdateLock(dataDir, child.pid);
  } finally { closeSync(fd); }
  return { started: true, log };
}

/**
 * One lock per Mac so a launch and a wake landing together don't start two installs. The lock names its owner
 * ({ at, pid }: the process that took it, then the installer it started). It blocks only while that owner is alive and
 * the lock is under `staleMs` old, so a finished or killed update never holds up the next one. An older lock (a bare
 * timestamp, no pid) is judged by its age, as before.
 */
export function takeUpdateLock(dataDir, { now = Date.now(), staleMs = 2 * 60 * 60 * 1000, alive = pidAlive, pid = process.pid } = {}) {
  const lock = join(dataDir, 'update.lock');
  try {
    if (existsSync(lock)) {
      const held = readUpdateLock(lock);
      const fresh = now - held.at < staleMs;
      if (fresh && (held.pid ? alive(held.pid) : true)) return false;
    }
    writeFileSync(lock, JSON.stringify({ at: now, pid }));
    return true;
  } catch { return false; }
}
/** The started installer now holds the lock (its pid), so the lock lasts exactly as long as the install. */
export function handUpdateLock(dataDir, pid, { now = Date.now() } = {}) {
  try { writeFileSync(join(dataDir, 'update.lock'), JSON.stringify({ at: now, pid })); } catch { /* the age rule still frees it */ }
}
/** Give the lock back (an update that didn't start). Never throws. */
export function releaseUpdateLock(dataDir) {
  try { unlinkSync(join(dataDir, 'update.lock')); } catch { /* already gone */ }
}
function readUpdateLock(file) {
  const text = readFileSync(file, 'utf8').trim();
  try { const j = JSON.parse(text); if (j && typeof j === 'object') return { at: Number(j.at) || 0, pid: Number(j.pid) || 0 }; } catch { /* a bare timestamp */ }
  return { at: Number(text) || 0, pid: 0 };
}
