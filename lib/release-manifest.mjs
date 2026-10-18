// Kingmaker's release payload: Kingmaker.app (≈4 GB) as a tar.gz split into parts of at most 1.9 GB (GitHub release
// assets stop at 2 GiB), with a manifest that pins the sha256 of every part and of the whole archive, plus everything
// else the installer fetches: the official Ollama build, the official Homebrew package, and the models by their Ollama
// registry digests. scripts/release-parts.mjs builds it; installer/engine.sh consumes it (and verifies all of it).
//
// The manifest also ships INSIDE Kingmaker Installer.app, so the chain of trust is: the (signed, ideally notarized)
// installer → its embedded manifest → each part's sha256 → the whole archive's sha256 → the app's own code signature.

import { createHash } from 'node:crypto';
import { closeSync, createReadStream, existsSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { basename, join } from 'node:path';

export const MANIFEST_SCHEMA = 'kingmaker.release/1';
export const MANIFEST_FILE = 'kingmaker-manifest.json';
/** At most 1.9 GB (decimal) per part: under GitHub's 2 GiB asset limit with room to spare. */
export const MAX_PART_BYTES = 1_900_000_000;
export const DEFAULT_REPO = 'ronininc/Kingmaker';

/** Pure: the part file names for an archive ("Kingmaker-0.2.0.tar.gz.part01", …). */
export function partName(archive, index, count) {
  return `${archive}.part${String(index + 1).padStart(Math.max(2, String(count).length), '0')}`;
}

/**
 * Split a byte stream into parts of `partSize`, hashing each part and the whole as it streams (one pass, no temp
 * copy). With `outDir` null nothing is written (a dry run still yields every hash). Resolves
 * { size, sha256, parts: [{ index, size, sha256, file? }] }. Part files are written as `<name>.partNN.tmp` and
 * renamed only when complete, so an interrupted build never leaves a part that looks finished.
 */
export function splitStream(stream, { partSize = MAX_PART_BYTES, outDir = null, archive = 'archive.tar.gz' } = {}) {
  if (!Number.isInteger(partSize) || partSize < 1 || partSize > MAX_PART_BYTES) throw new Error(`part size must be 1…${MAX_PART_BYTES} bytes`);
  return new Promise((resolve, reject) => {
    const whole = createHash('sha256');
    const parts = [];
    let current = null;
    let total = 0;
    const open = () => {
      const index = parts.length;
      const tmp = outDir ? join(outDir, `${archive}.part${String(index + 1).padStart(2, '0')}.tmp`) : null;
      current = { index, size: 0, hash: createHash('sha256'), fd: tmp ? openSync(tmp, 'w', 0o644) : null, tmp };
      parts.push(current);
    };
    const close = () => {
      if (!current) return;
      if (current.fd !== null) closeSync(current.fd);
      current.sha256 = current.hash.digest('hex');
      delete current.hash;
      current = null;
    };
    stream.on('data', (chunk) => {
      try {
        whole.update(chunk);
        total += chunk.length;
        let at = 0;
        while (at < chunk.length) {
          if (!current || current.size === partSize) { close(); open(); }
          const take = Math.min(partSize - current.size, chunk.length - at);
          const piece = chunk.subarray(at, at + take);
          current.hash.update(piece);
          if (current.fd !== null) writeSync(current.fd, piece);
          current.size += take;
          at += take;
        }
      } catch (error) { stream.destroy(error); }
    });
    stream.once('error', (error) => { try { close(); } catch { /* already closed */ } reject(error); });
    stream.once('end', () => {
      try {
        close();
        if (!parts.length) throw new Error('the archive stream was empty');
        const count = parts.length;
        const out = parts.map((p) => {
          const name = partName(archive, p.index, count);
          if (outDir) {
            const file = join(outDir, name);
            renameSync(p.tmp, file);
            return { index: p.index, name, size: p.size, sha256: p.sha256, file };
          }
          return { index: p.index, name, size: p.size, sha256: p.sha256 };
        });
        resolve({ size: total, sha256: whole.digest('hex'), parts: out });
      } catch (error) { reject(error); }
    });
  });
}

/** sha256 of a file, streamed. */
export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file).on('data', (d) => hash.update(d)).once('error', reject).once('end', () => resolve(hash.digest('hex')));
  });
}

