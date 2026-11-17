// lib/armor-connection.mjs — Kingmaker's ONE connection to the separately installed Scripture Armor (2026-11-17).
//
// Owner decision: Scripture Armor is the single owner of its vault, firewall and Little Brother. Kingmaker ships no copy
// of Armor (the old vendored scripture-armor/ tree and the sealed in-payload bundle are gone). Every Armor function
// Kingmaker uses is loaded from the INSTALLED Armor, through this module, after it is:
//   1. LOCATED   — $KINGMAKER_ARMOR_HOME, else the installed app (macOS) or the standalone install directory.
//   2. AUTHENTICATED —
//        macOS app: `codesign --verify` of the app against a pinned designated requirement (Developer ID, team
//                   ARMOR_TEAM_ID, identifier org.ronininc.scripture-armor). The app's sealed-resource list
//                   (_CodeSignature/CodeResources, bound by the signed CodeDirectory) then gives the SHA-256 every
//                   file Kingmaker loads must have. Only the files Kingmaker loads are checked, so a runtime file the
//                   app adds elsewhere (e.g. Ghidra's *.sla.lock) does not break Kingmaker — but it is reported.
//        elsewhere: there is no platform signature to check, so the owner must pin the install: the SHA-256 of its
//                   BUNDLE.json in $KINGMAKER_ARMOR_PIN or ~/.kingmaker/armor-pin.json ({"bundleSha256": "..."}).
//                   Unpinned → refused (ARMOR_UNAUTHENTICATED). Nothing is pinned automatically.
//      In both cases every loaded file must also match its BUNDLE.json entry.
//   3. VERSION-CHECKED — BUNDLE.json version ≥ MIN_ARMOR_VERSION and the exports in ARMOR_CONTRACT present.
// Any failure FAILS CLOSED: Armor-dependent operations throw ArmorUnavailableError with a precise code, while the rest
// of Kingmaker (which never touches these proxies) keeps working. Nothing here installs, modifies or starts Armor.
//
// Residual risk (stated, not hidden): files are hashed and then loaded by Node in two reads; a same-user process that
// can rewrite the installed Armor between those reads could also rewrite Kingmaker itself.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, normalize, relative, sep } from 'node:path';

export const ARMOR_CONNECTION_SCHEMA = 'kingmaker.armor-connection/1';
export const MIN_ARMOR_VERSION = '1.2.3';
/** The Developer ID team observed signing the installed Scripture Armor.app (codesign: W9DZM3W6QC). */
export const ARMOR_TEAM_ID = 'W9DZM3W6QC';
export const ARMOR_BUNDLE_ID = 'org.ronininc.scripture-armor';
export const ARMOR_REQUIREMENT = `anchor apple generic and certificate leaf[subject.OU] = "${ARMOR_TEAM_ID}" and identifier "${ARMOR_BUNDLE_ID}"`;
/** The Armor API Kingmaker relies on, per module. A missing export = incompatible Armor. */
export const ARMOR_CONTRACT = Object.freeze({
  'armor.mjs': ['createIdentity', 'loadIdentity', 'publicBlock', 'parsePublicBlock', 'fingerprintOfRaw', 'sealPlaintext',
    'openSealedFile', 'parseScriptureFile', 'unsealFileKey', 'verifyFrameSignature', 'frameDigestKind', 'armorDecode',
    'appendEstateEvent', 'registerIssuances', 'signPayload', 'verifyPayload', 'signRevocation', 'revocationFor', 'verifyRevocation'],
  'refit-net.mjs': ['Flow', 'openFlow'],
  'scan.mjs': ['scanSourceText'],
});

export class ArmorUnavailableError extends Error {
  constructor(code, detail) { super(`Scripture Armor unavailable (${code}): ${detail}`); this.name = 'ArmorUnavailableError'; this.code = code; this.detail = detail; }
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const cmpVersion = (a, b) => { const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number); for (let i = 0; i < 3; i += 1) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return Math.sign(d); } return 0; };

/** Where an installed Armor could be, in order. */
export function armorCandidates(env = process.env, platform = process.platform) {
  if (env.KINGMAKER_ARMOR_HOME) return [String(env.KINGMAKER_ARMOR_HOME)];
  const home = env.HOME || homedir();
  const out = [];
  if (platform === 'darwin') for (const apps of ['/Applications', join(home, 'Applications')]) out.push(join(apps, 'Scripture Armor.app', 'Contents', 'Resources', 'armor'));
  out.push(join(home, 'scripture-armor'));
  if (platform === 'win32' && env.LOCALAPPDATA) out.push(join(env.LOCALAPPDATA, 'ScriptureArmor'));
  return out;
}

