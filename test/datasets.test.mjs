// GET /admin/datasets for the Ronin launcher (lib/datasets.mjs): the knowledge library, what Kingmaker learned, the
// connected CRM, with sizes, last sync and status; names, counts and times only. Uses are recorded under the same ids.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crmDatasetId, KNOWLEDGE_ID, listDatasets, memoryDatasetId, noteKnowledgeRun } from '../lib/datasets.mjs';
import { meterDataset, recordTo, resetMeter } from '../lib/token-meter.mjs';
import { readHistory } from '../lib/metrics-history.mjs';
import { createCompanion, lanIp } from '../lib/phone-companion.mjs';

const KEYS = ['bytes', 'connector', 'documents', 'error', 'id', 'items', 'lastSync', 'name', 'source', 'syncStatus'];

function fixture(t) {
  const state = mkdtempSync(join(tmpdir(), 'km-datasets-'));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const k = join(state, 'runtime', 'data', 'knowledge');
  for (const d of ['sources/law', 'sources/med', 'extracted/law', 'index']) mkdirSync(join(k, d), { recursive: true });
  writeFileSync(join(k, 'sources/law/a.txt'), 'x'.repeat(100)); writeFileSync(join(k, 'sources/med/b.txt'), 'y'.repeat(50)); writeFileSync(join(k, 'sources/med/c.txt'), 'z');
  writeFileSync(join(k, 'extracted/law/extracted.jsonl'), '{}\n');
  writeFileSync(join(k, 'index/law.db'), 'd'.repeat(10)); writeFileSync(join(k, 'index/med.db'), 'd');
  const when = new Date('2026-10-14T12:00:00.000Z');
  utimesSync(join(k, 'index/law.db'), when, when); utimesSync(join(k, 'index/med.db'), new Date('2026-10-13T00:00:00Z'), new Date('2026-10-13T00:00:00Z'));
  const p = join(state, 'personalization', 'acme');
  mkdirSync(join(p, 'daily'), { recursive: true });
  writeFileSync(join(p, 'memory.json'), JSON.stringify({ tenant: 'acme', preferences: { tone: { statement: 'SECRET PREF' }, length: {} }, candidates: {} }));
  writeFileSync(join(p, 'events.jsonl'), '{"text":"SECRET EVENT"}\n{}\n{}\n');
  writeFileSync(join(state, 'runtime', 'data', 'home-crm.json'), JSON.stringify({ url: 'https://agent:hunter2@crm.example.com/tenant/9?token=abc123', serverUrl: 'https://crm.example.com', connectedAt: '2026-10-01T00:00:00Z' }));
  return { state, k, when };
}

test('the list: knowledge library, learned memory and the CRM, with nothing secret and unknowns null', async (t) => {
  const { state, when } = fixture(t);
  const list = await listDatasets({ state, env: {}, settle: true });
  assert.deepEqual(list.map((d) => d.id), [KNOWLEDGE_ID, 'memory:acme', 'crm:crm.example.com']);
  for (const d of list) assert.deepEqual(Object.keys(d).sort(), KEYS);
  assert.deepEqual(list[0], { id: 'knowledge-library', name: 'Knowledge library', source: 'knowledge-library', connector: 'Kingmaker', items: 2, documents: 3, bytes: 100 + 50 + 1 + 3 + 10 + 1, lastSync: when.toISOString(), syncStatus: 'ok', error: null });
  assert.equal(list[1].source, 'memory'); assert.equal(list[1].items, 2); assert.equal(list[1].documents, 3); assert.ok(list[1].bytes > 0); assert.equal(list[1].syncStatus, 'ok');
  assert.deepEqual(list[2], { id: 'crm:crm.example.com', name: 'crm.example.com', source: 'crm', connector: 'CRM', items: null, documents: null, bytes: null, lastSync: null, syncStatus: 'ok', error: null });
  const all = JSON.stringify(list);
  for (const secret of ['SECRET', 'hunter2', 'agent', 'abc123', 'tenant/9', state, '/Users/']) assert.ok(!all.includes(secret), `no ${secret} in the list`);
});