const HEX64 = /^[0-9a-f]{64}$/;

/** Pure: the manifest's own shape. → [] when it is sound, else the problems in words. */
export function manifestProblems(m) {
  const out = [];
  if (m?.schema !== MANIFEST_SCHEMA) out.push(`schema is ${m?.schema ?? 'missing'}, not ${MANIFEST_SCHEMA}`);
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(m?.repo ?? ''))) out.push('repo must be owner/name');
  if (!/^[\w.-]+$/.test(String(m?.tag ?? ''))) out.push('tag is missing');
  const app = m?.app ?? {};
  if (app.name !== 'Kingmaker.app') out.push('app.name must be Kingmaker.app');
  if (!HEX64.test(String(app.sha256 ?? ''))) out.push('app.sha256 is not a sha256');
  if (!Number.isSafeInteger(app.size) || app.size <= 0) out.push('app.size is missing');
  if (m?.engine !== undefined && !HEX64.test(String(m?.engine?.sha256 ?? ''))) out.push('engine.sha256 is not a sha256');
  const parts = Array.isArray(m?.parts) ? m.parts : [];
  if (!parts.length) out.push('no parts');
  let sum = 0;
  const names = new Set();
  for (const [i, p] of parts.entries()) {
    if (!/^[\w.-]+$/.test(String(p?.name ?? '')) || names.has(p.name)) out.push(`part ${i + 1} has a bad or repeated name`);
    names.add(p?.name);
    if (!HEX64.test(String(p?.sha256 ?? ''))) out.push(`part ${i + 1} has no sha256`);
    if (!Number.isSafeInteger(p?.size) || p.size <= 0 || p.size > MAX_PART_BYTES) out.push(`part ${i + 1} size ${p?.size} is outside 1…${MAX_PART_BYTES}`);
    sum += Number(p?.size) || 0;
  }
  if (parts.length && sum !== app.size) out.push(`the parts add up to ${sum} bytes, not the archive's ${app.size}`);
  for (const [i, model] of (m?.models ?? []).entries()) {
    if (!/^[\w./:-]+$/.test(String(model?.name ?? ''))) out.push(`model ${i + 1} has a bad name`);
    if (model?.digest !== null && !HEX64.test(String(model?.digest ?? ''))) out.push(`model ${i + 1} digest is not a sha256 (or null)`);
  }
  for (const key of ['ollama', 'homebrew', 'tailscale']) {
    const pin = m?.[key];
    if (pin && (!/^https:\/\//.test(String(pin.url ?? '')) || !HEX64.test(String(pin.sha256 ?? '')))) out.push(`${key} must have an https url and a sha256`);
  }
  out.push(...launcherProblems(m?.launcher, { required: false }));
  return out;
}

/** The Ronin Launcher pin (ronin-launcher app/dist/ronin-launcher-pin.json): installed with Kingmaker, required in
 *  every new release (buildManifest); an older release without one still reads. Its zip rides in the same release,
 *  so `url` may be null (the installer then takes `archive` from where the parts come from). */
export function launcherProblems(pin, { required }) {
  if (!pin) return required ? ['launcher is missing: the Ronin Launcher is a required part of a Kingmaker release'] : [];
  const out = [];
  if (pin.name !== 'Ronin Launcher.app') out.push('launcher.name must be Ronin Launcher.app');
  if (!/^[\w.-]+\.zip$/.test(String(pin.archive ?? ''))) out.push('launcher.archive must be a .zip name');
  if (pin.format !== 'zip') out.push('launcher.format must be zip');
  if (!HEX64.test(String(pin.sha256 ?? ''))) out.push('launcher.sha256 is not a sha256');
  if (!Number.isSafeInteger(pin.size) || pin.size <= 0 || pin.size > MAX_PART_BYTES) out.push('launcher.size is missing or too big');
  if (pin.url != null && !/^https:\/\//.test(String(pin.url))) out.push('launcher.url must be https (or null: same release)');
  if (pin.required !== true) out.push('launcher.required must be true');
  return out;
}

/**
 * Check a folder of parts against a manifest, the way the installer does: every part present, the right size and
 * sha256, and the parts in order hashing to the whole. → { ok, problems }.
 */
export async function verifyParts(manifest, dir) {
  const problems = manifestProblems(manifest);
  if (problems.length) return { ok: false, problems };
  const whole = createHash('sha256');
  for (const p of manifest.parts) {
    const file = join(dir, p.name);
    if (!existsSync(file)) { problems.push(`${p.name} is missing`); continue; }
    const size = statSync(file).size;
    if (size !== p.size) { problems.push(`${p.name} is ${size} bytes, not ${p.size}`); continue; }
    const hash = createHash('sha256');
    await new Promise((resolve, reject) => createReadStream(file).on('data', (d) => { hash.update(d); whole.update(d); }).once('error', reject).once('end', resolve));
    const got = hash.digest('hex');
    if (got !== p.sha256) problems.push(`${p.name} sha256 ${got.slice(0, 12)}… does not match ${p.sha256.slice(0, 12)}…`);
  }
  if (!problems.length) {
    const got = whole.digest('hex');
    if (got !== manifest.app.sha256) problems.push(`the whole archive hashes to ${got.slice(0, 12)}…, not ${manifest.app.sha256.slice(0, 12)}…`);
  }
  return { ok: problems.length === 0, problems };
}

/** Pure: `shasum -a 256 -c` lines for the parts and the manifest (what a person can check by hand). */
export function sha256sums(entries) {
  return `${entries.map((e) => `${e.sha256}  ${basename(e.name)}`).join('\n')}\n`;
}

/** The oldest macOS Kingmaker installs on: Ollama dropped 13 (0.12.4) and the voice server needs 14. Hands of Horus needs
 *  15 and is left out below it (BREW_TOOLS minMacos). Every declared minimum agrees (test/macos-minimum.test.mjs). */
export const MIN_MACOS = '14.0';

/** Pure: the manifest object. */
export function buildManifest({ version, tag, repo = DEFAULT_REPO, createdAt = new Date().toISOString(), app, archive, parts, partSize, ollama = null, homebrew = null, tailscale = null, models = [], brew = [], knowledge = null, searxng = null, requires = {}, packs = [], launcher = null, engineSha256 = null }) {
  const missing = launcherProblems(launcher, { required: true });
  if (missing.length) throw new Error(`the manifest would be unsound: ${missing.join('; ')}`);
  const manifest = {
    schema: MANIFEST_SCHEMA,
    product: 'Kingmaker',
    version,
    tag,
    repo,
    createdAt,
    app: { name: 'Kingmaker.app', bundleId: app.bundleId, version: app.version ?? version, solomonBuild: app.solomonBuild ?? null, signing: app.signing ?? null, archive: archive.name, format: 'tar+gzip', size: archive.size, sha256: archive.sha256, unpackedBytes: app.unpackedBytes ?? null },
    // The install/update engine's own sha256, inside the SIGNED manifest, so the installed app can authenticate the
    // engine it downloads BEFORE running it (lib/update.mjs) instead of trusting the unsigned latest.json. Null on an
    // older release that didn't pin it; the updater then falls back to the latest.json checksum with a warning.
    ...(engineSha256 ? { engine: { name: 'engine.sh', sha256: engineSha256 } } : {}),
    partSize,
    parts: parts.map((p) => ({ name: p.name, size: p.size, sha256: p.sha256 })),
    requires: { macos: requires.macos ?? MIN_MACOS, arch: requires.arch ?? 'arm64' },
    ollama,
    homebrew,
    // Tailscale's own official Mac package (Kingmaker Phone away from home): optional, pinned by sha256, fetched from
    // Tailscale by the installer, never redistributed. Null when a release doesn't carry it (phone stays home-Wi-Fi only).
    tailscale,
    // The Ronin Launcher, installed beside Kingmaker.app (required).
    launcher: { name: launcher.name, bundleId: launcher.bundleId, version: launcher.version, archive: launcher.archive, format: 'zip', url: launcher.url ?? null, size: launcher.size, sha256: launcher.sha256, required: true },
    models,
    brew,
    searxng,
    knowledge,
    // The profile packs (lib/mac-profiles.mjs): the installer's launcher shows them; engine.sh --pack installs one.
    ...(packs.length ? { packs } : {}),
  };
  const problems = manifestProblems(manifest);
  if (problems.length) throw new Error(`the manifest would be unsound: ${problems.join('; ')}`);
  return manifest;
}

/** Read and check a manifest file. */
export function readManifest(file) {
  const m = JSON.parse(readFileSync(file, 'utf8'));
  const problems = manifestProblems(m);
  if (problems.length) throw new Error(`${file}: ${problems.join('; ')}`);
  return m;
}

/** Remove a half-written release folder's temp parts (an interrupted build). */
export function cleanTempParts(dir) {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) if (f.endsWith('.tmp')) rmSync(join(dir, f), { force: true });
}

const macosParts = (v) => String(v ?? '0').split('.').map((n) => Number(n) || 0);
/** Pure: is macOS version a older than b? ('13.0' < '14.0', '14.6' > '14.0'). */
export const macosBelow = (a, b) => { const x = macosParts(a), y = macosParts(b); for (let i = 0; i < 3; i += 1) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0); return false; };

