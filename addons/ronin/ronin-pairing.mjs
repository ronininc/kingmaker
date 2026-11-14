// Pair this Mac with the Ronin CRM with no terminal (the CRM side is worker/kingmaker-pairing.ts in ronininc-crm).
//
// Kingmaker, holding no Ronin key, asks the CRM for a pairing (POST /api/kingmaker/pair/start) and shows the short
// code it gets back in a macOS dialog, opening Connections on the site. The owner types that code there and taps
// Approve; only the owner's own signed-in session can (never a bot key, the master included). Kingmaker polls with its
// device code, collects its keys once, saves each one in the login Keychain (written to /usr/bin/security on stdin,
// never on argv, never in a file, never in a log or a URL), turns the Ronin office on and docks: its desk heartbeat is
// its readiness on the floor.
//
// Nothing here can approve itself. A Mac pairs only when it is a Ronin install: the owner pressed "Pair this Mac"
// (kingmaker://pair) or ran `kingmaker pair`, the installer carried pair.json, the office was already on
// (ronin-desk.json) or the install is locked to Ronin (crm-lock.json). A Mac whose keys stop working (revoked on the
// site, a lost Mac, re-pair, or expiry) asks again by itself, and again only the owner's tap gives it anything.

import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { runSecurity } from './core.mjs';
import { DESK_ACCOUNTS } from './brain-desks.mjs';
import { TOKEN_ACCOUNT as DNC_ACCOUNT, TOKEN_SERVICE as DNC_SERVICE } from './core.mjs';

/** The Ronin CRM's do-not-call list (worker/dnc.ts, GET /api/dnc/snapshot) and its one-scope reader tokens. */
export const DNC_URL = 'https://www.ronininc.org/api/dnc/snapshot';
export const DNC_TOKEN_PREFIX = 'ronin_dnc_';
import { OWNER_CALL_KEYCHAIN_SERVICE, OWNER_CALL_TOKEN_ACCOUNT } from './owner-call.mjs';
import { activeCrmLock } from './crm-lock.mjs';
import { readRoninDeskConfig, setRoninDeskEnabled } from './ronin-desk-dock.mjs';

export const RONIN_CRM = 'https://www.ronininc.org';
/** Where the owner types the code. Kept in this private build, never returned by the CRM's public endpoint. */
export const PAIR_PAGE = `${RONIN_CRM}/admin/#connections`;
export const PAIRING_FILE = 'ronin-pairing.json';
const DESK_SERVICE = 'ronin-crm-prod';

/** Where each key the CRM may hand this Mac lives in the Keychain: the same slots the rest of Kingmaker reads. */
export const GRANT_SLOTS = Object.freeze({
  'desk:kingmaker': { service: DESK_SERVICE, account: DESK_ACCOUNTS.kingmaker, prefix: 'ronin_desk_', label: 'Ronin Kingmaker desk key' },
  'desk:muse': { service: DESK_SERVICE, account: DESK_ACCOUNTS.muse, prefix: 'ronin_desk_', label: 'Ronin Muse desk key' },
  'desk:claude': { service: DESK_SERVICE, account: DESK_ACCOUNTS.claude, prefix: 'ronin_desk_', label: 'Ronin Claude desk key' },
  'desk:codex': { service: DESK_SERVICE, account: DESK_ACCOUNTS.codex, prefix: 'ronin_desk_', label: 'Ronin Codex desk key' },
  'desk:grok-bot': { service: DESK_SERVICE, account: DESK_ACCOUNTS['grok-bot'], prefix: 'ronin_desk_', label: 'Ronin grok-bot desk key' },
  'dnc-reader': { service: DNC_SERVICE, account: DNC_ACCOUNT, prefix: DNC_TOKEN_PREFIX, label: 'Ronin do-not-call reader' },
  'owner-call-transport': { service: OWNER_CALL_KEYCHAIN_SERVICE, account: OWNER_CALL_TOKEN_ACCOUNT, prefix: 'ronin_ownercall_', label: 'Kingmaker owner call token' },
});

export class PairingEnded extends Error {
  constructor(status, message) { super(message); this.name = 'PairingEnded'; this.status = status; }
}

// ── state (state/ronin-pairing.json, 0600): nothing secret, only what this Mac asked for and was given ─────────────

export const pairingStatePath = (paths) => join(paths.state, PAIRING_FILE);

