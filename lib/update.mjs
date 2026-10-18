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
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileRequirement, readPin } from './release-identity.mjs';
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

/** What the host offers: {available, current, latest, tag} (no download). */
export async function checkForUpdate(config, { current = runningVersion(), fetchImpl = fetch } = {}) {
  const latest = await get(`${config.url}/latest.json`, config.key, fetchImpl);
  if (!latest || typeof latest.version !== 'string' || !/^v?[\w.-]+$/.test(String(latest.tag || ''))) throw new Error('The update host sent a bad latest.json.');
  return { available: compareVersions(latest.version, current) > 0, current, latest: latest.version, tag: latest.tag, engineSha256: latest.engineSha256, notes: spokenNotes(latest.notes) };
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
export async function applyUpdate(config, offer, { dataDir, wakeWord, fetchImpl = fetch, spawnImpl = spawn, home = homedir(), pin = readPin(), verifyImpl = verifyDetached, publicKeyPem = RELEASE_PUBLIC_KEY_PEM } = {}) {
  if (!wakeWord) throw new Error('No cemented wake word to keep.');
  const dir = join(home, 'Library', 'Caches', 'Kingmaker Installer', 'updates', offer.tag);
  mkdirSync(dir, { recursive: true });
  const base = `${config.url}/${offer.tag}`;
  // Authenticate the release BEFORE running any of it. The engine we download also does signature checks, but trust
  // can't come from the code we're about to execute — a compromised update host could swap the engine for one that
  // skips them. So this trusted, already-installed client verifies first, then hands the engine a verified manifest:
  //   1. Download the manifest and its detached signature; verify the signature against the key pinned in THIS build.
  //   2. Verify the downloaded engine against the engine sha256 inside that now-authenticated manifest (not the
  //      unsigned latest.json). A release that predates engine-pinning falls back to latest.json with a warning.
  //   3. Run the engine with --require-signed so it refuses an unsigned manifest too (defense in depth).
  const manifest = await get(`${base}/kingmaker-manifest.json`, config.key, fetchImpl, 'bytes');
  let sig = null;
  try { sig = await get(`${base}/kingmaker-manifest.json.sig`, config.key, fetchImpl, 'text'); } catch { sig = null; }
  if (!publicKeyPem) throw new Error('This Kingmaker has no pinned release key to authenticate an update; not updating.');
  if (!sig || !verifyManifestBytes(manifest, sig.trim(), publicKeyPem)) {
    throw new Error('The update manifest is not signed by Ronin Inc.; refusing to run this update.');
  }
  let parsed;
  try { parsed = JSON.parse(Buffer.from(manifest).toString('utf8')); } catch { throw new Error('The update manifest did not parse; not updating.'); }

  const engine = await get(`${base}/engine.sh`, config.key, fetchImpl, 'bytes');
  const sha = createHash('sha256').update(engine).digest('hex');
  const pinnedEngineSha = parsed.engine?.sha256 || null;
  if (pinnedEngineSha) {
    if (sha !== pinnedEngineSha) throw new Error('The update engine does not match the signed manifest; not running it.');
  } else {
    // Older release without a signed engine hash: fall back to the (unsigned) latest.json checksum, best we can do.
    if (!offer.engineSha256 || sha !== offer.engineSha256) throw new Error('The update installer does not match its checksum; not running it.');
  }
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
  writeFileSync(pubkeyPath, RELEASE_PUBLIC_KEY_PEM);
  const log = join(dataDir, 'logs', 'update.log');
  mkdirSync(join(dataDir, 'logs'), { recursive: true });
  const fd = openSync(log, 'a');
  try {
    const child = spawnImpl('/bin/bash', [join(dir, 'engine.sh'), '--wake-word', wakeWord, '--base-url', base, '--manifest', join(dir, 'kingmaker-manifest.json'), '--require-signed', '--release-pubkey', pubkeyPath], {
      detached: true, stdio: ['ignore', fd, fd],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '', KINGMAKER_UPDATE_KEY: config.key, KINGMAKER_EXPECT_LEAF: pin?.sha1 ?? '' },
    });
    child.unref();
  } finally { closeSync(fd); }
  return { started: true, log };
}

/** One lock per Mac so a launch and a wake landing together don't start two installs. */
export function takeUpdateLock(dataDir, { now = Date.now(), staleMs = 2 * 60 * 60 * 1000 } = {}) {
  const lock = join(dataDir, 'update.lock');
  try {
    if (existsSync(lock) && now - Number(readFileSync(lock, 'utf8')) < staleMs) return false;
    writeFileSync(lock, String(now));
    return true;
  } catch { return false; }
}
