// lib/addons.mjs — Kingmaker's generic paid-add-on loader (ronin.addon/1). Free Kingmaker ships this hook and NO add-on
// code; a paid add-on (first: meeting notes, the meeting participant) loads only when this Mac holds a valid entitlement.
//
// Kingmaker places and loads add-on files — never the launcher. The launcher fetches, checks, and hands a staged dir to
// `kingmaker addons install`; Kingmaker re-checks EVERYTHING (so the launcher is never the only gate), places the files
// atomically outside Kingmaker.app at <root>/<id>/<version>/, and at startup loadAddons() re-checks and calls the entry
// module's register(host). Any failed check → not loaded, one line in the log. Contract: ronin-launcher docs/addons.md.
//
// This module owns the orchestration, the file-hash + requires + path-safety checks, the atomic placement, and the host
// API. The two CRYPTOGRAPHIC gates — the manifest's RSA-PSS Release-key signature and the ES256 entitlement — are
// verified by functions the engine injects with its pinned public keys (the same keys genuine.rs / the install cert
// pin; they are not in this module). When a verifier is missing, the gate FAILS CLOSED: a paid add-on will not install
// or load. Nothing here invents or bypasses a signature check.

import { createHash, createPublicKey, verify as cryptoVerify, constants as cryptoConstants } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, rmSync, renameSync, readdirSync, existsSync, cpSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

export const ADDON_SCHEMA = 'ronin.addon/1';
export const HOST_API_VERSION = 1;
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const ID_RE = /^[a-z0-9][a-z0-9-]{0,38}$/;
const VER_RE = /^\d{1,4}\.\d{1,4}\.\d{1,5}$/;
// A file path inside an add-on: letters, digits, . _ - and /, no "..", no leading slash, no backslash.
const SAFE_PATH = (p) => typeof p === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(p) && !p.split('/').includes('..') && !p.endsWith('/');
// Names Kingmaker writes in the install dir — an add-on file may not be any of them, or it would clobber (or spoof) the
// signed manifest, its signature, the entitlement, or current.json. The launcher refuses these too.
const RESERVED = new Set(['manifest.json', 'manifest.json.sig', 'entitlement.json', 'current.json']);
const noop = () => {};

/* ---------------- manifest + checks (real) ---------------- */

/** Why a manifest isn't a valid ronin.addon/1, or [] when it is. Pure. */
export function manifestProblems(m) {
  const out = [];
  if (!m || m.schema !== ADDON_SCHEMA) return ['not a ' + ADDON_SCHEMA + ' manifest'];
  if (!ID_RE.test(m.id || '')) out.push('bad id');
  if (!VER_RE.test(m.version || '')) out.push('bad version');
  if (typeof m.paid !== 'boolean') out.push('paid must be a boolean');
  if (m.paid && !m.sku) out.push('a paid add-on needs an sku');
  if (!Array.isArray(m.files) || !m.files.length) out.push('no files');
  for (const f of m.files || []) if (!SAFE_PATH(f?.path) || RESERVED.has(f?.path) || !/^[a-f0-9]{64}$/.test(f?.sha256 || '') || !Number.isInteger(f?.size)) out.push(`bad file entry ${f?.path}`);
  if (!m.archive || !/^[a-f0-9]{64}$/.test(m.archive.sha256 || '')) out.push('bad archive hash');
  if (!m.entry || !SAFE_PATH(m.entry.module) || m.entry.export !== 'register') out.push('entry must be { module, export: "register" }');
  if (m.entry && !(m.files || []).some((f) => f.path === m.entry.module)) out.push('entry.module is not one of the files');
  return out;
}

/** Every file present in `dir` with the exact size and SHA-256 the manifest states. Returns null, or the first mismatch. */
export function checkFiles(dir, m) {
  for (const f of m.files) {
    let buf; try { buf = readFileSync(join(dir, f.path)); } catch { return `missing file ${f.path}`; }
    if (buf.length !== f.size) return `size mismatch ${f.path}`;
    if (sha256(buf) !== f.sha256) return `hash mismatch ${f.path}`;
  }
  return null;
}

