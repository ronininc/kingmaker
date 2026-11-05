#!/usr/bin/env node
// scripture-armor/churn-scan.mjs — the streaming build's DAILY churn pass over
// the locally persisted streamed portions. Schedulable in the product's own
// conventions: a systemd timer template (streaming/scripture-armor-churn.timer,
// OnCalendar=daily) on Linux, a daily StartCalendarInterval on macOS, or any
// scheduler that runs this file once a day. The pass itself is a bounded,
// one-shot job: it starts, does its work, logs, and exits. It is not a
// watcher and confers no awareness between runs.
//
// Per run it:
//   1. VERIFIES what is held — every held portion is hashed and checked
//      against the portion-store manifest and, when a library record is
//      supplied, against the library.
//   2. REFRESHES portions the library has superseded (the library record for
//      the same portion id carries a different digest): the new bytes are
//      fetched through the supplied source, hash-verified, and only then
//      replace the held bytes.
//   3. EVICTS what is stale or unused (not used within --stale-days) and then,
//      if the store still exceeds --max-bytes, evicts least-recently-used
//      portions until the footprint is back inside the bound. The small
//      install must not silently grow back into the big one.
//   4. LOGS one summary line every run: held / refreshed / evicted /
//      footprint before-and-after, plus one line per action.
//
// A FAILED VERIFICATION is a verdict the user sees: it is printed as a
// VERDICT line, included in the result's verdicts, and the portion is left
// exactly as found — never silently repaired, refreshed over, or evicted by
// this pass.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const CHURN_SCHEMA = 'scripture-armor.churn-scan/1';
export const STORE_SCHEMA = 'scripture-armor.portion-store/1';
export const DEFAULT_STALE_DAYS = 30;
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;

const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const dayMs = 24 * 60 * 60 * 1000;

