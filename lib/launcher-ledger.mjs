// lib/launcher-ledger.mjs — which Ronin Launcher builds Ronin Inc has ISSUED, so Kingmaker can dock with any of
// them, undock from all of them, and tell an older issued build apart from an altered one.
//
// Before this, a release named exactly one launcher (the manifest's launcher.sha256). Every other launcher —
// last month's genuine build, the copy Apple re-signed for the App Store, and a build with code injected into it —
// was the same thing to Kingmaker: "not the pin". The ledger (lib/launcher-issued.json) is the list of every build
// that was issued. A launcher is then one of:
//   current   the newest issued build that has not been revoked
//   issued    an older build on the list: genuine, just not the newest
//   revoked   on the list and withdrawn
//   unknown   not on the list at all — a build Ronin Inc never issued, which is what an altered one is
// Unknown is never softened into "probably an old one": only a listed fingerprint is issued.
//
// WHO VOUCHES FOR THE LIST. It ships inside Kingmaker's payload, so the app's code signature and payload.json cover
// it, and a release copies it into the signed manifest (launcher.issued). It is append-only: an entry is never
// edited or removed, only marked revoked (ledgerExtends is the check; the test suite holds the committed file to
// its own history).
//
// TWO FINGERPRINTS, because a launcher is met in two forms:
//   archiveSha256  sha256 of the zip a release carries (what the installer downloads)
//   bundleSha256   bundleFingerprint() of an installed Ronin Launcher.app
// An App Store copy has no archive and is re-signed by Apple, so its bundle fingerprint differs from the build
// that was submitted even when no code changed: it is listed by the fingerprint of the copy the App Store delivers.
//
// Uses Node built-ins only.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

export const LEDGER_SCHEMA = 'kingmaker.launcher-ledger/1';
export const LEDGER_FILE = new URL('./launcher-issued.json', import.meta.url);
export const CHANNELS = Object.freeze(['direct', 'app-store']);
const HEX64 = /^[0-9a-f]{64}$/;

/** The committed ledger. */
export function readLedger(file = LEDGER_FILE) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** What is wrong with a ledger, as sentences. [] when it is sound. */
export function ledgerProblems(ledger) {
  const out = [];
  if (!ledger || ledger.schema !== LEDGER_SCHEMA) return [`the launcher ledger's schema must be ${LEDGER_SCHEMA}`];
  if (!Array.isArray(ledger.entries)) return ['the launcher ledger has no entries list'];
  const seen = new Map();
  ledger.entries.forEach((e, i) => {
    const at = `entry ${i + 1}`;
    if (!e || typeof e !== 'object') { out.push(`${at} is not an object`); return; }
    if (typeof e.version !== 'string' || !e.version.trim()) out.push(`${at} has no version`);
    if (!CHANNELS.includes(e.channel)) out.push(`${at}: channel must be one of ${CHANNELS.join(', ')}`);
    if (typeof e.issuedAt !== 'string' || Number.isNaN(Date.parse(e.issuedAt))) out.push(`${at}: issuedAt is not a date`);
    if (e.archiveSha256 == null && e.bundleSha256 == null) out.push(`${at} carries no fingerprint (archiveSha256 or bundleSha256)`);
    for (const f of ['archiveSha256', 'bundleSha256']) {
      if (e[f] == null) continue;
      if (!HEX64.test(String(e[f]))) { out.push(`${at}: ${f} is not a lowercase sha256`); continue; }
      // One fingerprint, one build: the same bytes listed twice could be issued in one entry and revoked in another.
      if (seen.has(e[f])) out.push(`${at}: ${f} repeats entry ${seen.get(e[f]) + 1}`);
      else seen.set(e[f], i);
    }
    if (e.channel === 'app-store' && e.archiveSha256 != null) out.push(`${at}: an App Store copy has no release archive`);
    if (e.revoked != null && (typeof e.revoked !== 'object' || typeof e.revoked.at !== 'string' || Number.isNaN(Date.parse(e.revoked.at)) || typeof e.revoked.reason !== 'string' || !e.revoked.reason.trim())) {
      out.push(`${at}: revoked must be { at, reason }`);
    }
  });
  return out;
}

const sameEntry = (a, b) => ['version', 'channel', 'issuedAt', 'archiveSha256', 'bundleSha256', 'note']
  .every((f) => (a[f] ?? null) === (b[f] ?? null));

/**
 * Is `next` the ledger `previous` grown, never rewritten? Every earlier entry is still there, in place, unchanged —
 * except that one may have gained `revoked` (a revocation is never lifted or reworded). → { ok, problems }.
 */
export function ledgerExtends(previous, next) {
  const problems = [...ledgerProblems(next)];
  const before = previous?.entries ?? [];
  const after = next?.entries ?? [];
  if (after.length < before.length) problems.push(`the ledger lost ${before.length - after.length} entr${before.length - after.length === 1 ? 'y' : 'ies'}: issued builds are never removed`);
  before.forEach((old, i) => {
    const now = after[i];
    if (!now) return;
    if (!sameEntry(old, now)) problems.push(`entry ${i + 1} was edited: an issued build's record does not change`);
    if (old.revoked && JSON.stringify(old.revoked) !== JSON.stringify(now.revoked ?? null)) problems.push(`entry ${i + 1}: a revocation was lifted or reworded`);
  });
  return { ok: problems.length === 0, problems };
}