const verParts = (v) => String(v || '').split('.').map((n) => Number(n) || 0);
/** True when installed version `have` satisfies a ">=x.y.z" requirement (the only form used). */
export function satisfies(have, req) {
  const m = /^>=\s*(\d+\.\d+\.\d+)/.exec(String(req || '')); if (!m) return true;
  const a = verParts(have), b = verParts(m[1]);
  for (let i = 0; i < 3; i += 1) { if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0); }
  return true;
}
/** Why `requires` isn't met on this host, or null. */
export function checkRequires(m, host) {
  const r = m.requires || {};
  if (r.kingmaker && !satisfies(host.kingmaker, r.kingmaker)) return `needs Kingmaker ${r.kingmaker} (have ${host.kingmaker})`;
  if (r.launcher && host.launcher && !satisfies(host.launcher, r.launcher)) return `needs launcher ${r.launcher}`;
  if (r.arch && host.arch && r.arch !== host.arch) return `needs ${r.arch} (this is ${host.arch})`;
  return null;
}

/* ---------------- the two signature gates (delegated, fail closed) ---------------- */

/**
 * Run the manifest-signature and (for paid) entitlement gates. `verifyManifest(manifest)` and
 * `verifyEntitlement(entitlement, { sku, install })` are injected by the engine with its pinned keys; each returns true
 * only on a genuine signature. A missing verifier, or a false, FAILS CLOSED. Returns null (passed) or the refusal text.
 */
export async function verifyGates(m, { manifestBytes = null, sigB64 = null, entitlement = null, verifyManifest = null, verifyEntitlement = null, install = {} } = {}) {
  if (typeof verifyManifest !== 'function') return 'no manifest-signature verifier (fail closed)';
  let okSig = false; try { okSig = await verifyManifest(manifestBytes, sigB64); } catch { okSig = false; }
  if (!okSig) return 'manifest signature did not verify';
  if (!m.paid) return null;
  if (typeof verifyEntitlement !== 'function') return 'no entitlement verifier for a paid add-on (fail closed)';
  if (!entitlement) return 'this Mac holds no entitlement for ' + m.sku;
  let okEnt = false; try { okEnt = await verifyEntitlement(entitlement, { sku: m.sku, install }); } catch { okEnt = false; }
  return okEnt ? null : 'entitlement did not verify (bad signature, wrong Mac, expired or revoked)';
}

/* ---------------- the pinned-key verifiers (match genuine.rs / cert.rs byte-for-byte) ---------------- */

// The release-signing and install-cert public halves, pinned in sol-ghost (fingerprint-checked against the launcher's
// copies). Public keys, safe to commit. The RSA one's authenticity as the ACTUAL release-manifest signer is confirmed
// by the signing branch; revocation (/cert-status) stays the engine's.
export const RELEASE_KEY_PEM = new URL('./kingmaker-release-public.pem', import.meta.url);
export const CERT_KEY_PEM = new URL('./ronin-install-cert-public.pem', import.meta.url);

/** Verify a base64 RSA-PSS (SHA-256, salt length = digest) signature over the manifest's EXACT bytes — exactly as
 *  installer/engine.sh and the launcher's genuine.rs do. Never throws. */
export function verifyManifestSig(manifestBytes, sigB64, releaseKeyPem) {
  try {
    if (!manifestBytes || !sigB64) return false;
    const key = createPublicKey(typeof releaseKeyPem === 'string' || Buffer.isBuffer(releaseKeyPem) ? releaseKeyPem : readFileSync(releaseKeyPem));
    return cryptoVerify('sha256', Buffer.isBuffer(manifestBytes) ? manifestBytes : Buffer.from(manifestBytes),
      { key, padding: cryptoConstants.RSA_PKCS1_PSS_PADDING, saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST },
      Buffer.from(String(sigB64).trim(), 'base64'));
  } catch { return false; }
}

/** Verify a ronin.entitlement/1 / install-cert envelope ({payload, sig, alg:'ES256'}): ECDSA P-256 SHA-256 (ASN.1/DER)
 *  over payload's UTF-8 bytes, sig STANDARD base64 — exactly as cert.rs does. Returns the parsed claims, or null. */
