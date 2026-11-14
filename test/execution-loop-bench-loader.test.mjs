// test/execution-loop-bench-loader.test.mjs — loadBenchRecords' two source families.
// The bench writer (lib/model-bench.mjs runBench, behind `kingmaker models bench`) leaves a
// host catalog JSON (catalog/bench/<slug>.json) and NO jsonl; the loader must read it as
// evidence alongside bench_host.jsonl + eval_host.jsonl. Fixtures below are built in the
// writer's own shape; the granite numbers are the real 8 GB Mac run's (m3-8gb.json,
// 2026-11-14: tools twoStep 17/18, native 15/18, route 12/12, write 3/3, 29.6 tok/s,
// load 3.37 s, resident 2.16 GB).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBenchRecords, enrichRecords, pickSmallestSufficient } from '../lib/execution-loop.mjs';

const GRANITE = 'hf.co/mradermacher/Huihui-granite-4.1-3b-abliterated-i1-GGUF:i1-Q4_K_M';

/** A writer-shaped host catalog file (lib/model-bench.mjs's emission, fields the loader reads). */
const hostFile = (slug, results) => JSON.stringify({
  schema: 1, slug, host: { chip: 'Apple M3', ramGb: 8 }, simulated: null,
  context: 4096, maxResidentGb: 8, startedAt: '2026-11-14T08:43:26.000Z', results, finishedAt: '2026-11-14T09:02:00.000Z',
});
const graniteResult = {
  model: GRANITE, context: 4096, loadS: 3.37, resident: { sizeGb: 2.16 }, speed: { genTokS: 29.6 },
  tools: { twoStep: { pass: 17, of: 18, pct: 94 }, native: { pass: 15, of: 18, pct: 83 } },
  route: { pass: 12, of: 12, pct: 100 }, write: { pass: 3, of: 3, pct: 100 },
};

function benchDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'km-bench-loader-'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return { dir, url: new URL(`file://${dir}/`) };
}
const JSONL = {
  'bench_host.jsonl': [
    { model: 'qwen3:0.6b', gen_tok_s: 80, load_s: 1.5, resident: { size_gb: 0.81 } },
    { model: 'qwen3:0.6b', gen_tok_s: 100, load_s: 2.5, resident: { size_gb: 0.81 } },
    { model: 'huihui_ai/qwen3-abliterated:0.6b', gen_tok_s: 120, load_s: 0.8, resident: { size_gb: 0.68 } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n',
  'eval_host.jsonl': [
    { model: 'qwen3:0.6b', score: 5, of: 8 },
    { model: 'huihui_ai/qwen3-abliterated:0.6b', score: 5, of: 8 },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n',
};

test('jsonl-only directory: the legacy records are unchanged', async () => {
  const { dir, url } = benchDir(JSONL);
  try {
    const records = await loadBenchRecords({ benchDirUrl: url, listDir: async () => [] });
    const q = records.find((r) => r.model === 'qwen3:0.6b');
    assert.equal(q.genTokS, 100); // median of [80, 100] (upper median, the standing rule)
    assert.equal(q.loadS, 2.5);
    assert.equal(q.sizeGb, 0.81);
    assert.equal(q.evalShare, 0.625);
    assert.equal(q.benchFile, 'bench_host.jsonl');
    assert.equal(q.samples, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('catalog JSON: a writer-shaped host file becomes evidence records (default discovery)', async () => {
  const { dir, url } = benchDir({ ...JSONL, 'm3-8gb.json': hostFile('m3-8gb', [graniteResult]) });
  try {
    const records = await loadBenchRecords({ benchDirUrl: url });
    const g = records.find((r) => r.model === GRANITE);
    assert.ok(g, 'the granite the bench measured is in the evidence pool');
    assert.equal(g.genTokS, 29.6);
    assert.equal(g.loadS, 3.37);
    assert.equal(g.sizeGb, 2.16);
    assert.equal(g.evalShare, 47 / 51); // (17+15+12+3) / (18+18+12+3): the measured sections
    assert.equal(g.benchFile, 'm3-8gb.json');
    assert.equal(g.samples, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('catalog sections fill only the evaluation gap eval_host.jsonl leaves', async () => {
  const both = {
    model: 'huihui_ai/qwen3-abliterated:0.6b', context: 4096, loadS: 0.79,
    resident: { sizeGb: 0.89 }, speed: { genTokS: 135.8 },
    tools: { twoStep: { pass: 11, of: 18 } }, route: { pass: 7, of: 12 }, write: { pass: 3, of: 3 },
  };
  const { dir, url } = benchDir({ ...JSONL, 'm3-8gb.json': hostFile('m3-8gb', [both]) });
  try {
    const records = await loadBenchRecords({ benchDirUrl: url });
    const m = records.find((r) => r.model === 'huihui_ai/qwen3-abliterated:0.6b');
    assert.equal(m.evalShare, 0.625); // eval_host.jsonl's 5/8 stays authoritative, not the sections' 21/33
    assert.equal(m.benchFile, 'bench_host.jsonl'); // jsonl samples keep jsonl provenance
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('pooling: jsonl and catalog samples median together', async () => {
  const { dir, url } = benchDir({ ...JSONL, 'm9-8gb.json': hostFile('m9-8gb', [
    { model: 'qwen3:0.6b', context: 4096, loadS: 9, resident: { sizeGb: 0.9 }, speed: { genTokS: 300 } },
  ]) });
  try {
    const records = await loadBenchRecords({ benchDirUrl: url });
    const q = records.find((r) => r.model === 'qwen3:0.6b');
    assert.equal(q.samples, 3);
    assert.equal(q.genTokS, 100); // median of [80, 100, 300]
    assert.equal(q.sizeGb, 0.9); // the latest finite size reading wins
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('shape discipline: non-host JSON in the bench directory is never read as a bench', async () => {
  const { dir, url } = benchDir({
    ...JSONL,
    'conc_8gb.json': JSON.stringify({ models: ['qwen3:0.6b'], resident_after: {}, swap_delta_mb: 0, turns: [] }),
    'broken.json': '{ not json',
    'notes.json': JSON.stringify({ slug: 42, results: 'nope' }),
    'readme.txt': 'not a bench',
  });
  try {
    const records = await loadBenchRecords({ benchDirUrl: url });
    assert.deepEqual(records.map((r) => r.model).sort(), ['huihui_ai/qwen3-abliterated:0.6b', 'qwen3:0.6b']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('unmeasured results and empty sections contribute nothing', async () => {
  const { dir, url } = benchDir({
    'bench_host.jsonl': '', 'eval_host.jsonl': '',
    'm3-8gb.json': hostFile('m3-8gb', [
      { model: 'errored:model', error: 'load failed' },
      { model: 'thin:model', loadS: 1, resident: { sizeGb: 1 }, speed: { genTokS: 42 }, write: { pass: 0, of: 0 } },
    ]),
  });
  try {
    const records = await loadBenchRecords({ benchDirUrl: url });
    assert.deepEqual(records.map((r) => r.model), ['thin:model']);
    assert.equal(records[0].evalShare, null); // a 0-of section is no evaluation
    assert.equal(records[0].benchFile, 'm3-8gb.json');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the writer pick: catalog-fed measurement makes the floor writer the evidenced pick', async () => {
  const catalog = [{ tag: GRANITE, roles: ['writer', 'reasoning'], capabilities: null, downloadGb: 2.1 }];
  const device = { ramGb: 8, freeGb: 4.6 };
  const withBench = benchDir({ ...JSONL, 'm3-8gb.json': hostFile('m3-8gb', [graniteResult]) });
  const withoutBench = benchDir({ ...JSONL });
  try {
    const fed = enrichRecords(await loadBenchRecords({ benchDirUrl: withBench.url }), catalog);
    const pick = pickSmallestSufficient(fed, { requirement: { role: 'writer' }, device });
    assert.equal(pick.pick?.model, GRANITE);
    assert.equal(pick.pick.evidenced, true);
    assert.equal(pick.pick.evalShare, 47 / 51);
    assert.equal(pick.pick.delivery.strategy, 'resident');

    const starved = enrichRecords(await loadBenchRecords({ benchDirUrl: withoutBench.url, listDir: async () => [] }), catalog);
    const fallback = pickSmallestSufficient(starved, { requirement: { role: 'writer' }, device });
    assert.notEqual(fallback.pick?.model, GRANITE); // no record, no pick — the gap this fix closes
    assert.equal(fallback.pick?.evidenced, false); // the labeled unevidenced fallback, as before
  } finally {
    rmSync(withBench.dir, { recursive: true, force: true });
    rmSync(withoutBench.dir, { recursive: true, force: true });
  }
});