export function readPairingState(paths, read = (p) => readFileSync(p, 'utf8')) {
  try {
    const v = JSON.parse(read(pairingStatePath(paths)));
    if (v?.schema !== 1 || v.crm !== 'ronininc') return null;
    return {
      schema: 1, crm: 'ronininc',
      install_id: /^[0-9a-f]{32}$/.test(v.install_id) ? v.install_id : null,
      want: v.want === true,
      pairing_id: typeof v.pairing_id === 'string' && /^[A-Za-z0-9-]{8,80}$/.test(v.pairing_id) ? v.pairing_id : null,
      paired_at: typeof v.paired_at === 'string' ? v.paired_at : null,
      grants: Array.isArray(v.grants) ? v.grants.filter((g) => Object.hasOwn(GRANT_SLOTS, g)) : [],
      needs_repair: v.needs_repair === true,
      declined: v.declined === true,
    };
  } catch { return null; }
}

export function writePairingState(paths, patch) {
  const next = { ...(readPairingState(paths) ?? { schema: 1, crm: 'ronininc', install_id: null, want: false, pairing_id: null, paired_at: null, grants: [], needs_repair: false, declined: false }), ...patch, schema: 1, crm: 'ronininc' };
  mkdirSync(paths.state, { recursive: true, mode: 0o700 });
  const file = pairingStatePath(paths);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
  return readPairingState(paths);
}

/** This install's own random id (not a hardware id, not a secret). The CRM binds the desks it hands out to it. */
export function ensureInstallId(paths, random = randomBytes) {
  const state = readPairingState(paths);
  if (state?.install_id) return state.install_id;
  return writePairingState(paths, { install_id: random(16).toString('hex') }).install_id;
}

/** The owner asked for this Mac to be a Ronin Mac (the site's link, `kingmaker pair`, or the installer). */
export const markPairingWanted = (paths) => writePairingState(paths, { want: true, declined: false });

// ── Keychain ─────────────────────────────────────────────────────────────────────────────────────────────────────

const kcQuote = (s) => `"${String(s).replace(/["\\\n\r]/g, '')}"`;

export function keychainHas(slot, run = runSecurity) {
  const r = run(['find-generic-password', '-s', slot.service, '-a', slot.account]);
  return r.status === 0;
}

/** Every key the state says this Mac was given is still in the Keychain. */
export function pairedKeysPresent(state, run = runSecurity) {
  return Boolean(state?.grants?.length) && state.grants.every((g) => keychainHas(GRANT_SLOTS[g], run));
}

/** Check the whole hand-over before writing anything: right CRM, right Mac, only known keys, each with its prefix. */
export function validateHandover(result, installId) {
  if (result?.status !== 'approved' || result.crm !== 'ronininc') throw new PairingEnded('invalid', 'The CRM did not return a Ronin pairing.');
  if (result.install_id !== installId) throw new PairingEnded('invalid', 'The CRM returned keys for a different Mac; nothing was saved.');
  if (typeof result.pairing_id !== 'string' || !/^[A-Za-z0-9-]{8,80}$/.test(result.pairing_id)) throw new PairingEnded('invalid', 'The CRM returned no pairing id.');
  const creds = Array.isArray(result.credentials) ? result.credentials : [];
  const keep = [];
  for (const c of creds) {
    const slot = GRANT_SLOTS[c?.grant];
    if (!slot) continue; // a key this build has no place for is never written anywhere
    if (!new RegExp(`^${slot.prefix}[0-9a-f]{64}$`).test(String(c.token || ''))) throw new PairingEnded('invalid', `The ${c.grant} key is not the expected shape; nothing was saved.`);
    keep.push({ grant: c.grant, token: c.token, expires_at: Number(c.expires_at) || null });
  }
  if (!keep.length) throw new PairingEnded('invalid', 'The approval carried no key this Mac can use.');
  return { pairingId: result.pairing_id, credentials: keep };
}

/** Each key to its own Keychain slot, written to security(1) on stdin. -U replaces an older key in the same slot. */
export function storeCredentials(credentials, run = runSecurity) {
  for (const { grant, token } of credentials) {
    const slot = GRANT_SLOTS[grant];
    const r = run(['-i'], `add-generic-password -U -s ${kcQuote(slot.service)} -a ${kcQuote(slot.account)} -l ${kcQuote(slot.label)} -w ${kcQuote(token)}\n`);
    if (r.status !== 0) throw new Error(`Could not save the ${grant} key in the Keychain (is it locked?).`);
  }
  return credentials.map((c) => c.grant);
}

/** Save one desk key the owner copied by hand (the old `kingmaker office ronin key` path), through the same stdin
 *  write, so a key never reaches argv. */
