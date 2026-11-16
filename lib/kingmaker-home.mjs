// lib/kingmaker-home.mjs — one Kingmaker folder, hidden (the owner, 2026-10-15: "auto setup one kingmaker folder instead of
// several … out of sight out of mind"; then: "the clutter is the visible files on my desktop. they should get one hidden
// folder they never see that kingmaker uses thats cleaner").
//
// Everything Kingmaker makes goes in Files inside its own data folder (~/Library/Application Support/sol-ghost/Files;
// Library is hidden in Finder): documents, pictures, ads and reels, the engine's reports, the phone's field uploads, the
// pairing code, the bench. KINGMAKER_HOME moves it. The owner reaches it through the bar (Artifacts), never the Desktop.
// At each start, what Kingmaker left in sight moves in, on the same disk, never overwriting: its leftovers on the
// Desktop (by the names only Kingmaker gives things) and its old visible folders, ~/Documents/Kingmaker and
// ~/Pictures/Kingmaker.
//
// An approved external drive can hold the Files folder (role `files`, lib/external-storage.mjs): then everything
// above resolves there; with that drive missing, kingmakerHome/homeFolder refuse (STORAGE_UNAVAILABLE) rather than
// start a second Files folder on this Mac, and the tidy-up is skipped (a move to another disk is never a copy).
import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, extname, basename } from 'node:path';
import { filesLocation, safeWriteFile } from './external-storage.mjs';

export const FOLDERS = { ads: 'Ads & Reels', reports: 'Reports', field: 'Field', phone: 'Phone', pictures: 'Pictures', documents: 'Documents', bench: 'Bench' };

const stateDir = (env, home) => String(env.SOL_GHOST_HOME ?? '').trim() || join(home, 'Library', 'Application Support', 'sol-ghost');
/**
 * Where the Files folder is right now (lib/external-storage.mjs filesLocation): an approved drive holding the `files`
 * role wins (over KINGMAKER_HOME too — the approval is the newer, explicit choice); otherwise KINGMAKER_HOME, else
 * <state>/Files. → { where: 'internal'|'drive'|'unavailable', dir, writable, reason }. Never throws.
 */
export function kingmakerHomeStatus(env = process.env, home = homedir()) {
  const state = stateDir(env, home);
  const internalDir = String(env.KINGMAKER_HOME ?? '').trim() || join(state, 'Files');
  try { return filesLocation({ state, internalDir }); }
  catch (e) { return { where: 'unavailable', dir: null, writable: false, reason: `Unavailable: your files — the approved drive could not be checked (${String(e?.message ?? e).slice(0, 120)}); nothing was saved on this Mac instead.` }; }
}
/**
 * Where the Files folder BELONGS, reachable or not (never created here): for settings handed to another process (the
 * engine's reports and field-upload folders), so a missing drive makes those writes fail instead of landing on this
 * Mac. Use homeFolder/kingmakerHome to write.
 */
export function kingmakerHomePath(env = process.env, home = homedir()) {
  const s = kingmakerHomeStatus(env, home);
  return s.dir ?? s.expectedDir ?? join(stateDir(env, home), 'Files');
}
/** The Files folder. Throws STORAGE_UNAVAILABLE when it is assigned to a drive that is not connected (no internal stand-in). */
export const kingmakerHome = (env = process.env, home = homedir()) => {
  const s = kingmakerHomeStatus(env, home);
  if (!s.dir) throw new Error(`STORAGE_UNAVAILABLE: ${s.reason}`);
  return s.dir;
};
/** A folder in Kingmaker's home (made when missing). Refused (STORAGE_UNAVAILABLE) on a missing or read-only files drive. */
export function homeFolder(key, { env = process.env, home = homedir(), make = true } = {}) {
  const s = kingmakerHomeStatus(env, home);
  if (!s.dir) throw new Error(`STORAGE_UNAVAILABLE: ${s.reason}`);
  const dir = join(s.dir, FOLDERS[key] ?? key);
  if (make && !s.writable) throw new Error(`STORAGE_UNAVAILABLE: ${s.reason}`);
  if (make) mkdirSync(dir, { recursive: true });
  return dir;
}
/**
 * Save one file into Kingmaker's Files folder. On an approved drive it is a verified save (journal, fsync, sha256
 * read-back, rename — lib/external-storage.mjs safeWriteFile); internally a plain write. → the saved path.
 */
