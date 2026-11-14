#!/usr/bin/env node
/**
 * census.mjs (kingmaker-stack)
 *
 * Byte census for the folded stack, written into stack-manifest.json.
 * The split that matters for the v0.4.1 disc problem:
 *
 *   CODE — lib/, tools/, tests/, plus root-level .mjs/.py entry
 *          scripts. This is what a payload ships.
 *   DATA — corpora, downloads, audit artifacts, archived model
 *          sources. This streams post-install; it never rides
 *          the payload.
 *   OTHER — docs (README / NOTICE / specs), manifests.
 *
 * Scope: the seventeen stack directories only. The ~18.5 GB knowledge
 * library and model weights live with the app/release, not in these
 * homes — they are data by the same rule and are already post-install
 * streams in the 4.1 design.
 *
 * Usage: node census.mjs   (rewrites the byteCensus section in place)
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const STACK_DIR = dirname(fileURLToPath(import.meta.url));
const WS = dirname(STACK_DIR);

const COMPONENTS = {
  'router-phase2': { home: 'router-phase2', dataDirs: {} },
  'littlebrother': { home: 'littlebrother', dataDirs: { audit: 'audit log artifact', tmp: 'solomon-bundle build output' } },
  'space-cell': { home: 'kingmaker-v041/space-cell', dataDirs: {} },
  'training-data-pipeline': { home: 'training-data-pipeline', dataDirs: { corpora: 'built corpora (train/eval JSONL)', intake: 'triage records + download metadata' } },
  'edge0-minicpm-augmentation': { home: 'edge0-minicpm-augmentation', dataDirs: { sources: 'archived model configs/cards (study evidence)' } },
  // The eleven absorbed components folded in 2026-10-20 live inside
  // this directory; each is its own census component, and the
  // kingmaker-stack walk below excludes their subtrees so nothing is
  // counted twice.
  'wordcraft': { home: 'kingmaker-stack/wordcraft', dataDirs: {} },
  'artemis': { home: 'kingmaker-stack/artemis', dataDirs: {} },
  'anatomy': { home: 'kingmaker-stack/anatomy', dataDirs: {} },
  'solidcraft': { home: 'kingmaker-stack/solidcraft', dataDirs: {} },
  'xerj': { home: 'kingmaker-stack/xerj', dataDirs: {} },
  'unsloth': { home: 'kingmaker-stack/unsloth', dataDirs: {} },
  'check-if-email-exists': { home: 'kingmaker-stack/check-if-email-exists', dataDirs: {} },
  'stop-slop': { home: 'kingmaker-stack/stop-slop', dataDirs: {} },
  'humanizer': { home: 'kingmaker-stack/humanizer', dataDirs: {} },
  'exifcleaner': { home: 'kingmaker-stack/exifcleaner', dataDirs: {} },
  'lazy-frames': { home: 'kingmaker-stack/lazy-frames', dataDirs: {} },
  'weight-synthesis': { home: 'kingmaker-stack/weight-synthesis', dataDirs: {} },
  'kingmaker-stack': { home: 'kingmaker-stack', dataDirs: {}, excludeDirs: new Set(['wordcraft', 'artemis', 'anatomy', 'solidcraft', 'xerj', 'unsloth', 'check-if-email-exists', 'stop-slop', 'humanizer', 'exifcleaner', 'lazy-frames', 'weight-synthesis']) },
};
const CODE_DIRS = new Set(['lib', 'tools', 'tests']);

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile()) out.push([p, statSync(p).size]);
  }
  return out;
}

const perComponent = {};
const totals = { codeBytes: 0, dataBytes: 0, otherBytes: 0 };
for (const [id, c] of Object.entries(COMPONENTS)) {
  const root = join(WS, c.home);
  let codeBytes = 0, dataBytes = 0, otherBytes = 0;
  const dataBreakdown = {};
  for (const [p, size] of walk(root)) {
    const rel = p.slice(root.length + 1);
    const top = rel.split('/')[0];
    if (c.excludeDirs && c.excludeDirs.has(top)) continue;
    if (CODE_DIRS.has(top) || (!rel.includes('/') && /\.(mjs|py)$/.test(rel))) codeBytes += size;
    else if (top in c.dataDirs) { dataBytes += size; dataBreakdown[top] = (dataBreakdown[top] ?? 0) + size; }
    else otherBytes += size;
  }
  perComponent[id] = {
    home: `~/workspace/${c.home}`, codeBytes, dataBytes, otherBytes,
    dataBreakdown: Object.fromEntries(Object.entries(dataBreakdown).map(([k, v]) => [k, { bytes: v, what: c.dataDirs[k] }])),
  };
  totals.codeBytes += codeBytes; totals.dataBytes += dataBytes; totals.otherBytes += otherBytes;
}

const manifestPath = join(STACK_DIR, 'stack-manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.byteCensus = {
  computedAt: new Date().toISOString(),
  tool: 'census.mjs (this file — counted in kingmaker-stack code bytes)',
  methodology: 'code = lib/ + tools/ + tests/ + root-level .mjs/.py entry scripts; data = corpora/downloads/audit artifacts/archived model sources per component (see dataBreakdown); other = docs and manifests. Exact file bytes, not disk blocks.',
  scopeNote: 'Census covers the seventeen stack directories (the original six homes plus the eleven absorbed components inside kingmaker-stack/). The ~18.5 GB knowledge library and model weights are not in these homes — they are data under the same rule and stream post-install in the v0.4.1 design.',
  payloadRule: 'The 4.1 payload ships CODE ONLY. Every data byte below streams post-install (library, corpora, models) or is a local artifact that never ships (audit logs, bundle build output, study sources).',
  components: perComponent,
  totals: { ...totals, allBytes: totals.codeBytes + totals.dataBytes + totals.otherBytes, stackCodeTotalBytes: totals.codeBytes },
};
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`census written: code=${totals.codeBytes} data=${totals.dataBytes} other=${totals.otherBytes}`);