export function verifyEntitlementEnvelope(ent, certKeyPem) {
  try {
    if (!ent || ent.alg !== 'ES256' || typeof ent.payload !== 'string' || typeof ent.sig !== 'string') return null;
    const key = createPublicKey(typeof certKeyPem === 'string' || Buffer.isBuffer(certKeyPem) ? certKeyPem : readFileSync(certKeyPem));
    const ok = cryptoVerify('sha256', Buffer.from(ent.payload, 'utf8'), { key, dsaEncoding: 'der' }, Buffer.from(ent.sig.trim(), 'base64'));
    return ok ? JSON.parse(ent.payload) : null;
  } catch { return null; }
}

/** The built-in verifiers bound to the pinned keys: a manifest-signature checker and an entitlement checker (signature +
 *  sku + this Mac's installId/deviceSha256 + expiry). Revocation is NOT here — the engine wraps these with its cached
 *  /cert-status check. Pass custom PEMs for tests. */
export function defaultVerifiers({ releaseKeyPem = RELEASE_KEY_PEM, certKeyPem = CERT_KEY_PEM, now = Date.now } = {}) {
  return {
    verifyManifest: (manifestBytes, sigB64) => verifyManifestSig(manifestBytes, sigB64, releaseKeyPem),
    verifyEntitlement: (ent, { sku, install = {} } = {}) => {
      const c = verifyEntitlementEnvelope(ent, certKeyPem);
      if (!c) return false;
      if (sku && c.sku !== sku) return false;
      if (install.installId && c.installId !== install.installId) return false;
      if (install.deviceSha256 && c.deviceSha256 !== install.deviceSha256) return false;
      if (c.expiresAt && Date.parse(c.expiresAt) <= now()) return false;
      return true;
    },
  };
}

/* ---------------- install / list / remove ---------------- */

const idDir = (root, id) => join(root, id);
const verDir = (root, id, version) => join(root, id, version);

/**
 * Install a staged add-on: re-check the manifest, every file hash, `requires`, and the signature/entitlement gates,
 * then place the files atomically at <root>/<id>/<version>/ (keeping their lib/ scripts/ vendor/ layout), write
 * current.json and, for a paid add-on, the entitlement (0600). `stagedDir` holds manifest.json and the files. Throws on
 * any failed check — nothing is placed. Returns { id, version }.
 */
export async function installAddon({ stagedDir, root, entitlement = null, requires = {}, verifyManifest = null, verifyEntitlement = null, install = {} }) {
  const manifestBytes = readFileSync(join(stagedDir, 'manifest.json'));
  const m = JSON.parse(manifestBytes.toString('utf8'));
  const probs = manifestProblems(m); if (probs.length) throw new Error('bad manifest: ' + probs.join('; '));
  const badFile = checkFiles(stagedDir, m); if (badFile) throw new Error(badFile);
  const needs = checkRequires(m, requires); if (needs) throw new Error(needs);
  let sigB64 = null; try { sigB64 = readFileSync(join(stagedDir, 'manifest.json.sig'), 'utf8'); } catch { /* unsigned: the gate fails closed */ }
  const refused = await verifyGates(m, { manifestBytes, sigB64, entitlement, verifyManifest, verifyEntitlement, install }); if (refused) throw new Error(refused);
  const dest = verDir(root, m.id, m.version);
  const staging = dest + '.staging-' + Math.random().toString(36).slice(2, 10);
  rmSync(staging, { recursive: true, force: true });
  for (const f of m.files) { const d = join(staging, f.path); mkdirSync(dirname(d), { recursive: true }); cpSync(join(stagedDir, f.path), d); }
  writeFileSync(join(staging, 'manifest.json'), manifestBytes); // the EXACT bytes, so the signature still verifies at load
  if (sigB64) writeFileSync(join(staging, 'manifest.json.sig'), sigB64);
  mkdirSync(dirname(dest), { recursive: true });
  // Keep the known-good version until the new one is in place: move the old dir aside (atomic), swap the staged dir in
  // (atomic), and only then drop the old. If the rename fails, restore the old so current.json never points at nothing.
  const backup = existsSync(dest) ? `${dest}.old-${Math.random().toString(36).slice(2, 10)}` : null;
  if (backup) renameSync(dest, backup);
  try {
    renameSync(staging, dest); // atomic swap into place
  } catch (e) {
    if (backup) { try { renameSync(backup, dest); } catch { /* best effort: leave the backup for recovery */ } }
    throw e;
  }
  if (backup) rmSync(backup, { recursive: true, force: true });
  writeFileSync(join(idDir(root, m.id), 'current.json'), JSON.stringify({ version: m.version }));
  if (m.paid && entitlement) { const ep = join(dest, 'entitlement.json'); writeFileSync(ep, JSON.stringify(entitlement)); try { chmodSync(ep, 0o600); } catch { /* best effort */ } }
  return { id: m.id, version: m.version };
}