/** The newest entry that is not revoked — the build a docked Kingmaker should be beside. */
export function currentEntry(ledger) {
  const live = (ledger?.entries ?? []).filter((e) => !e.revoked);
  return live.length ? live[live.length - 1] : null;
}

/**
 * Classify a launcher by its fingerprint(s). → { verdict, entry, why }.
 * A fingerprint that is not on the list is `unknown`, whatever else is true of the launcher.
 */
export function classifyLauncher(ledger, { archiveSha256 = null, bundleSha256 = null } = {}) {
  const norm = (h) => (typeof h === 'string' && HEX64.test(h.toLowerCase()) ? h.toLowerCase() : null);
  const a = norm(archiveSha256);
  const b = norm(bundleSha256);
  if (!a && !b) return { verdict: 'unknown', entry: null, why: 'no fingerprint was given' };
  const entries = ledger?.entries ?? [];
  const hits = entries.filter((e) => (a && e.archiveSha256 === a) || (b && e.bundleSha256 === b));
  if (hits.length === 0) return { verdict: 'unknown', entry: null, why: 'this build is not on the list of issued Ronin Launcher builds' };
  // An archive from one issued build beside a bundle from another is not one build.
  if (hits.length > 1) return { verdict: 'unknown', entry: null, why: 'the fingerprints given belong to different issued builds' };
  const entry = hits[0];
  if (entry.revoked) return { verdict: 'revoked', entry, why: `Ronin Launcher ${entry.version} was withdrawn: ${entry.revoked.reason}` };
  const current = currentEntry(ledger);
  if (current === entry) return { verdict: 'current', entry, why: `Ronin Launcher ${entry.version} is the current issued build` };
  return { verdict: 'issued', entry, why: `Ronin Launcher ${entry.version} is an earlier issued build (current is ${current.version})` };
}

/** May Kingmaker dock with a launcher of this verdict? Only a listed, unrevoked build. */
export const mayDock = (verdict) => verdict === 'current' || verdict === 'issued';

/**
 * The fingerprint of an installed Ronin Launcher.app: one sha256 over every file in the bundle (its path and
 * its own sha256) and every symbolic link (its path and where it points). Any change to code or resources
 * changes it, including a resource altered while the signature's own list of resource hashes is left as it was:
 * the files themselves are hashed, not the list. The Mac App Store receipt is left out because Apple writes a
 * different one for each buyer. Returns null when `appDir` is not a signed app bundle.
 */
export function bundleFingerprint(appDir) {
  const fixed = ['Contents/Info.plist', 'Contents/_CodeSignature/CodeResources'];
  for (const rel of fixed) if (!existsSync(join(appDir, rel)) || !statSync(join(appDir, rel)).isFile()) return null;
  const macos = join(appDir, 'Contents', 'MacOS');
  if (!existsSync(macos)) return null;
  const walk = (dir, prefix) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const rel = `${prefix}/${d.name}`;
    if (rel === 'Contents/_MASReceipt') return [];
    if (d.isSymbolicLink()) return [{ rel, link: readlinkSync(join(dir, d.name)) }]; // recorded, never followed
    return d.isDirectory() ? walk(join(dir, d.name), rel) : d.isFile() ? [{ rel }] : [];
  });
  const all = walk(join(appDir, 'Contents'), 'Contents').sort((x, y) => (x.rel < y.rel ? -1 : x.rel > y.rel ? 1 : 0));
  if (!all.some((f) => !f.link && f.rel.startsWith('Contents/MacOS/'))) return null;
  const whole = createHash('sha256');
  for (const f of all) {
    if (f.link != null) { whole.update(`${f.rel}\0link\0${f.link}\n`); continue; }
    const h = createHash('sha256').update(readFileSync(join(appDir, f.rel))).digest('hex');
    whole.update(`${f.rel}\0${h}\n`);
  }
  return whole.digest('hex');
}

/** Is this bundle a copy delivered by the Mac App Store? (Apple puts a receipt in every one.) */
export const isAppStoreCopy = (appDir) => existsSync(join(appDir, 'Contents', '_MASReceipt', 'receipt'));

/**
 * What Kingmaker finds at `appDir`: is a launcher there, and may it dock with it? Pure reading; changes nothing.
 * → { present, docked, verdict, channel, version, bundleSha256, why }
 */
export function dockStatus(appDir, ledger = readLedger()) {
  if (!existsSync(appDir)) {
    return { present: false, docked: false, verdict: null, channel: null, version: null, bundleSha256: null, why: 'No Ronin Launcher is installed. Kingmaker runs on its own.' };
  }
  const bundleSha256 = bundleFingerprint(appDir);
  const channel = isAppStoreCopy(appDir) ? 'app-store' : 'direct';
  if (!bundleSha256) {
    return { present: true, docked: false, verdict: 'unknown', channel, version: null, bundleSha256: null, why: 'What is at that path is not a signed app bundle. Kingmaker stays undocked.' };
  }
  const { verdict, entry, why } = classifyLauncher(ledger, { bundleSha256 });
  // A build listed for one channel but found as the other is not the build that was listed.
  if (entry && entry.channel !== channel) {
    return { present: true, docked: false, verdict: 'unknown', channel, version: null, bundleSha256, why: `This fingerprint is listed as a ${entry.channel} build but the copy here is a ${channel} one. Kingmaker stays undocked.` };
  }
  const docked = mayDock(verdict);
  return { present: true, docked, verdict, channel, version: entry?.version ?? null, bundleSha256, why: docked ? `${why}. Docked.` : `${why}. Kingmaker stays undocked and runs on its own.` };
}
