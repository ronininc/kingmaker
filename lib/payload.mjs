// lib/payload.mjs — THE KINGMAKER PAYLOAD: every file the free Kingmaker runs, as one unit (the owner, 2026-10-17: "make
// sure that the kingmaker files are one file so its always there, its a free product it needs to be there").
//
// 0.2.6 shipped with lib/ but without vendor/, catalog/ and core/: the app's builder copied Kingmaker folder by folder and
// forgot three. Now nothing is copied by folder. scripts/build-payload.mjs writes ONE file, kingmaker-payload.tar: the
// whole of Resources/sol-ghost (the parts below) plus payload.json, the list of every file with its size and SHA-256.
// A builder unpacks that one file into Contents/Resources and has nothing to choose. Every start checks the list
// (lib/kingmaker.mjs, before any of Kingmaker loads), so a partial install says what is missing instead of crashing.
// Uses Node built-ins only: it must run when the rest of Kingmaker can't.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const PAYLOAD_SCHEMA = 'kingmaker.payload/1';
export const PAYLOAD_FILE = 'payload.json';
/** What the free Kingmaker is, inside the app's Resources/sol-ghost. Never addons/ (paid, installed separately). */
export const PAYLOAD_PARTS = Object.freeze(['package.json', 'bin', 'lib', 'vendor', 'catalog', 'core', 'assets', 'LICENSE', 'COMMERCIAL-LICENSE.md', 'THIRD_PARTY_NOTICES.md', 'TERMS.md']);
/** Files Kingmaker cannot start without, checked even where no payload.json exists (a checkout). */
export const ESSENTIAL = Object.freeze(['package.json', 'bin/kingmaker', 'lib/cli.mjs', 'vendor/fleet/fleet-packet.mjs', 'vendor/office/office-libs.mjs', 'catalog/essentials.json', 'core/pack.json']);

/** Is `root` an installed app's Resources/sol-ghost (where payload.json must exist) rather than a checkout? */
export const installedLayout = (root) => /\.app\/Contents\/Resources\/sol-ghost\/?$/.test(String(root).split(sep).join('/'));

const SKIP = new Set(['.DS_Store', 'node_modules', '__pycache__', '.git']);
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Every file of the payload under `root` (a checkout or Resources/sol-ghost), as sorted '/' paths. */
export function payloadFiles(root, parts = PAYLOAD_PARTS) {
  const out = [];
  const walk = (abs) => {
    const st = statSync(abs);
    if (st.isDirectory()) { for (const name of readdirSync(abs)) if (!SKIP.has(name)) walk(join(abs, name)); return; }
    if (st.isFile()) out.push(relative(root, abs).split(sep).join('/'));
  };
  for (const part of parts) {
    const abs = join(root, part);
    if (!existsSync(abs)) throw new Error(`the payload part ${part} is missing from ${root}`);
    walk(abs);
  }
  return out.sort();
}

/** The payload's list: every file with its size and SHA-256, and the version it belongs to. → its JSON text. */
export function buildManifest(root, { files = payloadFiles(root) } = {}) {
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const list = files.map((path) => { const buf = readFileSync(join(root, path)); return { path, size: buf.length, sha256: sha256(buf) }; });
  return `${JSON.stringify({ schema: PAYLOAD_SCHEMA, version, count: list.length, files: list }, null, 1)}\n`;
}

/**
 * Is the Kingmaker under `root` whole? → { ok, missing: [...], changed: [...], checked, listed }.
 * With payload.json (an installed app): every listed file is there (and, `deep`, has its size and SHA-256).
 * Without it in a checkout: the essential files are there. Without it (or with a broken one) inside an app: never whole,
 * since only the list can say what a partial unpack left out.
 */
export function checkPayload(root, { deep = false, installed = installedLayout(root) } = {}) {
  let manifest = null;
  try { manifest = JSON.parse(readFileSync(join(root, PAYLOAD_FILE), 'utf8')); } catch { manifest = null; }
  if (!manifest || manifest.schema !== PAYLOAD_SCHEMA || !Array.isArray(manifest.files)) {
    if (installed) return { ok: false, missing: [PAYLOAD_FILE], changed: [], checked: 0, listed: false };
    const missing = ESSENTIAL.filter((f) => !existsSync(join(root, f)));
    return { ok: missing.length === 0, missing, changed: [], checked: ESSENTIAL.length, listed: false };
  }
  const missing = [], changed = [];
  for (const f of manifest.files) {
    const abs = join(root, f.path);
    if (!existsSync(abs)) { missing.push(f.path); continue; }
    if (deep) { const buf = readFileSync(abs); if (buf.length !== f.size || sha256(buf) !== f.sha256) changed.push(f.path); }
  }
  return { ok: missing.length === 0 && changed.length === 0, missing, changed, checked: manifest.files.length, listed: true, version: manifest.version };
}

/** Pure: what to tell the owner about a partial install. */
export function payloadProblem(r) {
  if (r.ok) return null;
  const parts = [...new Set(r.missing.map((p) => p.split('/')[0]))];
  const what = r.missing.length ? `${r.missing.length} of its files are missing (${parts.join(', ')}: ${r.missing.slice(0, 3).join(', ')}${r.missing.length > 3 ? ', …' : ''})` : '';
  const changed = r.changed.length ? `${r.changed.length} changed since the release (${r.changed.slice(0, 3).join(', ')})` : '';
  return `This Kingmaker is incomplete: ${[what, changed].filter(Boolean).join('; ')}. Reinstall it with Kingmaker Installer (or Ronin Launcher); nothing of yours is lost.`;
}