export function readStore(storeDir) {
  const manifestPath = path.join(storeDir, 'portions.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.schema !== STORE_SCHEMA || !Array.isArray(manifest.portions)) throw new Error('invalid portion store manifest: ' + manifestPath);
  return { manifestPath, manifest };
}

export function readLibrary(libraryDir) {
  if (!libraryDir) return new Map();
  const records = JSON.parse(fs.readFileSync(path.join(libraryDir, 'library.json'), 'utf8'));
  return new Map((records.portions ?? []).map((r) => [r.id, r]));
}

/**
 * One churn pass. `sourceDir` supplies refresh bytes (a library mirror with
 * files/<file>); when a superseded portion has no source, the refresh is
 * reported as deferred with its wall named, never faked.
 */
export function runChurnScan({ storeDir, libraryDir = null, sourceDir = null, staleDays = DEFAULT_STALE_DAYS, maxBytes = DEFAULT_MAX_BYTES, now = new Date(), log = (line) => console.log(line) } = {}) {
  const { manifestPath, manifest } = readStore(storeDir);
  const library = readLibrary(libraryDir);
  const filesDir = path.join(storeDir, 'files');
  const footprintOf = () => manifest.portions.reduce((sum, p) => sum + (fs.existsSync(path.join(filesDir, p.file)) ? fs.statSync(path.join(filesDir, p.file)).size : 0), 0);
  const footprintBefore = footprintOf();
  const verdicts = [];
  let refreshed = 0;
  let evicted = 0;
  const evict = (p, why) => {
    fs.rmSync(path.join(filesDir, p.file), { force: true });
    manifest.portions.splice(manifest.portions.indexOf(p), 1);
    evicted += 1;
    log(`churn-scan evicted portion=${p.id} why=${why}`);
  };

  // 1. Verify what is held.
  const failed = new Set();
  for (const p of [...manifest.portions]) {
    const file = path.join(filesDir, p.file);
    if (!fs.existsSync(file)) {
      failed.add(p.id);
      verdicts.push({ verdict: 'verification-failed', portion: p.id, detail: 'held portion file is missing' });
      log(`VERDICT verification-failed portion=${p.id} detail="held portion file is missing" — surfaced to the user, not repaired`);
      continue;
    }
    const digest = sha256File(file);
    if (digest !== p.sha256) {
      failed.add(p.id);
      verdicts.push({ verdict: 'verification-failed', portion: p.id, detail: `held bytes hash ${digest} does not match the store record ${p.sha256}` });
      log(`VERDICT verification-failed portion=${p.id} detail="held bytes do not match the store record" — surfaced to the user, not repaired`);
    }
    p._digest = digest;
  }

  // 2. Refresh what the library has superseded (never a failed portion).
  for (const p of [...manifest.portions]) {
    if (failed.has(p.id)) continue;
    const lib = library.get(p.id);
    if (!lib || lib.sha256 === p.sha256) continue;
    const source = sourceDir ? path.join(sourceDir, 'files', lib.file ?? p.file) : null;
    if (!source || !fs.existsSync(source)) {
      log(`churn-scan refresh-deferred portion=${p.id} wall="no refresh source supplied for the superseding bytes"`);
      continue;
    }
    const staged = path.join(filesDir, `.refresh-${p.id}`);
    fs.copyFileSync(source, staged);
    const digest = sha256File(staged);
    if (digest !== lib.sha256) {
      fs.rmSync(staged, { force: true });
      verdicts.push({ verdict: 'verification-failed', portion: p.id, detail: 'refresh source bytes do not match the library record; held bytes kept' });
      log(`VERDICT verification-failed portion=${p.id} detail="refresh source does not match the library record; held bytes kept" — surfaced to the user, not repaired`);
      failed.add(p.id);
      continue;
    }
    fs.renameSync(staged, path.join(filesDir, p.file));
    log(`churn-scan refreshed portion=${p.id} from=${p.sha256.slice(0, 12)} to=${lib.sha256.slice(0, 12)}`);
    p.sha256 = lib.sha256;
    p.size = fs.statSync(path.join(filesDir, p.file)).size;
    p.lastUsedAt = now.toISOString();
    refreshed += 1;
  }

  // 3a. Evict stale or unused (never a failed portion — its verdict stands).
  for (const p of [...manifest.portions]) {
    if (failed.has(p.id)) continue;
    const age = now.getTime() - Date.parse(p.lastUsedAt ?? p.pulledAt ?? 0);
    if (Number.isFinite(age) && age > staleDays * dayMs) evict(p, `stale: unused for over ${staleDays} days`);
  }
  // 3b. Enforce the footprint bound, least-recently-used first.
  const byRecency = () => [...manifest.portions].filter((p) => !failed.has(p.id)).sort((a, b) => Date.parse(a.lastUsedAt ?? a.pulledAt ?? 0) - Date.parse(b.lastUsedAt ?? b.pulledAt ?? 0));
  while (footprintOf() > maxBytes && byRecency().length) evict(byRecency()[0], `footprint bound ${maxBytes} bytes`);

  for (const p of manifest.portions) delete p._digest;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const footprintAfter = footprintOf();
  const held = manifest.portions.length;
  const summary = `churn-scan held=${held} refreshed=${refreshed} evicted=${evicted} verificationFailed=${failed.size} footprintBefore=${footprintBefore} footprintAfter=${footprintAfter}`;
  log(summary);
  return { schema: CHURN_SCHEMA, held, refreshed, evicted, verificationFailed: failed.size, verdicts, footprintBefore, footprintAfter, summary };
}

/**
 * The LIVE churn pass: the same Amendment-1 behaviors as runChurnScan, but
 * the verify/refresh legs consult the real Brain Library through this tree's
 * own streaming puller (../lib/brain-puller.mjs + the access layer in
 * ../lib/brain-library.mjs) instead of a fixture library directory. Portions
 * carrying library linkage (slug, part, range, catalog part hash at pull
 * time — written by streaming-binding.mjs's invokeStreamed) are:
 *   1. VERIFIED against the library: the same byte range is range-fetched
 *      with the held digest as the expected hash; a mismatch is a
 *      verification-failed VERDICT (surfaced, held bytes untouched).
 *   2. REFRESHED when the catalog's part hash has moved since the pull
 *      (supersession): the range is re-pulled through the puller and the
 *      new bytes replace the held bytes ONLY when the puller verified them
 *      (whole-part portions verify against the catalog part hash natively;
 *      partial portions need a hash-verified whole part on disk, supplied
 *      via verifiedPartPaths). UNVERIFIED refresh bytes are never accepted:
 *      the refresh is deferred with its wall named and the held bytes kept.
 * Eviction (stale, then footprint bound) is unchanged, and never touches a
 * portion whose verification failed or could not be completed this pass.
 * Without the puller in this tree the live pass fails closed and names the
 * wall; the offline fixture pass above remains for fixture stores.
 */
export async function runChurnScanLive({ storeDir, staleDays = DEFAULT_STALE_DAYS, maxBytes = DEFAULT_MAX_BYTES, now = new Date(), log = (line) => console.log(line), verifiedPartPaths = {} } = {}) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pullerPath = path.join(here, '..', 'lib', 'brain-puller.mjs');
  const accessPath = path.join(here, '..', 'lib', 'brain-library.mjs');
  if (!fs.existsSync(pullerPath) || !fs.existsSync(accessPath)) {
    throw Object.assign(new Error('WALL-STREAMING-LAYER-ABSENT: the live churn pass needs this tree\'s Brain Library puller (lib/brain-puller.mjs) and access layer (lib/brain-library.mjs); neither is present in this installation'), { code: 'STREAMING_LAYER_ABSENT' });
  }
  const puller = await import(pullerPath);
  const access = await import(accessPath);
  const { manifestPath, manifest } = readStore(storeDir);
  const filesDir = path.join(storeDir, 'files');
  const footprintOf = () => manifest.portions.reduce((sum, p) => sum + (fs.existsSync(path.join(filesDir, p.file)) ? fs.statSync(path.join(filesDir, p.file)).size : 0), 0);
  const footprintBefore = footprintOf();
  const verdicts = [];
  let refreshed = 0;
  let evicted = 0;
  const failed = new Set();
  const deferred = new Set();
  const evict = (p, why) => {
    fs.rmSync(path.join(filesDir, p.file), { force: true });
    manifest.portions.splice(manifest.portions.indexOf(p), 1);
    evicted += 1;
    log(`churn-scan evicted portion=${p.id} why=${why}`);
  };

  // The catalog is fetched once, before anything mutates: a library that
  // cannot be read aborts the pass with the store exactly as found.
  const catalog = await (await access.libraryFetchFile('library.json', {})).json();
  const models = new Map((catalog.models ?? []).map((m) => [m.slug, m]));
  const assetsByRelease = new Map();
  const assetsFor = async (release) => {
    if (!assetsByRelease.has(release)) assetsByRelease.set(release, await access.libraryReleaseAssets(release, {}));
    return assetsByRelease.get(release);
  };
  const partEntryOf = (p) => models.get(p.slug)?.weights?.parts?.find((x) => x.name === p.part) ?? null;

  // 1. Verify what is held — locally against the store record, then against
  // the library for linked portions.
  const superseded = new Set();
  for (const p of [...manifest.portions]) {
    const file = path.join(filesDir, p.file);
    if (!fs.existsSync(file)) {
      failed.add(p.id);
      verdicts.push({ verdict: 'verification-failed', portion: p.id, detail: 'held portion file is missing' });
      log(`VERDICT verification-failed portion=${p.id} detail="held portion file is missing" — surfaced to the user, not repaired`);
      continue;
    }
    const digest = sha256File(file);
    if (digest !== p.sha256) {
      failed.add(p.id);
      verdicts.push({ verdict: 'verification-failed', portion: p.id, detail: `held bytes hash ${digest} does not match the store record ${p.sha256}` });
      log(`VERDICT verification-failed portion=${p.id} detail="held bytes do not match the store record" — surfaced to the user, not repaired`);
      continue;
    }
    if (!p.slug || !p.part) continue; // no library linkage: the local record is the whole check
    const partEntry = partEntryOf(p);
    if (!partEntry) {
      failed.add(p.id);
      verdicts.push({ verdict: 'verification-failed', portion: p.id, detail: 'the library no longer carries this portion\'s part; held bytes kept as found' });
      log(`VERDICT verification-failed portion=${p.id} detail="the library no longer carries this portion's part; held bytes kept as found" — surfaced to the user, not repaired`);
      continue;
    }
    if (p.partSha256 && partEntry.sha256 !== p.partSha256) { superseded.add(p.id); continue; }
    try {
      const asset = (await assetsFor(models.get(p.slug).weights.release))[p.part];
      if (!asset) throw new Error(`the release carries no asset named ${p.part}`);
      await puller.fetchRange(asset, p.start, p.start + p.length - 1, { expectedSha256: p.sha256 });
    } catch (e) {
      if (e.code === 'SLICE_HASH_MISMATCH') {
        failed.add(p.id);
        verdicts.push({ verdict: 'verification-failed', portion: p.id, detail: 'the library\'s bytes at this portion\'s range no longer match the held bytes' });
        log(`VERDICT verification-failed portion=${p.id} detail="the library's bytes at this portion's range no longer match the held bytes" — surfaced to the user, not repaired`);
      } else {
        deferred.add(p.id);
        log(`churn-scan verification-deferred portion=${p.id} wall="${e.message}"`);
      }
    }
  }

  // 2. Refresh what the library has superseded (never a failed portion;
  // never with bytes the puller could not verify).
  for (const p of [...manifest.portions]) {
    if (failed.has(p.id) || !superseded.has(p.id)) continue;
    const model = models.get(p.slug);
    const partEntry = partEntryOf(p);
    try {
      const pullOpts = verifiedPartPaths[p.part] ? { verifiedPartPath: verifiedPartPaths[p.part] } : {};
      const pulled = await puller.pullPortion(model, { part: p.part, start: p.start, length: p.length }, pullOpts);
      if (pulled.verification === 'UNVERIFIED') {
        deferred.add(p.id);
        log(`churn-scan refresh-deferred portion=${p.id} wall="pulled bytes are UNVERIFIED against the catalog (the catalog publishes no per-slice hash); held bytes kept"`);
        continue;
      }
      const staged = path.join(filesDir, `.refresh-${p.id}`);
      fs.writeFileSync(staged, pulled.bytes);
      if (sha256File(staged) !== pulled.sha256) { fs.rmSync(staged, { force: true }); throw new Error('staged refresh bytes do not hash to the pulled digest; held bytes kept'); }
      const from = p.sha256;
      fs.renameSync(staged, path.join(filesDir, p.file));
      p.sha256 = pulled.sha256;
      p.size = pulled.bytes.length;
      p.partSha256 = partEntry.sha256;
      p.lastUsedAt = now.toISOString();
      refreshed += 1;
      log(`churn-scan refreshed portion=${p.id} from=${from.slice(0, 12)} to=${pulled.sha256.slice(0, 12)}`);
    } catch (e) {
      deferred.add(p.id);
      log(`churn-scan refresh-deferred portion=${p.id} wall="${e.message}"`);
    }
  }

  // 3a. Evict stale or unused (never a failed or unverifiable portion).
  for (const p of [...manifest.portions]) {
    if (failed.has(p.id) || deferred.has(p.id)) continue;
    const age = now.getTime() - Date.parse(p.lastUsedAt ?? p.pulledAt ?? 0);
    if (Number.isFinite(age) && age > staleDays * dayMs) evict(p, `stale: unused for over ${staleDays} days`);
  }
  // 3b. Enforce the footprint bound, least-recently-used first.
  const byRecency = () => [...manifest.portions].filter((p) => !failed.has(p.id) && !deferred.has(p.id)).sort((a, b) => Date.parse(a.lastUsedAt ?? a.pulledAt ?? 0) - Date.parse(b.lastUsedAt ?? b.pulledAt ?? 0));
  while (footprintOf() > maxBytes && byRecency().length) evict(byRecency()[0], `footprint bound ${maxBytes} bytes`);

  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const footprintAfter = footprintOf();
  const held = manifest.portions.length;
  const summary = `churn-scan held=${held} refreshed=${refreshed} evicted=${evicted} verificationFailed=${failed.size} footprintBefore=${footprintBefore} footprintAfter=${footprintAfter}`;
  log(summary);
  return { schema: CHURN_SCHEMA, mode: 'live', held, refreshed, evicted, verificationFailed: failed.size, verdicts, footprintBefore, footprintAfter, summary };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opt = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };
  const storeDir = opt('--store');
  if (!storeDir) { console.error('usage: churn-scan.mjs --store <portion-store> [--live] [--library <dir>] [--source <dir>] [--stale-days <n>] [--max-bytes <n>] [--verified-part <partName>=<path>]'); process.exit(2); }
  const common = {
    storeDir,
    staleDays: opt('--stale-days') ? Number(opt('--stale-days')) : undefined,
    maxBytes: opt('--max-bytes') ? Number(opt('--max-bytes')) : undefined,
  };
  if (process.argv.includes('--live')) {
    const verifiedPartPaths = {};
    for (let i = 0; i < process.argv.length; i += 1) {
      if (process.argv[i] === '--verified-part' && process.argv[i + 1]) {
        const eq = process.argv[i + 1].indexOf('=');
        if (eq > 0) verifiedPartPaths[process.argv[i + 1].slice(0, eq)] = process.argv[i + 1].slice(eq + 1);
      }
    }
    try {
      const result = await runChurnScanLive({ ...common, verifiedPartPaths });
      if (result.verificationFailed) process.exitCode = 3;
    } catch (e) {
      console.error(`churn-scan live pass failed closed: ${e.message}`);
      process.exitCode = 1;
    }
  } else {
    const result = runChurnScan({
      ...common,
      libraryDir: opt('--library'),
      sourceDir: opt('--source') || opt('--library'),
    });
    if (result.verificationFailed) process.exitCode = 3;
  }
}