export function storeDeskKey(slug, token, run = runSecurity) {
  const grant = `desk:${slug}`;
  if (!GRANT_SLOTS[grant]) throw new Error(`No desk ${slug}.`);
  return storeCredentials([{ grant, token }], run);
}

// ── the CRM conversation ─────────────────────────────────────────────────────────────────────────────────────────

async function post(fetchImpl, crm, path, body) {
  const res = await fetchImpl(`${crm}${path}`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* not json */ }
  return { status: res.status, json };
}

export async function startPairing({ installId, deviceName, version, crm = RONIN_CRM, fetchImpl = fetch }) {
  const { status, json } = await post(fetchImpl, crm, '/api/kingmaker/pair/start', { install_id: installId, device_name: deviceName, platform: `${process.platform}-${process.arch}`, app_version: version });
  if (status === 429) throw new PairingEnded('busy', 'Too many pairing requests are waiting on the CRM. Kingmaker asks again in a few minutes.');
  if (status !== 200 || !/^ronin_pairdev_[0-9a-f]{64}$/.test(json?.device_code || '') || !json?.user_code) throw new PairingEnded('unavailable', `The CRM did not start a pairing (HTTP ${status}).`);
  return { deviceCode: json.device_code, userCode: json.user_code, interval: Math.max(5, Number(json.interval) || 5), expiresIn: Math.max(60, Number(json.expires_in) || 600) };
}

const sleepFor = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted) return resolve();
  const timer = setTimeout(done, ms);
  function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }
  signal?.addEventListener('abort', done, { once: true });
});

/** Poll until the owner taps (RFC 8628 pending / slow_down), the code ends, or `signal` aborts. → the approved body. */
export async function waitForApproval({ deviceCode, interval = 5, expiresIn = 600, crm = RONIN_CRM, fetchImpl = fetch, sleep = sleepFor, now = Date.now, signal } = {}) {
  const deadline = now() + expiresIn * 1000;
  let gap = interval;
  while (!signal?.aborted && now() < deadline) {
    await sleep(gap * 1000, signal);
    if (signal?.aborted) break;
    let r;
    try { r = await post(fetchImpl, crm, '/api/kingmaker/pair/poll', { device_code: deviceCode }); }
    catch { continue; } // a network blip: the code is still good until its deadline
    const status = r.json?.status;
    if (status === 'approved') return r.json;
    if (status === 'pending') continue;
    if (status === 'slow_down') { gap = Math.max(gap + 5, Number(r.json?.interval) || 0); continue; }
    if (status === 'denied') throw new PairingEnded('denied', 'The owner declined this pairing on the site.');
    if (status === 'expired') throw new PairingEnded('expired', 'The pairing code expired before it was approved.');
    if (status === 'used') throw new PairingEnded('used', 'That pairing code was already used.');
    if (r.status >= 500) continue;
    throw new PairingEnded('invalid', `The CRM refused the pairing (HTTP ${r.status}).`);
  }
  throw new PairingEnded(signal?.aborted ? 'stopped' : 'expired', signal?.aborted ? 'Pairing stopped.' : 'The pairing code expired before it was approved.');
}

// ── on the Mac's screen (no terminal): a dialog with the code, and Connections opened in the browser ──────────────

