// lib/brain-puller.mjs — the streaming puller for the Brain Library. Wired into the app path
// 2026-11-05 (fold-in item 2): lib/bench-cli.mjs `cmdLibrary pull` downloads every part through
// downloadPartResumable below (replacing the former whole-part downloadHashed fetch), and
// `cmdLibrary portion` drives pullPortion. Built 2026-11-05 against the VM verdict run's measurements
// (~/workspace/kingmaker-vm-verdict-run-2026-11-05/REPORT.md §B1/B2/D):
//   • GitHub's release backend serves byte ranges (HTTP 206 proven live at multiple offsets),
//     but the shipped access layer's smallest fetch unit was one whole part (up to 1.9 GB)
//     and a dropped stream restarted the part from byte 0.
// This module adds the three missing pieces:
//   1. RANGE FETCH — fetchRange(): an exact byte range of a release asset, through the same
//      access layer (asset API → 302 → signed URL; the Authorization header goes only to
//      api.github.com, the signed URL is fetched bare, exactly as the verdict run probed).
//   2. RESUME — downloadPartResumable(): a part lands segment by segment; per-part progress
//      is persisted (<dest>.pull.json), so an interrupted download resumes from the last
//      completed segment instead of byte 0. The assembled part is accepted only when its
//      SHA-256 equals the catalog's published part hash.
//   3. PORTION SEAM — pullPortion(): (brain slug, byte range | portion descriptor) → exactly
//      those bytes. This is the interface the weights-hunter daemon drives when Little
//      Brother's analysis selects the portions a task needs. The hunter selects; this pulls.
//      (No synthesis, no task identity here — separate items.)
// Integrity note: the catalog publishes SHA-256 per PART, not per slice, so a lone range
// can only be verified when the caller gives this module something external to check it
// against. fetchRange/pullPortion therefore state verification honestly in their result
// (`verification` field) instead of implying a check that did not happen:
//   • 'verified-expected-hash' — the caller supplied the expected SHA-256 of exactly
//     this slice (portion.expectedSha256 / opts.expectedSha256); a mismatch is REFUSED.
//   • 'verified-whole-part' — the slice was compared byte-for-byte against a whole part
//     on disk whose own SHA-256 was first checked against the catalog part hash
//     (opts.verifiedPartPath), or the portion IS the whole part and its received hash
//     matched the catalog part hash. A mismatch is REFUSED.
//   • 'UNVERIFIED' — neither was supplied: the returned sha256 is the hash OF THE BYTES
//     RECEIVED and nothing more. It proves the bytes hash to themselves, never that
//     they are the catalog's bytes; callers must not present it as a check.
// Any part assembled through downloadPartResumable is verified whole against the catalog
// hash before it is accepted. A 429 from GitHub is a hard stop (RATE_LIMITED) — never
// retried in a loop.

import { createHash } from 'node:crypto';
import {
  closeSync, existsSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync,
  truncateSync, writeFileSync, writeSync,
} from 'node:fs';
import { createReadStream } from 'node:fs';
import { libraryFetchFile, libraryReleaseAssets } from './brain-library.mjs';

export const DEFAULT_SEGMENT_BYTES = 8 * 1024 * 1024; // 8 MiB per range request while assembling a part

const sha256OfFile = async (path) => {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest('hex');
};
export const sha256OfBytes = (buf) => createHash('sha256').update(buf).digest('hex');

const rateLimited = (where) => Object.assign(new Error(`GitHub answered 429 (${where}); hard stop, not retried`), { code: 'RATE_LIMITED' });

/**
 * Step 1 of the asset dance: the asset API URL answers 302 to a signed
 * release-assets.githubusercontent.com URL. The signed URL needs no auth header (and must
 * never receive one). Returns the signed URL; throws when GitHub does not redirect.
 */
export async function resolveSignedUrl(asset, { fetchImpl = fetch } = {}) {
  const r = await fetchImpl(asset.url, { headers: asset.headers ?? {}, redirect: 'manual' });
  if (r.status === 429) throw rateLimited('asset API');
  if (r.status >= 300 && r.status < 400) {
    const loc = r.headers.get('location');
    if (loc) return loc;
  }
  throw new Error(`asset API answered ${r.status} without a signed-URL redirect; range fetch needs the redirect`);
}

/** One exact byte range [start, end] (inclusive) from an already-signed URL. */
export async function fetchRangeFromSignedUrl(signedUrl, start, end, { fetchImpl = fetch, signal } = {}) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) throw new Error(`bad range ${start}..${end}`);
  const r = await fetchImpl(signedUrl, { headers: { range: `bytes=${start}-${end}` }, signal });
  if (r.status === 429) throw rateLimited('signed URL');
  if (r.status !== 206) throw new Error(`range fetch answered ${r.status} (wanted 206) for bytes=${start}-${end}`);
  const bytes = Buffer.from(await r.arrayBuffer());
  const want = end - start + 1;
  if (bytes.length !== want) throw new Error(`range fetch moved ${bytes.length} bytes, wanted ${want}`);
  return { bytes, contentRange: r.headers.get('content-range'), total: Number((r.headers.get('content-range') ?? '').split('/')[1] ?? NaN) || null };
}