/** The enclosing .app of an armor dir, if it is inside one. */
function enclosingApp(root) { const m = /^(.*?\.app)(?:\/|$)/.exec(root.split(sep).join('/')); return m ? m[1] : null; }

/** Parse the sealed-resource SHA-256s (hash2) out of an app's _CodeSignature/CodeResources (Apple's XML plist). */
export function sealedResourceHashes(app) {
  const xml = readFileSync(join(app, 'Contents', '_CodeSignature', 'CodeResources'), 'utf8');
  const files2 = xml.indexOf('<key>files2</key>');
  if (files2 < 0) throw new ArmorUnavailableError('ARMOR_UNAUTHENTICATED', 'the app signature has no sealed-resource list');
  const out = new Map();
  const re = /<key>([^<]+)<\/key>\s*<dict>\s*(?:<key>cdhash<\/key>\s*<data>[^<]*<\/data>\s*)?<key>hash2<\/key>\s*<data>\s*([A-Za-z0-9+/=\s]+?)\s*<\/data>/g;
  re.lastIndex = files2; let m;
  while ((m = re.exec(xml))) out.set(m[1].replace(/&amp;/g, '&'), Buffer.from(m[2].replace(/\s+/g, ''), 'base64').toString('hex'));
  return out;
}

/** The local import closure of `entries` (static and literal dynamic imports of ./ or ../ specifiers). */
export function importClosure(root, entries) {
  const seen = new Set(); const todo = [...entries];
  while (todo.length) {
    const rel = normalize(todo.pop()).split(sep).join('/');
    if (seen.has(rel)) continue;
    if (rel.startsWith('..')) throw new ArmorUnavailableError('ARMOR_TAMPERED', `an Armor module imports outside its install: ${rel}`);
    seen.add(rel);
    const src = readFileSync(join(root, rel), 'utf8');
    for (const m of src.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"\n]+)\1/g)) todo.push(join(dirname(rel), m[2]));
  }
  return [...seen].sort();
}

function readPin(env) {
  if (env.KINGMAKER_ARMOR_PIN) return String(env.KINGMAKER_ARMOR_PIN).trim().toLowerCase();
  try { return String(JSON.parse(readFileSync(join(env.HOME || homedir(), '.kingmaker', 'armor-pin.json'), 'utf8')).bundleSha256 || '').toLowerCase() || null; } catch { return null; }
}

/** Locate, authenticate and version-check an installed Armor. Pure check: loads no Armor code. Throws ArmorUnavailableError. */
export function verifyInstalledArmor({ env = process.env, platform = process.platform, codesign = runCodesign, entries = Object.keys(ARMOR_CONTRACT) } = {}) {
  const tried = armorCandidates(env, platform);
  const found = tried.find((d) => existsSync(join(d, 'BUNDLE.json')) && existsSync(join(d, 'armor.mjs')));
  if (!found) throw new ArmorUnavailableError('ARMOR_MISSING', `no installed Scripture Armor found (looked in: ${tried.join(', ')})`);
  const root = realpathSync(found);
  const bundleBytes = readFileSync(join(root, 'BUNDLE.json'));
  let bundle; try { bundle = JSON.parse(bundleBytes); } catch { throw new ArmorUnavailableError('ARMOR_TAMPERED', 'BUNDLE.json does not parse'); }
  if (bundle?.schema !== 'scripture-armor.standalone-bundle/1' || !Array.isArray(bundle.files)) throw new ArmorUnavailableError('ARMOR_INCOMPATIBLE', `unknown Armor bundle schema ${bundle?.schema}`);
  if (!/^\d+\.\d+\.\d+$/.test(String(bundle.version)) || cmpVersion(bundle.version, MIN_ARMOR_VERSION) < 0) throw new ArmorUnavailableError('ARMOR_INCOMPATIBLE', `installed Armor ${bundle.version} is older than the ${MIN_ARMOR_VERSION} Kingmaker requires`);

  const app = platform === 'darwin' ? enclosingApp(root) : null;
  let auth; let sealed = null; const notes = [];
  if (app) {
    const r = codesign(app);
    if (!r.ok) throw new ArmorUnavailableError('ARMOR_UNAUTHENTICATED', `the installed app's signature does not satisfy the pinned requirement (team ${ARMOR_TEAM_ID}): ${r.detail}`);
    sealed = sealedResourceHashes(app);
    if (!r.resourcesIntact) notes.push(`the app's full seal is broken (${r.resourceDetail}); Kingmaker checks only the files it loads`);
    auth = { method: 'apple-codesign', team: ARMOR_TEAM_ID, app };
  } else {
    const pin = readPin(env);
    if (!pin) throw new ArmorUnavailableError('ARMOR_UNAUTHENTICATED', `no platform signature to check at ${root}; the owner must pin this install (KINGMAKER_ARMOR_PIN or ~/.kingmaker/armor-pin.json with its BUNDLE.json sha256 ${sha256(bundleBytes)})`);
    if (pin !== sha256(bundleBytes)) throw new ArmorUnavailableError('ARMOR_TAMPERED', 'BUNDLE.json does not match the owner-pinned hash');
    auth = { method: 'owner-pin', bundleSha256: pin };
  }
  const byPath = new Map(bundle.files.map((f) => [f.path, f.sha256]));
  const files = importClosure(root, entries);
  const appRel = app ? relative(join(app, 'Contents'), root).split(sep).join('/') : null;
  for (const rel of files) {
    const h = sha256(readFileSync(join(root, rel)));
    if (byPath.get(rel) !== h) throw new ArmorUnavailableError('ARMOR_TAMPERED', `${rel} does not match the installed Armor's BUNDLE.json`);
    if (sealed && sealed.get(`${appRel}/${rel}`) !== h) throw new ArmorUnavailableError('ARMOR_TAMPERED', `${rel} does not match the app's signed resource hash`);
  }
  return { schema: ARMOR_CONNECTION_SCHEMA, root, version: bundle.version, auth, files, notes };
}

function runCodesign(app) {
  try { execFileSync('/usr/bin/codesign', ['--verify', '--ignore-resources', `-R=${ARMOR_REQUIREMENT}`, app], { stdio: 'pipe', timeout: 30000 }); }
  catch (e) { return { ok: false, detail: String(e.stderr || e.message).trim().split('\n')[0] }; }
  try { execFileSync('/usr/bin/codesign', ['--verify', '--strict', app], { stdio: 'pipe', timeout: 60000 }); return { ok: true, resourcesIntact: true }; }
  catch (e) { return { ok: true, resourcesIntact: false, resourceDetail: String(e.stderr || e.message).trim().split('\n')[0] }; }
}

// ── The live connection (one per process) ───────────────────────────────────────────────────────────────────────────

let conn = null; // { ok, info, modules } or { ok:false, error }
const requireHere = createRequire(import.meta.url);

/** Connect (once) and return the loaded modules; throws ArmorUnavailableError. */
export function connectArmor(opts) {
  if (conn?.ok) return conn;
  if (conn && !opts) throw conn.error;
  try {
    const info = verifyInstalledArmor(opts);
    const modules = {};
    for (const [file, names] of Object.entries(ARMOR_CONTRACT)) {
      let ns; try { ns = requireHere(join(info.root, file)); } catch (e) { throw new ArmorUnavailableError('ARMOR_LOAD_FAILED', `${file}: ${String(e.message).split('\n')[0]}`); }
      const missing = names.filter((n) => typeof ns[n] !== 'function');
      if (missing.length) throw new ArmorUnavailableError('ARMOR_INCOMPATIBLE', `installed Armor ${info.version} ${file} lacks ${missing.join(', ')}`);
      modules[file] = ns;
    }
    conn = { ok: true, info, modules };
    return conn;
  } catch (e) {
    const error = e instanceof ArmorUnavailableError ? e : new ArmorUnavailableError('ARMOR_LOAD_FAILED', String(e.message));
    conn = { ok: false, error };
    throw error;
  }
}

/** Status for UIs: never throws, never loads more than connectArmor does. */
export function armorConnectionState() {
  try { const c = connectArmor(); return { ok: true, state: 'connected', version: c.info.version, root: c.info.root, auth: c.info.auth, notes: c.info.notes }; }
  catch (e) { return { ok: false, state: 'unavailable', code: e.code ?? 'ARMOR_LOAD_FAILED', detail: e.detail ?? e.message }; }
}

/** Test seam: forget the cached connection (e.g. after changing KINGMAKER_ARMOR_HOME). */
export function resetArmorConnection() { conn = null; }

/** A lazy namespace for one Armor module: nothing loads until a property is read; then it connects or throws. */
function lazyModule(file) {
  return new Proxy(Object.create(null), {
    get(_t, prop) { if (typeof prop !== 'string' || prop === 'then') return undefined; return connectArmor().modules[file][prop]; },
    has(_t, prop) { return ARMOR_CONTRACT[file].includes(prop); },
  });
}
export const armor = lazyModule('armor.mjs');
export const refitNet = lazyModule('refit-net.mjs');
export const armorScan = lazyModule('scan.mjs');
/** Lazy function bindings for named imports: `const { loadIdentity } = armorFns(armor, ['loadIdentity'])`. */
export function armorFns(ns, names) { return Object.fromEntries(names.map((n) => [n, (...a) => ns[n](...a)])); }