export function computerName(run = execFileSync) {
  try {
    const name = run('/usr/sbin/scutil', ['--get', 'ComputerName'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const clean = String(name).replace(/[^\p{L}\p{N} ._'-]/gu, '').trim().slice(0, 60);
    if (clean) return clean;
  } catch { /* not macOS */ }
  return hostname().replace(/\.local$/, '').slice(0, 60) || 'Mac';
}

/** The AppleScript for the code dialog. The script goes to osascript on stdin, so the code is never on argv. */
export function codeDialogScript(userCode, expiresIn) {
  const code = String(userCode).replace(/[^A-Z-]/g, '');
  const minutes = Math.max(1, Math.round(expiresIn / 60));
  return `display dialog "Pair this Mac with Ronin CRM\\n\\nOn the site, open Connections → Pair a Mac and type:\\n\\n        ${code}\\n\\nThen tap Approve. Kingmaker saves its keys and docks by itself; nothing is typed in a terminal. The code works for ${minutes} minutes." with title "Kingmaker" buttons {"OK"} default button "OK" giving up after ${Math.max(30, expiresIn)}\n`;
}

export function showCodeOnMac({ userCode, expiresIn, openPage = true, spawnImpl = spawn } = {}) {
  try {
    const dialog = spawnImpl('/usr/bin/osascript', ['-'], { stdio: ['pipe', 'ignore', 'ignore'], detached: true });
    dialog.stdin.end(codeDialogScript(userCode, expiresIn));
    dialog.unref?.();
  } catch { /* no GUI session: the CLI and the log line still say where to go */ }
  if (openPage) {
    try { spawnImpl('/usr/bin/open', [PAIR_PAGE], { stdio: 'ignore', detached: true }).unref?.(); } catch { /* no browser */ }
  }
}

// ── when to pair, and the whole flow ─────────────────────────────────────────────────────────────────────────────

/** Why this Mac should pair now, or null. A Mac is a Ronin Mac only when something above says so. */
export function pairingReason(paths, { run = runSecurity } = {}) {
  const state = readPairingState(paths);
  const roninMac = state?.want || readRoninDeskConfig(paths).enabled || activeCrmLock(paths)?.tenant === 'ronininc';
  // The owner tapped Deny on the site: this Mac stays quiet until someone asks again (the site's link, `kingmaker pair`).
  if (!roninMac || state?.declined) return null;
  if (state?.needs_repair) return 'its Ronin keys stopped working';
  if (state?.pairing_id) return pairedKeysPresent(state, run) ? null : 'a paired key is missing from the Keychain';
  // A Ronin install from before pairing existed, with its desk key already saved by hand: leave it alone.
  if (keychainHas(GRANT_SLOTS['desk:kingmaker'], run)) return null;
  return state?.want ? 'the owner asked to pair this Mac' : 'this Ronin install has no Ronin key yet';
}

let inFlight = null;

/**
 * Pair once: ask, show the code, wait for the owner's tap, save, activate. Single-flight: a second call while one is
 * running joins it. ui.code({userCode, expiresIn}) shows the code; log() never sees a key or a code.
 */
export function pairWithRonin(opts) {
  if (!inFlight) inFlight = runPairing(opts).finally(() => { inFlight = null; });
  return inFlight;
}

export async function runPairing({ paths, version = '', fetchImpl = fetch, run = runSecurity, ui = {}, log = () => {}, signal, sleep, now, deviceName, enableOffice = setRoninDeskEnabled, crm = RONIN_CRM } = {}) {
  const installId = ensureInstallId(paths);
  const name = deviceName ?? computerName();
  const started = await startPairing({ installId, deviceName: name, version, crm, fetchImpl });
  log(`Ronin pairing started for ${name}; waiting for the owner to approve it on the site (Connections → Pair a Mac).`);
  (ui.code ?? showCodeOnMac)({ userCode: started.userCode, expiresIn: started.expiresIn });
  let approved;
  try { approved = await waitForApproval({ deviceCode: started.deviceCode, interval: started.interval, expiresIn: started.expiresIn, crm, fetchImpl, sleep, now, signal }); }
  catch (error) {
    if (error instanceof PairingEnded && error.status === 'denied') writePairingState(paths, { want: false, needs_repair: false, declined: true });
    throw error;
  }
  const { pairingId, credentials } = validateHandover(approved, installId);
  const saved = storeCredentials(credentials, run);
  // The keys are in the Keychain; the variables holding them go out of scope here and are never logged or written.
  const state = writePairingState(paths, { want: true, pairing_id: pairingId, paired_at: new Date().toISOString(), grants: saved, needs_repair: false, declined: false });
  if (saved.includes('desk:kingmaker')) enableOffice(paths, true);
  log(`Ronin pairing approved: saved ${saved.length} key${saved.length === 1 ? '' : 's'} (${saved.join(', ')}) in the Keychain; no key was printed.`);
  ui.done?.({ grants: saved, pairingId });
  return { ok: true, pairingId, grants: saved, state };
}

/** The env a desk dock needs so its heartbeat carries the pairing the CRM bound that desk to. {} for a desk this
 *  pairing did not hand out (a key saved by hand keeps its old identity). */
export function pairingDockEnv(paths, slug, read) {
  const state = readPairingState(paths, read);
  if (!state?.pairing_id || !state.install_id || !state.grants.includes(`desk:${slug}`)) return {};
  return { RONIN_PAIRING_ID: state.pairing_id, RONIN_DEVICE_ID: state.install_id };
}

/** A dock was told 401: its key was revoked (site, lost Mac, re-pair) or expired. Remember it and ask again. */
export function markNeedsRepair(paths) {
  return writePairingState(paths, { needs_repair: true });
}