/**
 * An exact byte range of a release asset, through the access layer.
 * asset: { url, headers } as libraryReleaseAssets() returns.
 * Returns { bytes, sha256, total, verification }. `sha256` is always the hash of the
 * bytes received. `verification` is 'verified-expected-hash' when opts.expectedSha256
 * (the expected SHA-256 of exactly this slice) was supplied and matched — a mismatch
 * throws (code SLICE_HASH_MISMATCH) — and 'UNVERIFIED' when it was not supplied: the
 * bytes were checked against nothing external.
 */
export async function fetchRange(asset, start, end, opts = {}) {
  const signed = await resolveSignedUrl(asset, opts);
  const { bytes, contentRange, total } = await fetchRangeFromSignedUrl(signed, start, end, opts);
  const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange ?? '');
  if (!m || Number(m[1]) !== start || Number(m[2]) !== end) throw new Error(`Content-Range mismatch: got "${contentRange}", wanted bytes ${start}-${end}`);
  const digest = sha256OfBytes(bytes);
  if (opts.expectedSha256 !== undefined) {
    if (digest !== opts.expectedSha256) {
      throw Object.assign(
        new Error(`range bytes ${start}-${end} do not match the expected SHA-256 (got ${digest.slice(0, 12)}…, wanted ${String(opts.expectedSha256).slice(0, 12)}…); refused`),
        { code: 'SLICE_HASH_MISMATCH' },
      );
    }
    return { bytes, sha256: digest, total, verification: 'verified-expected-hash' };
  }
  return { bytes, sha256: digest, total, verification: 'UNVERIFIED' };
}

/**
 * Download one part to `dest`, resumably. Progress persists in `<dest>.pull.json`
 * ({ size, sha256, bytesDone }); partial bytes live in `<dest>.partial` and count only up
 * to the last completed segment. On entry an existing partial prefix is truncated to the
 * recorded bytesDone and re-hashed from disk, so the running digest always covers exactly
 * the accepted prefix; the part is renamed to `dest` only when the full SHA-256 equals
 * `expectedSha256` (the catalog's published part hash). A mismatch deletes both files.
 * opts: { expectedSize, expectedSha256, segmentBytes, fetchImpl, signal, onProgress }.
 * Returns { dest, bytesMoved (this call), resumedFrom, sha256, already }.
 */
export async function downloadPartResumable(asset, dest, {
  expectedSize, expectedSha256, segmentBytes = DEFAULT_SEGMENT_BYTES, fetchImpl = fetch, signal, onProgress,
} = {}) {
  if (!expectedSize || !expectedSha256) throw new Error('downloadPartResumable needs expectedSize and expectedSha256 (the catalog part entry)');
  if (existsSync(dest)) {
    const got = await sha256OfFile(dest);
    if (got === expectedSha256 && statSync(dest).size === expectedSize) return { dest, bytesMoved: 0, resumedFrom: expectedSize, sha256: got, already: true };
    rmSync(dest, { force: true });
  }
  const partial = `${dest}.partial`, statePath = `${dest}.pull.json`;
  let bytesDone = 0;
  if (existsSync(partial) && existsSync(statePath)) {
    try {
      const st = JSON.parse(readFileSync(statePath, 'utf8'));
      if (st.size === expectedSize && st.sha256 === expectedSha256 && Number.isInteger(st.bytesDone)) {
        bytesDone = Math.min(st.bytesDone, statSync(partial).size);
      }
    } catch { bytesDone = 0; }
  }
  const resumedFrom = bytesDone;
  const fd = openSync(partial, existsSync(partial) ? 'r+' : 'w');
  try {
    truncateSync(partial, bytesDone);
    // Rebuild the running digest over the accepted prefix (local read; moves no network bytes).
    const h = createHash('sha256');
    if (bytesDone > 0) {
      for await (const chunk of createReadStream(partial, { start: 0, end: bytesDone - 1 })) h.update(chunk);
    }
    let bytesMoved = 0;
    while (bytesDone < expectedSize) {
      if (signal?.aborted) throw Object.assign(new Error('download aborted'), { code: 'ABORTED', bytesDone });
      const end = Math.min(bytesDone + segmentBytes, expectedSize) - 1;
      const { bytes } = await fetchRange(asset, bytesDone, end, { fetchImpl, signal });
      writeSync(fd, bytes, 0, bytes.length, bytesDone);
      h.update(bytes);
      bytesDone += bytes.length; bytesMoved += bytes.length;
      writeFileSync(statePath, JSON.stringify({ size: expectedSize, sha256: expectedSha256, bytesDone }));
      onProgress?.({ bytesDone, bytesMoved, resumedFrom });
    }
    const digest = h.digest('hex');
    if (digest !== expectedSha256) {
      rmSync(partial, { force: true }); rmSync(statePath, { force: true });
      throw new Error(`assembled part does not match its catalog SHA-256 (got ${digest.slice(0, 12)}…, wanted ${expectedSha256.slice(0, 12)}…); deleted`);
    }
    closeSync(fd);
    renameSync(partial, dest);
    rmSync(statePath, { force: true });
    return { dest, bytesMoved, resumedFrom, sha256: digest, already: false };
  } catch (e) {
    try { closeSync(fd); } catch { /* already closed */ }
    throw e;
  }
}