/**
 * Pure: why an installer built around this manifest must not ship ([] = it may). An installer is what a non-technical
 * owner downloads once; one that's stale, can't update or fails on a supported Mac can't be fixed from afar. (The v0.2.0
 * DMG shipped with no packs, no launcher pin, macOS 13 and no enrollment: every one of these was true of it.)
 *   pkgVersion  this checkout's package.json version: the manifest must be of the same Kingmaker
 *   enroll      { url, code }: what makes each installed Mac enroll for its own update key (build-installer.sh env)
 *   pin         the pinned Kingmaker Release certificate, or null when none is (undefined: not checked)
 */
export function shipProblems(manifest, { pkgVersion, enroll = null, minMacos = MIN_MACOS, pin = undefined } = {}) {
  const out = [], m = manifest ?? {};
  // pin: the Kingmaker Release certificate (lib/release-identity.mjs readPin). Without it every update makes owners
  // grant their permissions again. (undefined: not checked, for callers that don't know it.)
  if (pin === null) out.push('no Kingmaker Release certificate is pinned (node scripts/kingmaker-release-identity.mjs create): without one, every update would make owners grant their permissions again');
  if (!Array.isArray(m.packs) || !m.packs.length) out.push('it carries no packs (lib/mac-profiles.mjs PACKS), so the installer has nothing to offer for this Mac: rebuild it with scripts/release-parts.mjs');
  for (const p of launcherProblems(m.launcher, { required: true })) out.push(`its Ronin Launcher pin is not sound: ${p}`);
  if (!m.requires?.macos || macosBelow(m.requires.macos, minMacos)) out.push(`it declares macOS ${m.requires?.macos ?? '(none)'}, below Kingmaker's floor of ${minMacos}: a Mac on that would install, then fail`);
  for (const b of m.brew ?? []) if (/peekaboo/.test(b.formula ?? '') && !b.minMacos) out.push(`${b.formula} has no minMacos, so on macOS ${minMacos.split('.')[0]} its brew install fails the whole install`);
  if (pkgVersion && m.version !== pkgVersion) out.push(`it is Kingmaker ${m.version ?? '(no version)'}, but this checkout is ${pkgVersion}: rebuild it from the current app`);
  if (!enroll?.url || !enroll?.code) out.push('no update enrollment (KINGMAKER_ENROLL_URL and KINGMAKER_ENROLL_CODE): every Mac it installs would never get an update');
  else if (!/^https:\/\//.test(enroll.url)) out.push(`the enrollment address must be https:// (got ${String(enroll.url).slice(0, 80)})`);
  return out;
}
