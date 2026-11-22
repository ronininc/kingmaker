#!/usr/bin/env node
/**
 * tools/build-tool-use-brains.mjs (training-data-pipeline)
 *
 * Builds the first corpus, 'tool-use-brains', from the two intake datasets:
 *   - glaiveai/glaive-function-calling-v2 — downloaded + hash-verified via
 *     tools/hf-download.py (huggingface_hub). Registered through the normal
 *     intake path (pythonDownloader).
 *   - Salesforce/xlam-function-calling-60k (APIGen) — repo is GATED (401
 *     unauthenticated). Card metadata claims cc-by-4.0, but a license we
 *     cannot verify against downloaded bytes does not earn 'clear':
 *     triaged metadata-only as licenseClass 'unknown' and EXCLUDED from
 *     the corpus build until the gate is accepted and the download lands.
 *
 * Output: corpora/tool-use-brains/{train.jsonl, eval.jsonl, manifest.json}
 * and intake/triage-records.json. No telemetry.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { registerDataset, pythonDownloader } from '../lib/dataset-intake.mjs';
import { buildCorpus } from '../lib/corpus-builder.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const downloader = pythonDownloader('python3', join(root, 'tools/hf-download.py'));

// 1. Glaive — the real, verified path.
const glaiveTriage = await registerDataset({ hfId: 'glaiveai/glaive-function-calling-v2' }, downloader);
console.error(`glaive triage: license=${glaiveTriage.license} class=${glaiveTriage.licenseClass} rows=${glaiveTriage.rowCount}`);

// Load glaive rows from the snapshot the downloader just produced.
const dlManifest = JSON.parse(readFileSync(join(root, 'intake/glaive-download.json'), 'utf8'));
const glaiveJsonPath = join(dlManifest.repoDir, 'glaive-function-calling-v2.json');
const glaiveRows = JSON.parse(readFileSync(glaiveJsonPath, 'utf8'));
console.error(`glaive rows loaded: ${glaiveRows.length}`);

// 2. XLAM — metadata-only triage (gated repo; see header).
const xlamTriage = {
  id: 'triage-xlam-metadata-only',
  hfId: 'Salesforce/xlam-function-calling-60k',
  revision: '26d14ebfe18b1f7b524bd39b404b50af5dc97866',
  files: [],
  contentSha256: null,
  license: 'cc-by-4.0',
  licenseClass: 'unknown',
  rowCount: null,
  schema: [],
  triagedAt: new Date().toISOString(),
  note: 'Repo is gated on HF (401 unauthenticated, verified 2026-10-19). License is the dataset card claim only — no downloaded bytes to hash. Excluded from corpora until the gate is accepted and the download verifies.',
};

writeFileSync(join(root, 'intake/triage-records.json'), JSON.stringify([glaiveTriage, xlamTriage], null, 2) + '\n');

// 3. Build the corpus from verified sources only.
const manifest = buildCorpus({
  name: 'tool-use-brains',
  outDir: join(root, 'corpora/tool-use-brains'),
  datasets: [{ triage: glaiveTriage, rows: glaiveRows }],
  seed: 42,
  evalFraction: 0.1,
});

console.log(JSON.stringify(manifest, null, 2));