/** The catalog model for a slug (or tag), via the access layer. Throws for pointers (no weights in the repo). */
export async function resolveBrain(slug, opts = {}) {
  const r = await libraryFetchFile('library.json', opts);
  const lib = await r.json();
  const m = (lib.models ?? []).find((x) => x.slug === slug || x.tag === slug);
  if (!m) throw new Error(`the library has no model "${slug}"`);
  if (!m.weights) throw new Error(`${m.tag} has no weights in the library (pointer model; nothing to pull portions from)`);
  return m;
}

/**
 * THE PORTION SEAM. Pull exactly the bytes a portion descriptor names — nothing more moves.
 *   portion: { part: <index|name>, start, length }            (byte range inside one part)
 *         or { part: <index|name>, startFraction, lengthFraction }  (of that part's size)
 * `model` may be a catalog model object (with .weights) or a slug resolved via resolveBrain.
 * Returns { slug, part, start, length, bytes, sha256, bytesMoved, verification }.
 * Verification (see the header integrity note): the catalog publishes no per-slice hash,
 * so a lone portion is verified only when the caller supplies a check —
 * portion.expectedSha256 / opts.expectedSha256 (expected SHA-256 of this slice), or
 * opts.verifiedPartPath (a whole part on disk; it is itself hash-checked against the
 * catalog part hash first, then the slice is compared byte-for-byte). A portion that
 * covers the whole part is verified against the catalog part hash. Anything else
 * returns verification: 'UNVERIFIED' — the sha256 is of the bytes received only.
 */
export async function pullPortion(model, portion, opts = {}) {
  const m = typeof model === 'string' ? await resolveBrain(model, opts) : model;
  const w = m?.weights;
  if (!w?.parts?.length) throw new Error('pullPortion needs a model with weights.parts (the catalog entry)');
  const part = typeof portion?.part === 'number' ? w.parts[portion.part] : w.parts.find((p) => p.name === portion?.part) ?? w.parts[portion?.part ?? 0];
  if (!part) throw new Error(`no part "${portion?.part}" in ${m.slug}'s weights`);
  let { start, length } = portion ?? {};
  if (start === undefined && portion?.startFraction !== undefined) start = Math.floor(part.size * portion.startFraction);
  if (length === undefined && portion?.lengthFraction !== undefined) length = Math.floor(part.size * portion.lengthFraction);
  if (!Number.isInteger(start) || !Number.isInteger(length) || start < 0 || length <= 0 || start + length > part.size) {
    throw new Error(`portion out of bounds for ${part.name} (${part.size} B): start=${start} length=${length}`);
  }
  const assets = await libraryReleaseAssets(w.release, opts);
  const asset = assets[part.name];
  if (!asset) throw new Error(`the release ${w.release} has no asset named ${part.name}`);
  // A caller-named whole part on disk is only a verification reference once IT
  // has been verified: size + SHA-256 must equal the catalog part entry, or
  // the reference itself is refused before any bytes move.
  let verifiedPartPath = null;
  if (opts.verifiedPartPath) {
    if (!existsSync(opts.verifiedPartPath) || statSync(opts.verifiedPartPath).size !== part.size
      || (await sha256OfFile(opts.verifiedPartPath)) !== part.sha256) {
      throw new Error(`verifiedPartPath ${opts.verifiedPartPath} is not the catalog part ${part.name} (size/SHA-256 mismatch); refusing to verify against it`);
    }
    verifiedPartPath = opts.verifiedPartPath;
  }
  const expectedSha256 = portion?.expectedSha256 ?? opts.expectedSha256;
  const { bytes, sha256, verification } = await fetchRange(asset, start, start + length - 1, { ...opts, expectedSha256 });
  let verified = verification;
  if (verifiedPartPath) {
    const fd = openSync(verifiedPartPath, 'r');
    let local;
    try {
      local = Buffer.alloc(length);
      if (readSync(fd, local, 0, length, start) !== length) throw new Error(`could not read the portion range from ${verifiedPartPath}`);
    } finally { closeSync(fd); }
    if (!bytes.equals(local)) {
      throw Object.assign(new Error(`portion bytes for ${part.name} ${start}..${start + length - 1} do not match the hash-verified whole part on disk; refused`), { code: 'SLICE_HASH_MISMATCH' });
    }
    verified = 'verified-whole-part';
  } else if (expectedSha256 === undefined && start === 0 && length === part.size) {
    // The portion IS the whole part: the catalog part hash covers it exactly.
    if (sha256 !== part.sha256) {
      throw Object.assign(new Error(`whole-part portion of ${part.name} does not match its catalog SHA-256 (got ${sha256.slice(0, 12)}…, wanted ${part.sha256.slice(0, 12)}…); refused`), { code: 'SLICE_HASH_MISMATCH' });
    }
    verified = 'verified-whole-part';
  }
  return { slug: m.slug, part: part.name, start, length, bytes, sha256, bytesMoved: bytes.length, verification: verified };
}
