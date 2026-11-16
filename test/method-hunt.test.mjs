// Local-brain methods: the method hunt, the device-local store, offline reuse and chaining.
// A fixture Brain Library repo (the real intelligence/methods layout) is served on loopback, so the
// hunt's real fetch, pin, parse, Armor and filing path runs — no internet, no model (stub reasoner).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecutionLoop } from '../lib/execution-loop.mjs';
import { huntMethod } from '../lib/weight-hunter.mjs';

const methodFile = (id, title, domain, preamble, input = 'prompt') => `# Method — ${title}\n\nFixture method for the hunt tests.\n\n\`\`\`kingmaker-method\n${JSON.stringify({
  id, version: '1.0', title, domain, inputs: { [input]: '' }, weights: { role: 'writer' },
  steps: [
    { n: 1, id: 'plan', type: 'note', text: `${title}: follow the procedure.` },
    { n: 2, id: 'solve', type: 'reason', into: 'answer', preamble, prompt: `{{inputs.${input}}}` },
    { n: 3, id: 'record', type: 'write-json', path: 'result.json', value: { method: id, answer: '{{answer}}' } },
    { n: 4, id: 'check', type: 'verify', assertions: [{ file: 'result.json', field: 'method', equals: id }] },
  ],
}, null, 2)}\n\`\`\`\n`;

function fixtureRepo(methods, { tamper = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'km-hunt-repo-'));
  const dir = join(root, 'intelligence', 'methods'); mkdirSync(dir, { recursive: true });
  const index = { schema: 'kingmaker.methods/1', methods: [] };
  for (const m of methods) {
    const text = methodFile(m.id, m.title, m.domain, m.preamble, m.input);
    const buf = Buffer.from(text);
    writeFileSync(join(dir, `${m.id}.method.md`), tamper === m.id ? Buffer.from(text.replace('procedure', 'pr0cedure')) : buf);
    index.methods.push({ id: m.id, title: m.title, domain: m.domain, file: `${m.id}.method.md`, size: buf.length, sha256: createHash('sha256').update(buf).digest('hex'), quality: { tier: 'vetted', score: 80, basis: 'fixture' } });
  }
  writeFileSync(join(dir, 'index.json'), JSON.stringify(index));
  return root;
}

async function serve(root) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    const f = join(root, decodeURIComponent(req.url.split('?')[0]));
    if (!f.startsWith(root) || !existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200); res.end(readFileSync(f));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, hits, close: () => new Promise((r) => server.close(r)) };
}

const METHODS = [
  { id: 'tide-pool-census', title: 'Tide pool census', domain: 'tidepool', preamble: 'Count each species listed. Report totals.' },
  { id: 'species-summary-report', title: 'Species summary report', domain: 'summary', preamble: 'Write a one-line report from the totals.', input: 'totals' },
];
const reasoner = async ({ prompt, preamble, model }) => `[${model}] ${preamble.split('.')[0]} :: ${prompt}`;
const loopFor = (store, baseUrl, extra = {}) => createExecutionLoop({ methodStore: store, remote: { baseUrl }, reasoner, sandboxPosture: false, capacity: { cores: 1, freeMemMb: 256 }, ...extra });

test('a missing method is hunted from the configured source once, verified, filed locally, then reused with no network', async () => {
  const repo = fixtureRepo(METHODS); const srv = await serve(repo);
  const store = mkdtempSync(join(tmpdir(), 'km-store-')); const work = mkdtempSync(join(tmpdir(), 'km-work-'));
  try {
    const first = await loopFor(store, srv.baseUrl).run('run a tide pool census: 3 crabs, 2 anemones', { workDir: join(work, 'a'), inputs: { prompt: '3 crabs, 2 anemones' } });
    assert.equal(first.refused, false, JSON.stringify(first.reason ?? first.unblock));
    const huntPhase = first.trace.find((t) => t.phase === 'method-hunt');
    assert.equal(huntPhase.status, 'executed'); assert.equal(huntPhase.result.id, 'tide-pool-census');
    assert.equal(first.conduction.status, 'completed'); assert.match(first.conduction.outputs.answer, /3 crabs/);
    assert.deepEqual(srv.hits, ['/intelligence/methods/index.json', '/intelligence/methods/tide-pool-census.method.md'], 'index + the ONE method file');
    assert(existsSync(join(store, 'tide-pool-census.method.md')));
    const receipt = JSON.parse(readFileSync(join(store, 'acquired.jsonl'), 'utf8').trim());
    assert.equal(receipt.armor.verdict, 'pass'); assert.match(receipt.sha256, /^[a-f0-9]{64}$/);

    srv.hits.length = 0;
    const again = await loopFor(store, srv.baseUrl).run('tide pool census for 5 starfish', { workDir: join(work, 'b'), inputs: { prompt: '5 starfish' } });
    assert.equal(again.conduction.status, 'completed'); assert.match(again.conduction.outputs.answer, /5 starfish/);
    assert.equal(again.trace.some((t) => t.phase === 'method-hunt'), false, 'covered locally: no hunt');
    assert.deepEqual(srv.hits, [], 'reuse makes no network request');
  } finally { await srv.close(); for (const d of [repo, store, work]) rmSync(d, { recursive: true, force: true }); }
});

