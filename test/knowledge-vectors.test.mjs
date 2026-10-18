import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildVectorShard, buildVectorShards, vecShardFresh, vecShardPath, vecSearch, cosineTopN, normalizeVec, hybridSearchEnabled, provisionKnowledge, DEFAULT_EMBED_MODEL } from '../lib/knowledge.mjs';
import { rrfFuse } from '../lib/rrf.mjs';

// A deterministic fake embedder: a 27-dim bag-of-letters vector, so texts sharing words sit near each other. No network.
const ALPHA = 'abcdefghijklmnopqrstuvwxyz';
function fakeEmbed(texts) {
  return texts.map((t) => {
    const v = new Array(27).fill(0);
    for (const ch of String(t).toLowerCase()) { const i = ALPHA.indexOf(ch); v[i >= 0 ? i : 26] += 1; }
    return normalizeVec(v);
  });
}

function place() {
  const root = mkdtempSync(join(tmpdir(), 'km-vec-'));
  const extracted = join(root, 'extracted'), served = join(root, 'index');
  const writeField = (field, records) => {
    mkdirSync(join(extracted, field), { recursive: true });
    writeFileSync(join(extracted, field, 'extracted.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  };
  return { root, extracted, served, plan: { extracted, served }, writeField, jsonl: (f) => join(extracted, f, 'extracted.jsonl'), done: () => rmSync(root, { recursive: true, force: true }) };
}
const long = (s) => s.padEnd(40, ' ') + 'x'.repeat(5); // clear the indexer's text.length >= 40 filter

test('hybrid search is off unless the flag is set', () => {
  assert.equal(hybridSearchEnabled({}), false);
  assert.equal(hybridSearchEnabled({ KINGMAKER_HYBRID_SEARCH: '0' }), false);
  assert.equal(hybridSearchEnabled({ KINGMAKER_HYBRID_SEARCH: '1' }), true);
});

test('normalizeVec returns a unit vector (and leaves a zero vector alone)', () => {
  const v = normalizeVec([3, 4]);
  assert.ok(Math.abs(Math.hypot(v[0], v[1]) - 1) < 1e-6);
  assert.deepEqual([...normalizeVec([0, 0])], [0, 0]);
});

test('builds <field>.vec.db mirroring the FTS5 filter and chunk identity; records the embedder in meta', async () => {
  const p = place();
  try {
    p.writeField('law', [
      { field: 'law', sourceId: 'a', chunk: 0, text: long('contract offer and acceptance') },
      { field: 'law', sourceId: 'a', chunk: 1, text: long('tort negligence duty of care') },
      { field: 'law', sourceId: 'b', chunk: 0, text: 'too short' },            // < 40 chars → skipped, as FTS5 does
    ]);
    const vecDb = vecShardPath(p.served, 'law');
    const r = await buildVectorShard({ field: 'law', jsonl: p.jsonl('law'), vecDb, embed: fakeEmbed });
    assert.equal(r.rows, 2, 'the short chunk is skipped, exactly like the FTS5 indexer');
    assert.ok(existsSync(vecDb));
    const conn = new DatabaseSync(vecDb, { readOnly: true });
    const ids = conn.prepare('SELECT docId FROM vectors ORDER BY docId').all().map((x) => x.docId);
    assert.deepEqual(ids, ['a#0', 'a#1'], 'doc ids are `${sourceId}#${chunk}`');
    assert.equal(conn.prepare("SELECT v FROM meta WHERE k='model'").get().v, DEFAULT_EMBED_MODEL);
    assert.equal(conn.prepare("SELECT v FROM meta WHERE k='dim'").get().v, '27');
    conn.close();
  } finally { p.done(); }
});

test('the vector shard holds exactly the chunks a real FTS5 shard would (fusion alignment)', async () => {
  const p = place();
  try {
    const recs = [
      { field: 'f', sourceId: 's1', chunk: 0, text: long('alpha beta gamma delta') },
      { field: 'f', sourceId: 's1', chunk: 1, text: 'nope' },
      { field: 'f', sourceId: 's2', chunk: 0, text: long('epsilon zeta eta theta') },
    ];
    p.writeField('f', recs);
    await buildVectorShard({ field: 'f', jsonl: p.jsonl('f'), vecDb: vecShardPath(p.served, 'f'), embed: fakeEmbed });
    // Build an FTS5 shard the way solomon-index-knowledge.mjs does, with the same filter, and compare the chunk set.
    const fts = join(p.served, 'f.db');
    const db = new DatabaseSync(fts);
    db.exec("CREATE VIRTUAL TABLE chunks USING fts5(text, title, sourceId UNINDEXED, chunkNo UNINDEXED, refs UNINDEXED, tokenize='unicode61 remove_diacritics 2');");
    const ins = db.prepare('INSERT INTO chunks(text, title, sourceId, chunkNo, refs) VALUES (?, ?, ?, ?, ?)');
    for (const e of recs) { if (!e.text || e.text.length < 40) continue; ins.run(e.text, '', e.sourceId, e.chunk, '[]'); }
    const ftsIds = db.prepare('SELECT sourceId, chunkNo FROM chunks').all().map((r) => `${r.sourceId}#${r.chunkNo}`).sort();
    db.close();
    const vconn = new DatabaseSync(vecShardPath(p.served, 'f'), { readOnly: true });
    const vecIds = vconn.prepare('SELECT docId FROM vectors').all().map((r) => r.docId).sort();
    vconn.close();
    assert.deepEqual(vecIds, ftsIds, 'both shards index the same chunks under the same ids');
  } finally { p.done(); }
});

test('freshness: stale when the jsonl is newer, when empty, and when a different embedder built it', async () => {
  const p = place();
  try {
    p.writeField('g', [{ field: 'g', sourceId: 'a', chunk: 0, text: long('some indexable content here') }]);
    const vecDb = vecShardPath(p.served, 'g');
    await buildVectorShard({ field: 'g', jsonl: p.jsonl('g'), vecDb, embed: fakeEmbed });
    assert.equal(vecShardFresh(vecDb, p.jsonl('g')), true);
    assert.equal(vecShardFresh(vecDb, p.jsonl('g'), { model: 'bge-m3' }), false, 'a different embedder → not fresh');
    // Touch the jsonl into the future → stale.
    const future = Date.now() / 1000 + 1000;
    utimesSync(p.jsonl('g'), future, future);
    assert.equal(vecShardFresh(vecDb, p.jsonl('g')), false);
    // A rebuild is then performed. With the jsonl back in the past (the normal case), a second call is a no-op.
    assert.equal((await buildVectorShard({ field: 'g', jsonl: p.jsonl('g'), vecDb, embed: fakeEmbed })).rows, 1);
    const past = Date.now() / 1000 - 1000;
    utimesSync(p.jsonl('g'), past, past);
    assert.equal(vecShardFresh(vecDb, p.jsonl('g')), true);
    assert.equal((await buildVectorShard({ field: 'g', jsonl: p.jsonl('g'), vecDb, embed: fakeEmbed })).skipped, 'up-to-date');
  } finally { p.done(); }
});

test('a malformed non-empty line aborts the build and retains the previous shard', async () => {
  const p = place();
  try {
    mkdirSync(join(p.extracted, 'h'), { recursive: true });
    // First a clean build.
    writeFileSync(p.jsonl('h'), JSON.stringify({ field: 'h', sourceId: 'a', chunk: 0, text: long('first good content') }) + '\n');
    const vecDb = vecShardPath(p.served, 'h');
    await buildVectorShard({ field: 'h', jsonl: p.jsonl('h'), vecDb, embed: fakeEmbed });
    const before = new DatabaseSync(vecDb, { readOnly: true }); const n0 = before.prepare('SELECT count(*) n FROM vectors').get().n; before.close();
    // Now a malformed line (newer jsonl) must abort and keep the old shard, not leave a half-built one.
    const future = Date.now() / 1000 + 1000; utimesSync(p.jsonl('h'), future, future);
    writeFileSync(p.jsonl('h'), JSON.stringify({ field: 'h', sourceId: 'b', chunk: 0, text: long('second good content') }) + '\n{ this is not json\n');
    utimesSync(p.jsonl('h'), future, future);
    await assert.rejects(() => buildVectorShard({ field: 'h', jsonl: p.jsonl('h'), vecDb, embed: fakeEmbed }), /malformed JSON/);
    assert.equal(existsSync(vecDb + '.building'), false, 'no half-built shard left behind');
    const after = new DatabaseSync(vecDb, { readOnly: true }); const n1 = after.prepare('SELECT count(*) n FROM vectors').get().n; after.close();
    assert.equal(n1, n0, 'the previous shard is retained unchanged');
  } finally { p.done(); }
});

test('buildVectorShards loops fields and picks the embedder per field', async () => {
  const p = place();
  try {
    p.writeField('en', [{ field: 'en', sourceId: 'a', chunk: 0, text: long('english indexable content') }]);
    p.writeField('es', [{ field: 'es', sourceId: 'b', chunk: 0, text: long('contenido indexable aqui mismo') }]);
    const used = {};
    const embedderFor = (f) => (f === 'es' ? 'bge-m3' : DEFAULT_EMBED_MODEL);
    const embed = (texts) => { return fakeEmbed(texts); };
    const out = await buildVectorShards({ plan: p.plan, embed, embedderFor });
    assert.equal(out.length, 2);
    assert.ok(out.every((r) => r.rows === 1));
    const es = new DatabaseSync(vecShardPath(p.served, 'es'), { readOnly: true });
    assert.equal(es.prepare("SELECT v FROM meta WHERE k='model'").get().v, 'bge-m3', 'the Spanish field was embedded with bge-m3');
    es.close();
  } finally { p.done(); }
});

test('vecSearch ranks by cosine, and its ranking fuses with a keyword list via RRF', async () => {
  const p = place();
  try {
    p.writeField('k', [
      { field: 'k', sourceId: 'cat', chunk: 0, text: long('the cat sat on the warm mat') },
      { field: 'k', sourceId: 'dog', chunk: 0, text: long('a loyal dog ran across the park') },
      { field: 'k', sourceId: 'fish', chunk: 0, text: long('the fish swam deep in the sea') },
    ]);
    const vecDb = vecShardPath(p.served, 'k');
    await buildVectorShard({ field: 'k', jsonl: p.jsonl('k'), vecDb, embed: fakeEmbed });
    const [q] = fakeEmbed(['the cat sat on the warm mat']);
    const vec = vecSearch(vecDb, q, { n: 3 });
    assert.equal(vec[0].docId, 'cat#0', 'the nearest chunk to the query is the cat line');
    // Fuse with a keyword list that happens to rank dog first; RRF should still surface cat near the top.
    const keyword = ['dog#0', 'cat#0'];
    const fused = rrfFuse([keyword, vec.map((v) => v.docId)]);
    assert.ok(fused.slice(0, 2).some((r) => r.docId === 'cat#0'));
  } finally { p.done(); }
});

test('cosineTopN is pure and respects n', () => {
  const rows = [{ docId: 'x', vec: normalizeVec([1, 0]) }, { docId: 'y', vec: normalizeVec([0, 1]) }, { docId: 'z', vec: normalizeVec([1, 1]) }];
  const top = cosineTopN(rows, normalizeVec([1, 0]), 2);
  assert.equal(top.length, 2);
  assert.equal(top[0].docId, 'x');
});

// Drive provisionKnowledge with stubs: fake FTS stages that just drop a shard file, a fake provision + embedder.
function provisionRig() {
  const root = mkdtempSync(join(tmpdir(), 'km-prov-'));
  const served = join(root, 'index'), sources = join(root, 'sources'), extracted = join(root, 'extracted');
  const state = join(root, 'state'), logs = join(root, 'logs');
  for (const d of [served, sources, extracted, state, logs]) mkdirSync(d, { recursive: true });
  mkdirSync(join(extracted, 'law'), { recursive: true });
  writeFileSync(join(extracted, 'law', 'extracted.jsonl'), JSON.stringify({ field: 'law', sourceId: 'a', chunk: 0, text: 'contract offer and acceptance in common law'.padEnd(45) }) + '\n');
  const provision = {
    desktopKnowledgeEnv: () => ({ SOLOMON_INDEX_DIR: served, SOLOMON_CORPUS_DIR: sources, SOLOMON_EXTRACTED_DIR: extracted }),
    knowledgeStatus: () => ({ state: 'ABSENT' }),
  };
  // A fake FTS stage: "builds" the shard by dropping a file where the real indexer would.
  const run = async ({ env }) => { writeFileSync(join(env.SOLOMON_INDEX_DIR, 'law.db'), ''); return { code: 0, stoppedFor: null }; };
  const base = {
    paths: { state, logs, runtimeHome: root }, env: {}, load: async () => provision, run,
    scriptsDir: root, exists: () => true, reap: () => false, free: () => 500 * 1024 ** 3, floor: 20 * 1024 ** 3,
    embed: (texts) => fakeEmbed(texts),
  };
  return { root, served, base, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('provisionKnowledge builds vector shards after the FTS stages when the flag is on', async () => {
  const p = provisionRig();
  try {
    const r = await provisionKnowledge({ ...p.base, hybrid: true });
    assert.equal(r.vectors.state, 'built');
    assert.ok(r.vectors.rows >= 1);
    assert.ok(existsSync(vecShardPath(p.served, 'law')), 'law.vec.db was built beside law.db');
  } finally { p.done(); }
});

test('with the flag off, no vector build runs and buildVectors is never called', async () => {
  const p = provisionRig();
  try {
    let called = 0;
    const r = await provisionKnowledge({ ...p.base, hybrid: false, buildVectors: async () => { called++; return []; } });
    assert.equal(r.vectors.state, 'off');
    assert.equal(called, 0);
    assert.equal(existsSync(vecShardPath(p.served, 'law')), false);
  } finally { p.done(); }
});

test('the vector build defers during a meeting hold, same as the FTS stages', async () => {
  const p = provisionRig();
  try {
    const r = await provisionKnowledge({ ...p.base, hybrid: true, inMeeting: () => true });
    assert.equal(r.vectors.state, 'deferred');
    assert.equal(existsSync(vecShardPath(p.served, 'law')), false);
  } finally { p.done(); }
});

test('a failing embedder defers to a failed-vectors note but never fails the knowledge index', async () => {
  const p = provisionRig();
  try {
    const r = await provisionKnowledge({ ...p.base, hybrid: true, embed: async () => { throw new Error('no embedder'); } });
    assert.equal(r.vectors.state, 'failed');
    assert.match(r.vectors.reason, /no embedder/);
    assert.notEqual(r.state, 'failed', 'the FTS index still succeeded');
  } finally { p.done(); }
});