/** The installed add-ons: [{ id, version }], skipping anything unreadable. */
export function listAddons({ root }) {
  if (!existsSync(root)) return [];
  const out = [];
  for (const id of readdirSync(root)) {
    try { const cur = JSON.parse(readFileSync(join(idDir(root, id), 'current.json'), 'utf8')); if (ID_RE.test(id) && VER_RE.test(cur.version || '')) out.push({ id, version: cur.version }); } catch { /* skip */ }
  }
  return out;
}

/** Remove one add-on's folder (only that id's). Returns true if something was removed. */
export function removeAddon({ root, id }) {
  if (!ID_RE.test(id || '')) throw new Error('bad id');
  const d = idDir(root, id); if (!existsSync(d)) return false;
  rmSync(d, { recursive: true, force: true });
  return true;
}

/* ---------------- loadAddons (startup) ---------------- */

/**
 * At startup: for each installed add-on, re-check the manifest signature, the file hashes, `requires`, and (paid) the
 * entitlement + its revocation, then import the entry module and call register(host). Any failure skips that add-on with
 * one log line — nothing else in Kingmaker changes. Never throws. `importer` is injectable for tests.
 */
export async function loadAddons(host, { root, requires = {}, entitlementFor = () => null, verifyManifest = null, verifyEntitlement = null, install = {}, importer = (u) => import(u), log = noop } = {}) {
  const loaded = [];
  for (const { id, version } of listAddons({ root })) {
    const dir = verDir(root, id, version);
    try {
      const manifestBytes = readFileSync(join(dir, 'manifest.json'));
      const m = JSON.parse(manifestBytes.toString('utf8'));
      if (manifestProblems(m).length) { log('addon_skip', { id, why: 'bad manifest' }); continue; }
      const badFile = checkFiles(dir, m); if (badFile) { log('addon_skip', { id, why: badFile }); continue; }
      const needs = checkRequires(m, requires); if (needs) { log('addon_skip', { id, why: needs }); continue; }
      let sigB64 = null; try { sigB64 = readFileSync(join(dir, 'manifest.json.sig'), 'utf8'); } catch { /* unsigned */ }
      const entitlement = m.paid ? (entitlementFor(m.sku) ?? safeRead(join(dir, 'entitlement.json'))) : null;
      const refused = await verifyGates(m, { manifestBytes, sigB64, entitlement, verifyManifest, verifyEntitlement, install }); if (refused) { log('addon_skip', { id, why: refused }); continue; }
      const mod = await importer(pathToFileURL(join(dir, m.entry.module)).href);
      if (typeof mod?.register !== 'function') { log('addon_skip', { id, why: 'no register export' }); continue; }
      // Each add-on gets its OWN data folder (host.paths per id, per the host contract above), so add-ons never share
      // a writable namespace. The rest of the host (services, log, command, version) is the one the engine built.
      const dataDir = join(idDir(root, id), 'data');
      try { mkdirSync(dataDir, { recursive: true }); } catch { /* best effort */ }
      const addonHost = Object.freeze({ ...host, paths: dataDir });
      await mod.register(addonHost);
      loaded.push(id); log('addon_loaded', { id, version });
    } catch (e) { log('addon_skip', { id, why: String(e?.message || e) }); }
  }
  return loaded;
}
function safeRead(file) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } }

/* ---------------- the host API ---------------- */

/**
 * The object an add-on's register(host) receives — its ONLY path to Kingmaker (it never imports core by path, since the
 * app's layout changes between versions). The engine builds this in its cli.mjs hook and passes the live services.
 *   host.apiVersion            — bumped when this shape changes, so an old add-on fails cleanly on a newer Kingmaker
 *   host.version               — Kingmaker's version
 *   host.paths                 — the add-on's OWN data folder (per id), to read/write its state
 *   host.log(event, data)      — a line in Kingmaker's log
 *   host.command(name, fn)     — register the add-on's CLI command (manifest commands[])
 *   host.expose(name, api)     — offer the core the add-on's own API (only names the core knows: 'ronin')
 *   host.services              — the narrow core services the add-on declared it needs (for meeting notes: a transcriber,
 *                                a speaker, and the engine turn for replies). The CRM/floor client and WebRTC are pure
 *                                and live in the add-on itself, so they are not services.
 */
export function makeHost({ version, paths, log = noop, command = noop, services = {}, expose = exposeAddon } = {}) {
  return Object.freeze({ apiVersion: HOST_API_VERSION, version, paths, log, command, expose, services: Object.freeze({ ...services }) });
}

/* ---------------- what an add-on offers the core ---------------- */

/**
 * host.expose(name, api): an add-on hands the core its own API (the Ronin office add-on exposes itself as 'ronin'; the
 * core reaches it only through these live bindings and runs without them). Only names the core knows are taken.
 *   ronin   the Ronin office add-on (sku addon.ronin-office), or null: the free edition
 */
export let ronin = null;
export function exposeAddon(name, api) {
  if (name === 'ronin' && api && typeof api === 'object') { ronin = api; return true; }
  return false;
}
/** Back to the free edition (tests, and an add-on removed while running). */
export function forgetAddons() { ronin = null; }

/** What a Ronin-only command says on an install without the add-on. */
export const roninOnly = (what) => `${what} is part of the Ronin add-on (from Ronin Launcher), which isn't installed here.`;

/* ---------------- cli dispatch (the engine's cli.mjs calls this; this module never edits cli.mjs) ---------------- */

/**
 * Handle `addons install <dir> | list | remove <id>` for the engine's cli.mjs, which adds a ~3-line hook:
 *   import { dispatchAddons, loadAddons, makeHost } from './addons.mjs'
 *   if (argv[0] === 'addons') return dispatchAddons(argv.slice(1), deps)
 *   ... and loadAddons(makeHost({...}), deps) at startup.
 * The entitlement for install comes on stdin (never argv), read by the caller and passed as `entitlement`.
 * Returns { handled, output } — never throws for a normal refusal (it returns an error line).
 */
export async function dispatchAddons(argv, deps = {}) {
  const [cmd, arg] = argv;
  // `ok` drives the process exit code the launcher reads: exit 0 (ok) means installed, anything else is shown to the owner.
  try {
    if (cmd === 'install') {
      if (!arg) return { handled: true, ok: false, output: 'usage: kingmaker addons install <staged dir>' };
      const r = await installAddon({ stagedDir: arg, ...deps });
      return { handled: true, ok: true, output: `installed ${r.id} ${r.version}` };
    }
    if (cmd === 'list') return { handled: true, ok: true, output: listAddons(deps).map((a) => `${a.id} ${a.version}`).join('\n') || '(no add-ons)' };
    if (cmd === 'remove') { if (!arg) return { handled: true, ok: false, output: 'usage: kingmaker addons remove <id>' }; const gone = removeAddon({ ...deps, id: arg }); return { handled: true, ok: gone, output: gone ? `removed ${arg}` : `no such add-on ${arg}` }; }
    return { handled: false, ok: false, output: 'addons: install | list | remove' };
  } catch (e) { return { handled: true, ok: false, output: `addons ${cmd || ''} failed: ${String(e?.message || e)}` }; }
}