test('offline (remote off) with the method cached: runs; with it missing: refuses naming exactly what is missing', async () => {
  const repo = fixtureRepo(METHODS); const srv = await serve(repo);
  const store = mkdtempSync(join(tmpdir(), 'km-store-')); const work = mkdtempSync(join(tmpdir(), 'km-work-'));
  try {
    await loopFor(store, srv.baseUrl).run('tide pool census: 1 crab', { workDir: join(work, 'warm'), inputs: { prompt: '1 crab' } });
    srv.hits.length = 0;
    const offline = createExecutionLoop({ methodStore: store, remote: false, reasoner, sandboxPosture: false, capacity: { cores: 1, freeMemMb: 256 } });
    const ok = await offline.run('tide pool census: 4 urchins', { workDir: join(work, 'off-ok'), inputs: { prompt: '4 urchins' } });
    assert.equal(ok.conduction.status, 'completed');
    const miss = await offline.run('species summary report from totals', { workDir: join(work, 'off-miss'), inputs: { totals: 'x' } });
    assert.equal(miss.refused, true); assert.equal(miss.reason, 'no-method-coverage');
    assert.equal(miss.hunt.status, 'missing'); assert.match(miss.unblock, /remote method retrieval is off/);
    assert.deepEqual(srv.hits, [], 'offline makes no request');
  } finally { await srv.close(); for (const d of [repo, store, work]) rmSync(d, { recursive: true, force: true }); }
});

test('an unreachable source is reported as missing, never substituted', async () => {
  const store = mkdtempSync(join(tmpdir(), 'km-store-'));
  try {
    const r = await huntMethod({ request: 'tide pool census', storeDir: store, remote: { baseUrl: 'http://127.0.0.1:9' }, timeoutMs: 2000 });
    assert.equal(r.status, 'missing'); assert.equal(r.offline, true); assert.match(r.reason, /could not be read/);
    assert.equal(existsSync(join(store, 'index.json')), false);
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test('a method whose bytes do not match the sha256 pin is refused and not stored', async () => {
  const repo = fixtureRepo(METHODS, { tamper: 'tide-pool-census' }); const srv = await serve(repo);
  const store = mkdtempSync(join(tmpdir(), 'km-store-'));
  try {
    const r = await huntMethod({ request: 'tide pool census', storeDir: store, remote: { baseUrl: srv.baseUrl } });
    assert.equal(r.status, 'refused'); assert.match(r.reason, /sha256 .* does not match the index pin/);
    assert.equal(existsSync(join(store, 'tide-pool-census.method.md')), false);
  } finally { await srv.close(); for (const d of [repo, store]) rmSync(d, { recursive: true, force: true }); }
});

test('a request below the coverage gate pulls nothing', async () => {
  const repo = fixtureRepo(METHODS); const srv = await serve(repo);
  const store = mkdtempSync(join(tmpdir(), 'km-store-'));
  try {
    const r = await huntMethod({ request: 'bake sourdough bread', storeDir: store, remote: { baseUrl: srv.baseUrl } });
    assert.equal(r.status, 'no-remote-coverage'); assert.deepEqual(srv.hits, ['/intelligence/methods/index.json']);
  } finally { await srv.close(); for (const d of [repo, store]) rmSync(d, { recursive: true, force: true }); }
});

test('two hunted methods chain: step 1 consumes step 0 output', async () => {
  const repo = fixtureRepo(METHODS); const srv = await serve(repo);
  const store = mkdtempSync(join(tmpdir(), 'km-store-')); const work = mkdtempSync(join(tmpdir(), 'km-work-'));
  try {
    const chain = await loopFor(store, srv.baseUrl).runChain([
      { request: 'tide pool census: 2 crabs', inputs: { prompt: '2 crabs' } },
      { request: 'species summary report from the census totals', inputs: { totals: 'census said: {{steps.0.answer}}' } },
    ], { workDir: work });
    assert.equal(chain.status, 'completed', chain.reason);
    assert.equal(chain.steps[0].conduction.method.id, 'tide-pool-census');
    assert.equal(chain.steps[1].conduction.method.id, 'species-summary-report');
    assert.match(chain.steps[1].conduction.outputs.answer, /census said: .*2 crabs/);
    assert(existsSync(join(work, 'step-1', 'result.json')));
  } finally { await srv.close(); for (const d of [repo, store, work]) rmSync(d, { recursive: true, force: true }); }
});

test('KNOWN LIMIT: keyword coverage lets a near-miss local method satisfy the gate, so a better remote method is not hunted', async () => {
  const repo = fixtureRepo([...METHODS, { id: 'tide-pool-report', title: 'Tide pool report', domain: 'tidereport', preamble: 'Report.' }]); const srv = await serve(repo);
  const store = mkdtempSync(join(tmpdir(), 'km-store-')); const work = mkdtempSync(join(tmpdir(), 'km-work-'));
  try {
    const loop = loopFor(store, srv.baseUrl);
    await loop.run('tide pool census: 1 crab', { workDir: join(work, 'a'), inputs: { prompt: '1 crab' } });
    const r = await loop.run('tide pool report please', { workDir: join(work, 'b'), inputs: { prompt: 'x' } });
    assert.equal(r.conduction.method.id, 'tide-pool-census', 'documents current behavior: "tide pool" alone reaches the gate (6)');
  } finally { await srv.close(); for (const d of [repo, store, work]) rmSync(d, { recursive: true, force: true }); }
});