test('the knowledge library\'s status: syncing while a build runs, error when it failed, paused, never', async (t) => {
  const { state, k } = fixture(t);
  writeFileSync(join(state, 'knowledge-job.json'), JSON.stringify({ pid: process.pid, stage: 'extract' }));
  assert.equal((await listDatasets({ state, env: {} }))[0].syncStatus, 'syncing');
  rmSync(join(state, 'knowledge-job.json'));
  noteKnowledgeRun(state, { state: 'failed', stage: 'extract', fields: 2 });
  let kl = (await listDatasets({ state, env: {} }))[0];
  assert.equal(kl.syncStatus, 'error'); assert.match(kl.error, /stopped at its extract step/);
  noteKnowledgeRun(state, { state: 'deferred-disk', stage: 'index' });
  kl = (await listDatasets({ state, env: {} }))[0];
  assert.equal(kl.syncStatus, 'ok'); assert.match(kl.error, /not enough free disk/);
  writeFileSync(join(state, 'knowledge-job.json'), JSON.stringify({ pid: 999999999 }));   // a dead job: not syncing
  assert.equal((await listDatasets({ state, env: {} }))[0].syncStatus, 'ok');
  rmSync(join(k, 'index'), { recursive: true }); rmSync(join(state, 'knowledge-last.json'));
  assert.equal((await listDatasets({ state, env: {} }))[0].syncStatus, 'never');
  rmSync(join(state, 'runtime'), { recursive: true }); rmSync(join(state, 'personalization'), { recursive: true });
  assert.deepEqual(await listDatasets({ state, env: {} }), [], 'nothing connected: an empty list');
});

test('uses are recorded under the same ids the list shows, and the history sums them', async (t) => {
  const { state } = fixture(t);
  t.after(resetMeter);
  recordTo(state);
  const crm = crmDatasetId(join(state, 'runtime'));
  meterDataset({ dataset: memoryDatasetId('acme'), model: 'qwen3:8b', lane: 'writer', kind: 'turn' });
  meterDataset({ dataset: crm, model: 'kingmaker', kind: 'job' });
  meterDataset({ dataset: crm, model: 'kingmaker', kind: 'tool' });
  const ids = new Set((await listDatasets({ state, env: {} })).map((d) => d.id));
  const h = readHistory(state, { from: new Date(Date.now() - 60_000), to: new Date(Date.now() + 60_000), bucket: 'hour' });
  assert.deepEqual(h.datasets.map((d) => [d.id, d.uses]), [[crm, 2], ['memory:acme', 1]]);
  for (const d of h.datasets) assert.ok(ids.has(d.id), `${d.id} is in /admin/datasets`);
});

test('GET /admin/datasets on the bridge: loopback only', { timeout: 60_000 }, async (t) => {
  const { state } = fixture(t);
  const companion = createCompanion({ state, port: 0, setupPort: 0, host: 'localhost', icon: null, onTurn: () => {} });
  t.after(() => companion.stop());
  const port = Number(new URL((await companion.start()).app).port), ca = readFileSync(join(state, 'phone-tls', 'ca.pem'));
  const get = (host) => new Promise((resolve, reject) => {
    const req = request({ host, port, path: '/admin/datasets', ca, agent: false }, (res) => { let d = ''; res.setEncoding('utf8'); res.on('data', (x) => { d += x; }); res.on('end', () => { let json = null; try { json = JSON.parse(d); } catch { /* 403 text */ } resolve({ status: res.statusCode, json }); }); });
    req.on('error', reject); req.end();
  });
  const r = await get('127.0.0.1');
  assert.equal(r.status, 200); assert.deepEqual(r.json.map((d) => d.id), [KNOWLEDGE_ID, 'memory:acme', 'crm:crm.example.com']);
  const ip = lanIp();
  if (ip !== '127.0.0.1') assert.equal((await get(ip)).status, 403);
});

test('the engine records its reads: learned memory into the writer, CRM skills and jobs, the knowledge build\'s result', () => {
  const cli = readFileSync(new URL('../lib/cli.mjs', import.meta.url), 'utf8');
  assert.match(cli, /if \(learned\) meterDataset\(\{ dataset: memoryDatasetId\(basename\(learning\.root\)\), model, lane: 'writer', kind: 'turn' \}\);/);
  assert.equal((cli.match(/brief: briefFor\(text\)/g) || []).length, 0, 'every writer turn names its model');
  assert.match(cli, /crmUse\('tool'\); await session\.runTurn\(ronin\.skillTurnText\(skill, text\)/);
  assert.match(cli, /\.then\(\(r\) => \{ if \(r\?\.ok\) crmUse\('job'\); return r; \}\)/);
  assert.match(cli, /noteKnowledgeRun\(paths\.state, r\);/);
});
