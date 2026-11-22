/**
 * lib/corpus-builder.mjs (training-data-pipeline)
 *
 * Merges harvester JSONL + intake triage records into per-agent corpora.
 *
 * Discipline carried through from intake (it is law, not decoration):
 *   - Dedup is by CONTENT HASH (normalized input+target) across every
 *     source — the same example arriving twice from two places is one row.
 *   - The train/eval split is deterministic and seeded: hash(contentHash +
 *     seed) < evalFraction → eval. Same seed, same split, forever, and the
 *     assignment does not depend on input order.
 *   - The manifest's solomonSafe is TRUE only when EVERY source's
 *     licenseClass is 'clear'. One flagged or unknown source and the whole
 *     corpus is marked unsafe for Solomon. Fleet exhaust counts as 'clear'
 *     (the owner's own operational data — no third-party license attaches).
 *
 * Manifest:
 *   { corpus, created, seed, evalFraction,
 *     sources: [{ type: 'dataset'|'exhaust', id, hfId?, license, licenseClass, rows }],
 *     licenses: [unique set], counts: { input, deduped, droppedDuplicates },
 *     splitCounts: { train, eval }, solomonSafe }
 *
 * Dataset rows are harmonized through per-dataset adapters into
 * { input, target } — glaive (system+chat) and xlam (query+tools→answers)
 * ship here; an unknown dataset must register an adapter or it is refused.
 * Local-first files, no network, no telemetry, $0.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

function sha256(data) {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

export function contentHashOf(input, target) {
  const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  return sha256(JSON.stringify([norm(input), norm(target)]));
}

/** Deterministic split: hash of (contentHash, seed) mapped to [0,1). */
export function splitFor(contentHash, seed, evalFraction) {
  const h = sha256(`${seed}:${contentHash}`);
  const v = parseInt(h.slice(0, 8), 16) / 0xffffffff;
  return v < evalFraction ? 'eval' : 'train';
}

/** Adapters: dataset row → { input, target }. Keyed by hfId. */
export const ADAPTERS = {
  'glaiveai/glaive-function-calling-v2': (row) => {
    const system = String(row.system ?? '');
    const chat = String(row.chat ?? '');
    const marker = 'ASSISTANT:';
    const idx = chat.indexOf(marker);
    const userPart = idx >= 0 ? chat.slice(0, idx).trim() : chat.trim();
    const asstPart = idx >= 0 ? chat.slice(idx + marker.length).trim() : '';
    return {
      input: [system, userPart].filter(Boolean).join('\n'),
      target: asstPart || chat.trim(),
    };
  },
  'Salesforce/xlam-function-calling-60k': (row) => {
    const tools = row.tools ? JSON.stringify(row.tools) : '';
    const query = String(row.query ?? '');
    const answers = row.answers != null ? JSON.stringify(row.answers) : '';
    return {
      input: [query, tools ? `Available tools: ${tools}` : ''].filter(Boolean).join('\n'),
      target: answers,
    };
  },
  /** Generic fallback: first plausible text fields. */
  '*': (row) => {
    const input = row.input ?? row.prompt ?? row.question ?? row.instruction ?? row.query ?? '';
    const target = row.output ?? row.response ?? row.answer ?? row.completion ?? row.target ?? '';
    return { input: String(input), target: String(target) };
  },
};

/**
 * Build a corpus.
 *   name            corpus name (directory + manifest id)
 *   outDir          directory corpus files land in (created)
 *   exhaustRuns     [{ id, records }] — harvester outputs (label filter applies)
 *   datasets        [{ triage, rows }] — triage record + adapter-ready rows
 *   includeLabels   harvest labels to include (default ['gold'])
 *   seed, evalFraction
 * Returns the manifest object (also written to outDir/manifest.json).
 */
export function buildCorpus({
  name,
  outDir,
  exhaustRuns = [],
  datasets = [],
  includeLabels = ['gold'],
  seed = 42,
  evalFraction = 0.1,
  now = () => new Date().toISOString(),
} = {}) {
  if (!name) throw new Error('corpus-builder: corpus name is required');
  if (!outDir) throw new Error('corpus-builder: outDir is required');
  const seen = new Map(); // contentHash -> record
  const sources = [];
  let inputCount = 0;
  let droppedDuplicates = 0;

  const add = (record) => {
    inputCount++;
    const h = contentHashOf(record.input, record.target);
    if (seen.has(h)) { droppedDuplicates++; return; }
    seen.set(h, { ...record, contentHash: h });
  };

  for (const run of exhaustRuns) {
    let rows = 0;
    for (const r of run.records ?? []) {
      if (!includeLabels.includes(r.label)) continue;
      rows++;
      add({
        id: r.id,
        source: { type: 'exhaust', run: run.id },
        input: r.input,
        target: JSON.stringify(r.decision ?? r.output ?? {}),
        label: r.label,
        provenance: r.provenance,
      });
    }
    sources.push({ type: 'exhaust', id: run.id, license: 'own-exhaust', licenseClass: 'clear', rows });
  }

  for (const ds of datasets) {
    const adapter = ADAPTERS[ds.triage.hfId] ?? ADAPTERS['*'];
    if (!adapter) throw new Error(`corpus-builder: no adapter for '${ds.triage.hfId}' — refusing unnamed harmonization`);
    let rows = 0;
    for (const row of ds.rows ?? []) {
      const { input, target } = adapter(row);
      if (!input || !target) continue;
      rows++;
      add({
        id: 'ds-' + sha256(`${ds.triage.id}:${rows}`).slice(0, 20),
        source: { type: 'dataset', triage: ds.triage.id, hfId: ds.triage.hfId },
        input,
        target,
        label: 'dataset',
        provenance: { dataset: ds.triage.hfId, triage: ds.triage.id, license: ds.triage.license, licenseClass: ds.triage.licenseClass },
      });
    }
    sources.push({
      type: 'dataset', id: ds.triage.id, hfId: ds.triage.hfId,
      license: ds.triage.license, licenseClass: ds.triage.licenseClass, rows,
    });
  }

  const train = [];
  const evalSet = [];
  for (const rec of seen.values()) {
    (splitFor(rec.contentHash, seed, evalFraction) === 'eval' ? evalSet : train).push(rec);
  }

  const licenses = [...new Set(sources.map((s) => s.license))];
  const solomonSafe = sources.length > 0 && sources.every((s) => s.licenseClass === 'clear');

  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}/train.jsonl`, train.map((r) => JSON.stringify(r)).join('\n') + (train.length ? '\n' : ''));
  writeFileSync(`${outDir}/eval.jsonl`, evalSet.map((r) => JSON.stringify(r)).join('\n') + (evalSet.length ? '\n' : ''));

  const manifest = {
    corpus: name,
    created: now(),
    seed,
    evalFraction,
    sources,
    licenses,
    counts: { input: inputCount, deduped: seen.size, droppedDuplicates },
    splitCounts: { train: train.length, eval: evalSet.length },
    solomonSafe,
  };
  writeFileSync(`${outDir}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