export async function saveHomeFile(key, name, data, { env = process.env, home = homedir() } = {}) {
  const s = kingmakerHomeStatus(env, home);
  if (!s.dir || !s.writable) throw new Error(`STORAGE_UNAVAILABLE: ${s.reason}`);
  const dir = homeFolder(key, { env, home }), path = join(dir, basename(String(name)));
  if (s.where === 'drive') await safeWriteFile(path, data, { root: s.root, maxFileBytes: s.maxFileBytes });
  else writeFileSync(path, data);
  return path;
}

// What earlier versions put on the Desktop, by the names only Kingmaker gives things.
const LEFTOVERS = [
  { test: (n, dir) => !dir && /^Kingmaker (Ad|Reel)\b.*\.(mp4|mov)$/i.test(n), to: 'ads' },
  { test: (n, dir) => !dir && /^Kingmaker-pair-QR.*\.png$/i.test(n), to: 'phone' },
  { test: (n, dir) => dir && n === 'Kingmaker — Reports', to: 'reports', merge: true },
  { test: (n, dir) => dir && n === 'Kingmaker Bench', to: 'bench', merge: true },
];
const FINDER_ONLY = new Set(['.DS_Store', '.localized']);

/** A name not yet taken in `dir`: "x.mp4", "x 2.mp4", "x 3.mp4"… */
function freeName(dir, name) {
  if (!existsSync(join(dir, name))) return name;
  const ext = extname(name), stem = basename(name, ext);
  for (let i = 2; ; i++) { const n = `${stem} ${i}${ext}`; if (!existsSync(join(dir, n))) return n; }
}
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

/** Move everything in `from` into `to`: a folder both have is merged, a name both have gets " 2". Then `from` goes
 *  when only Finder's own files are left in it. → the moves made. */
function mergeInto(from, to, moved, log) {
  let names = [];
  try { names = readdirSync(from); } catch { return; }
  mkdirSync(to, { recursive: true });
  for (const n of names) {
    if (FINDER_ONLY.has(n)) continue;
    const src = join(from, n), dst = join(to, n);
    if (existsSync(dst) && isDir(src) && isDir(dst)) { mergeInto(src, dst, moved, log); continue; }
    const target = join(to, freeName(to, n));
    try { renameSync(src, target); moved.push({ from: src, to: target }); } catch (e) { log('tidy_skipped', { name: n, reason: e.code || String(e.message).slice(0, 80) }); }
  }
  try { if (readdirSync(from).every((n) => FINDER_ONLY.has(n))) { for (const n of FINDER_ONLY) rmSync(join(from, n), { force: true }); rmdirSync(from); } } catch { /* keep it */ }
}

/** Move what Kingmaker left in sight into its hidden home. → [{ from, to }] (a different disk is skipped, not copied). */
export function tidyDesktop({ env = process.env, home = homedir(), log = () => {} } = {}) {
  const desk = join(home, 'Desktop'), moved = [];
  const where = kingmakerHomeStatus(env, home);
  if (!where.dir || !where.writable) { log('tidy_skipped', { name: '*', reason: String(where.reason ?? 'files unavailable').slice(0, 160) }); return moved; }
  let entries = [];
  try { entries = readdirSync(desk, { withFileTypes: true }); } catch { entries = []; }
  for (const e of entries) {
    const rule = LEFTOVERS.find((r) => r.test(e.name, e.isDirectory()));
    if (!rule) continue;
    const dir = homeFolder(rule.to, { env, home }), from = join(desk, e.name);
    if (rule.merge) mergeInto(from, dir, moved, log);
    else { const to = join(dir, freeName(dir, e.name)); try { renameSync(from, to); moved.push({ from, to }); } catch (err) { log('tidy_skipped', { name: e.name, reason: err.code || '' }); } }
  }
  // The old visible folders (unless KINGMAKER_HOME points at one of them).
  const hidden = kingmakerHome(env, home);
  for (const [old, into] of [[join(home, 'Documents', 'Kingmaker'), hidden], [join(home, 'Pictures', 'Kingmaker'), join(hidden, FOLDERS.pictures)]]) {
    if (existsSync(old) && !hidden.startsWith(old) && old !== into) mergeInto(old, into, moved, log);
  }
  if (moved.length) log('tidy_desktop', { moved: moved.length });
  return moved;
}
