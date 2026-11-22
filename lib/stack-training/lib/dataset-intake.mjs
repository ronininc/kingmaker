/**
 * lib/dataset-intake.mjs (training-data-pipeline)
 *
 * THE CAGE for datasets. Outside training data enters Kingmaker the same way
 * skills and models do: discovery → triage (SHA-256 + license recorded) →
 * scan → ingestion. This module is the triage gate. It registers a dataset
 * and produces the triage record every downstream decision cites:
 *
 *   { id, hfId, revision, files: [{ path, size, sha256 }],
 *     contentSha256, license, licenseClass, rowCount, schema, triagedAt }
 *
 * LICENSE DISCIPLINE IS LAW (Robbie, 2026-10-19):
 *   clear   — apache-2.0, mit, odc-by, cc-by (incl. cc-by-4.0), cc0,
 *             public-domain, bsd/isc-class permissive. Usable in every
 *             tier, including Solomon-bound corpora.
 *   flagged — any *-nc variant, sharegpt-style unclear provenance, agpl/gpl
 *             copyleft, or NO license stated. Never enters a Solomon corpus;
 *             the corpus builder excludes flagged sources from solomonSafe.
 *   unknown — the dataset card carries no metadata at all. Treated as
 *             flagged everywhere downstream: unknown is not a license.
 *
 * "Free to download" is not a license. A dataset we cannot classify does not
 * become 'clear' by being convenient.
 *
 * The downloader is INJECTED (interface below) — the real one is
 * tools/hf-download.py (huggingface_hub), tests use a fake. $0, local-first.
 *
 * Downloader interface:
 *   download(hfId, revision?) => Promise<{
 *     revision: string,            // resolved commit sha
 *     license: string|null,        // from the dataset card metadata
 *     files: [{ path, size, sha256, rowCount?, schema? }],
 *   }>
 */

import { createHash } from 'node:crypto';

function sha256(data) {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

const CLEAR_LICENSES = new Set([
  'apache-2.0', 'apache 2.0', 'mit', 'odc-by', 'odc-by-1.0',
  'cc-by', 'cc-by-4.0', 'cc-by-3.0', 'cc0', 'cc0-1.0', 'public-domain',
  'bsd-2-clause', 'bsd-3-clause', 'bsd', 'isc', 'unlicense', 'wtfpl',
]);

export function classifyLicense(rawLicense) {
  if (rawLicense === null || rawLicense === undefined || String(rawLicense).trim() === '') {
    return 'unknown';
  }
  const lic = String(rawLicense).trim().toLowerCase();
  if (lic === 'unknown' || lic === 'other' || lic === 'nolicense' || lic === 'none') {
    return 'unknown';
  }
  if (CLEAR_LICENSES.has(lic)) return 'clear';
  // Any explicit non-commercial term flags it, in any naming house style.
  if (/(^|[-_ ])nc([-_ ]|$)|non[- ]?commercial/.test(lic)) return 'flagged';
  // Copyleft family — obligations travel; flagged for tier decisions.
  if (/gpl|lgpl|agpl/.test(lic)) return 'flagged';
  // Anything else we do not positively recognise is NOT clear by default.
  return 'flagged';
}

/**
 * Register + triage one dataset through the injected downloader.
 * Returns the triage record. Throws if the downloader cannot produce files
 * with hashes — an unhashable dataset does not enter the pipeline.
 */
export async function registerDataset({ hfId, revision = null }, downloader, { now = () => new Date().toISOString() } = {}) {
  if (!hfId) throw new Error('dataset-intake: hfId is required');
  if (!downloader || typeof downloader.download !== 'function') {
    throw new Error('dataset-intake: a downloader with download(hfId, revision) is required');
  }
  const got = await downloader.download(hfId, revision);
  const files = (got.files ?? []).filter((f) => f && f.sha256);
  if (files.length === 0) {
    throw new Error(`dataset-intake: '${hfId}' produced no hashable files — refused at triage`);
  }
  // Content identity: one hash over the sorted per-file hashes.
  const contentSha256 = sha256(files.map((f) => `${f.path}:${f.sha256}`).sort().join('\n'));
  const dataFiles = files.filter((f) => typeof f.rowCount === 'number');
  const rowCount = dataFiles.length ? dataFiles.reduce((a, f) => a + f.rowCount, 0) : null;
  const schema = dataFiles.length ? [...new Set(dataFiles.flatMap((f) => f.schema ?? []))] : [];
  const licenseClass = classifyLicense(got.license);
  return {
    id: 'triage-' + sha256(`${hfId}@${got.revision ?? revision ?? ''}`).slice(0, 16),
    hfId,
    revision: got.revision ?? revision ?? null,
    files: files.map((f) => ({ path: f.path, size: f.size ?? null, sha256: f.sha256 })),
    contentSha256,
    license: got.license ?? null,
    licenseClass,
    rowCount,
    schema,
    triagedAt: now(),
  };
}

/**
 * Downloader backed by tools/hf-download.py (huggingface_hub) — the REAL
 * path. Kept as a factory so tests never touch it.
 */
export function pythonDownloader(pythonBin = 'python3', scriptPath) {
  if (!scriptPath) throw new Error('dataset-intake: pythonDownloader needs the hf-download.py path');
  return {
    async download(hfId, revision) {
      const { execFileSync } = await import('node:child_process');
      const args = [scriptPath, hfId];
      if (revision) args.push(revision);
      const out = execFileSync(pythonBin, args, { encoding: 'utf8', maxBuffer: 64 << 20 });
      const manifest = JSON.parse(out.trim().split('\n').pop());
      return {
        revision: manifest.revision,
        license: manifest.license,
        files: manifest.files,
      };
    },
  };
}

/** In-memory fake downloader for tests and dry runs. */
export function fakeDownloader(responses) {
  return {
    async download(hfId) {
      const r = responses[hfId];
      if (!r) throw new Error(`fake-downloader: no canned response for '${hfId}'`);
      return r;
    },
  };
}
