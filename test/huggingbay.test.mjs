// Hugging Bay in Kingmaker (lib/huggingbay.mjs): the catalog, verified downloads, and the MCP hub registration.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildCatalog, catalogEntry, loadEssentials, downloadVerified, ensureHuggingBayMcp, HB_MCP_URL, HB_PUBLIC_TOOLS, isHostedGgufRow, pickGguf, toolResult } from '../lib/huggingbay.mjs';

const MODEL = { id: 'hf-model-bartowski-gemma-2-2b-it-abliterated-gguf', name: 'bartowski/gemma-2-2b-it-abliterated-GGUF', licenseLabel: 'gemma', downloadable: true, hosted: true,
  commercialUse: 'conditional', ramNeededGb: 3, sizeBytes: 1708582784,
  mainFile: { path: 'gemma-2-2b-it-abliterated-Q4_K_M.gguf', sizeBytes: 1708582784, sha256: '5F0264DD8197B8F96B6F363461CC9D5B7AD49284D2849C68942F43109A1252C4' } };

test('tool results: structured content, JSON text, and errors that say when to retry', () => {
  assert.deepEqual(toolResult({ result: { structuredContent: { a: 1 } } }), { a: 1 });
  assert.deepEqual(toolResult({ result: { content: [{ type: 'text', text: '{"b":2}' }] } }), { b: 2 });
  assert.throws(() => toolResult({ error: { message: 'mcp_tool_fetch_timeout', data: { retryable: true, retryAfterSeconds: 1 } } }), (e) => e.retryable === true && e.retryAfterS === 1);
});

test('only hosted GGUF repos are looked up; a catalog entry needs a hosted GGUF with a SHA-256', () => {
  assert.equal(isHostedGgufRow({ id: 'hf-model-x-abliterated-gguf', name: 'x/abliterated-GGUF', hostedFileCount: 1 }), true);
  assert.equal(isHostedGgufRow({ id: 'hf-model-x-abliterated', name: 'x/abliterated', hostedFileCount: 4 }), false, 'safetensors repo');
  assert.equal(isHostedGgufRow({ id: 'hf-model-x-gguf', name: 'x-GGUF', hostedFileCount: null }), false, 'indexed only');
  const e = catalogEntry(MODEL);
  assert.equal(e.sha256, MODEL.mainFile.sha256.toLowerCase()); assert.equal(e.abliterated, true); assert.equal(e.ramGb, 3);
  assert.match(e.downloadUrl, /^https:\/\/huggingbay\.xyz\/api\/downloads\/hf-model-bartowski-gemma-2-2b-it-abliterated-gguf\/gemma-2-2b-it-abliterated-Q4_K_M\.gguf$/);
  assert.equal(catalogEntry({ ...MODEL, mainFile: { ...MODEL.mainFile, sha256: null } }), null);
  assert.equal(catalogEntry({ ...MODEL, hosted: false }), null);
  assert.equal(catalogEntry({ ...MODEL, mainFile: { ...MODEL.mainFile, path: 'model.safetensors' } }), null);
});

test('the pick is Q4_K_M, then IQ4_XS under the size cap, never a vision projector or a split part', () => {
  const f = (path, sizeBytes) => ({ path, sizeBytes, sha256: 'a'.repeat(64), downloadUrl: `https://x/${path}` });
  assert.equal(pickGguf({ files: [f('m-Q8_0.gguf', 8), f('m-Q4_K_M.gguf', 4), f('mmproj-Q4_K_M.gguf', 1)] }).path, 'm-Q4_K_M.gguf');
  const big = { files: [f('m.Q4_K_M.gguf', 16.5e9), f('m.IQ4_XS.gguf', 14.9e9), f('m.Q3_K_M.gguf', 13e9), f('m.Q8_0-00002-of-00002.gguf', 1e9)] };
  assert.equal(pickGguf(big, { maxBytes: 16e9 }).path, 'm.IQ4_XS.gguf', 'a 27B on a 24 GB Mac');
  assert.equal(pickGguf(big).path, 'm.Q4_K_M.gguf');
  assert.equal(pickGguf({ files: [f('m-Q8_0.gguf', 8), f('m-IQ2_M.gguf', 3)] }, { maxBytes: 5 }).path, 'm-IQ2_M.gguf', 'else the largest that fits');
  assert.equal(pickGguf({ files: [f('m-Q8_0.gguf', 30e9)] }, { maxBytes: 16e9 }), null);
  assert.equal(pickGguf({ files: [{ path: 'm-Q4_K_M.gguf', sizeBytes: 4 }] }), null, 'no SHA-256, no pick');
});

async function fileServer(body) {
  const srv = createServer((req, res) => {
    if (req.url === '/go') { res.writeHead(302, { location: '/signed' }); res.end(); return; } // the stable URL redirects to a signed link
    res.writeHead(200, { 'content-length': body.length }); res.end(body);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) };
}

test('a download is kept only when its size and SHA-256 match; a mismatch is deleted', async () => {
  const body = Buffer.from('GGUF fake weights '.repeat(1000)), sha = createHash('sha256').update(body).digest('hex');
  const s = await fileServer(body), dir = mkdtempSync(join(tmpdir(), 'hb-dl-'));
  try {
    const ok = await downloadVerified({ url: `${s.url}/go`, dest: join(dir, 'a', 'm.gguf'), sha256: sha, sizeBytes: body.length });
    assert.equal(ok.ok, true); assert.deepEqual(readFileSync(ok.path), body);
    const bad = await downloadVerified({ url: `${s.url}/go`, dest: join(dir, 'b', 'm.gguf'), sha256: 'f'.repeat(64), sizeBytes: body.length });
    assert.equal(bad.ok, false); assert.match(bad.why, /didn't match its record/);
    assert.equal(existsSync(join(dir, 'b', 'm.gguf')), false); assert.equal(existsSync(join(dir, 'b', 'm.gguf.part')), false);
  } finally { await s.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('the catalog keeps abliterated, hosted, verified GGUF models that fit, from every search page', async () => {
  const pages = { 0: { rows: [{ id: 'a-gguf', name: 'a-abliterated-GGUF', hostedFileCount: 1 }, { id: 'b', name: 'b-abliterated', hostedFileCount: 3 }], next: 100 },
    100: { rows: [{ id: 'c-gguf', name: 'c-heretic-GGUF', hostedFileCount: 2 }, { id: 'd-gguf', name: 'd-big-abliterated-GGUF', hostedFileCount: 1 }, { id: 'e-gguf', name: 'e-plain-GGUF', hostedFileCount: 1 }], next: null } };
  const models = {
    'a-gguf': { ...MODEL, id: 'a-gguf', name: 'x/a-abliterated-GGUF', ramNeededGb: 3 },
    'c-gguf': { ...MODEL, id: 'c-gguf', name: 'x/c-heretic-GGUF', ramNeededGb: 9 },
    'd-gguf': { ...MODEL, id: 'd-gguf', name: 'x/d-big-abliterated-GGUF', ramNeededGb: 40 },
    'e-gguf': { ...MODEL, id: 'e-gguf', name: 'x/e-plain-GGUF', ramNeededGb: 2 },
  };
  const client = { search: async (q, { cursor }) => (q === 'abliterated' ? pages[cursor] : { rows: [], next: null }), model: async (id) => models[id] };
  const r = await buildCatalog({ client, maxRamGb: 24, essentials: [], retry: { waitMs: 0 } });
  assert.deepEqual(r.entries.map((e) => e.id), ['a-gguf', 'c-gguf']);
  assert.equal(r.candidates, 4, 'the safetensors repo was never looked up');
  assert.ok(r.skipped.some((s) => s.id === 'd-gguf' && /needs 40 GB/.test(s.why)));
  assert.ok(r.skipped.some((s) => s.id === 'e-gguf' && /not abliterated/.test(s.why)));
});

test('the essentials join the catalog, marked, even though they are not abliterated; a failed or too-big one is left out', async () => {
  const models = {
    'e-gguf': { ...MODEL, id: 'e-gguf', name: 'x/e-plain-GGUF', ramNeededGb: 2 },
    'big-gguf': { ...MODEL, id: 'big-gguf', name: 'x/big-GGUF', ramNeededGb: 40 },
  };
  let flaky = 0; // Hugging Bay sometimes answers with a partial record: asked again, not dropped
  const client = { search: async () => ({ rows: [], next: null }), model: async (id) => { if (!models[id]) throw new Error('no record'); if (id === 'e-gguf' && flaky++ < 2) return { id, hosted: true }; return models[id]; } };
  const r = await buildCatalog({ client, maxRamGb: 24, retry: { waitMs: 0 }, essentials: [{ id: 'e-gguf', role: 'embeddings' }, { id: 'big-gguf', role: 'x' }, { id: 'gone', role: 'y' }] });
  assert.deepEqual(r.entries.map((e) => [e.id, e.essential, e.role, e.abliterated]), [['e-gguf', true, 'embeddings', false]]);
  const shipped = loadEssentials();
  assert.ok(shipped.length >= 4 && shipped.every((x) => x.id.startsWith('hf-model-') && x.role), 'catalog/essentials.json ships');
});

test('the MCP hub gets Hugging Bay once, read tools on, public-posting tools never', async () => {
  const calls = [];
  let servers = [];
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url), body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path: u.pathname, method: init.method || 'GET', body, nonce: Object.values(init.headers || {}).includes('n'.repeat(64)) });
    if (u.pathname === '/api/mcp/servers' && (init.method || 'GET') === 'GET') return reply(200, { ok: true, servers });
    if (u.pathname === '/api/mcp/servers') { const s = { serverId: 'mcp_hb', config: { url: body.url } }; servers = [s]; return reply(201, { ok: true, server: s }); }
    if (u.pathname.endsWith('/refresh')) return reply(200, { ok: true, refresh: { ok: true, toolCount: 29 } });
    if (u.pathname.endsWith('/enable-read-only')) return reply(200, { ok: true, reviewed: [{ name: 'search_artifacts' }, { name: 'get_model' }, { name: 'deployment_plan' }] });
    return reply(404, {});
  };
  const first = await ensureHuggingBayMcp({ port: 3001, nonce: 'n'.repeat(64), fetchImpl });
  assert.equal(first.ok, true); assert.equal(first.added, true); assert.equal(first.serverId, 'mcp_hb'); assert.equal(first.tools, 29);
  const order = calls.map((c) => c.path.split('/').pop());
  assert.ok(order.indexOf('refresh') < order.indexOf('enable-read-only'), 'tools are listed before the read-only review');
  const add = calls.find((c) => c.path === '/api/mcp/servers' && c.method === 'POST');
  assert.equal(add.body.url, HB_MCP_URL); assert.equal(add.body.transport, 'http'); assert.ok(add.nonce, 'owner console only');
  const again = await ensureHuggingBayMcp({ port: 3001, nonce: 'n'.repeat(64), fetchImpl });
  assert.equal(again.added, false, 'never added twice');
  assert.ok(first.reviewed.every((n) => !HB_PUBLIC_TOOLS.includes(n)));
});

test('a public-posting tool switched on by mistake is reported, not hidden', async () => {
  const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url, init = {}) => {
    const p = new URL(url).pathname;
    if (p === '/api/mcp/servers' && (init.method || 'GET') === 'GET') return reply({ ok: true, servers: [{ serverId: 'mcp_hb', config: { url: HB_MCP_URL } }] });
    if (p.endsWith('/refresh')) return reply({ ok: true, refresh: { ok: true, toolCount: 29 } });
    return reply({ ok: true, reviewed: [{ name: 'get_model' }, { name: 'report_run' }] });
  };
  const r = await ensureHuggingBayMcp({ port: 3001, nonce: 'n'.repeat(64), fetchImpl });
  assert.equal(r.ok, false); assert.deepEqual(r.leaked, ['report_run']);
});

test('a server whose tools cannot be listed says why, and nothing is switched on', async () => {
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const paths = [];
  const fetchImpl = async (url, init = {}) => {
    const p = new URL(url).pathname; paths.push(p);
    if (p === '/api/mcp/servers' && (init.method || 'GET') === 'GET') return reply(200, { ok: true, servers: [{ serverId: 'mcp_hb', config: { url: HB_MCP_URL } }] });
    return reply(200, { ok: true, refresh: { ok: false, error: { code: 'MCP_TRANSPORT_CLOSED', message: 'outbound channel mcp is blocked' } } });
  };
  const r = await ensureHuggingBayMcp({ port: 3001, nonce: 'n'.repeat(64), fetchImpl });
  assert.equal(r.ok, false); assert.match(r.why, /outbound channel mcp is blocked/);
  assert.ok(!paths.some((p) => p.endsWith('/enable-read-only')));
});

test('churn: the first scan is a baseline; the next reports added, removed, worth-a-look and pick changes', async () => {
  const { churnScan, churnDiff, worthALook } = await import('../lib/huggingbay.mjs');
  assert.deepEqual(churnDiff({ a: 1, b: 1 }, { b: 1, c: 1 }), { added: ['c'], removed: ['a'] });
  assert.equal(worthALook({ name: 'x/Qwen3.9-27B-Heretic-GGUF', ramGb: 17 }), true);
  assert.equal(worthALook({ name: 'x/Qwen3.9-72B-Heretic-GGUF', ramGb: 45 }), false, 'too big for this Mac');
  assert.equal(worthALook({ name: 'x/Qwen3.9-9B-abliterated-GGUF', ramGb: 7 }), false, 'not Heretic');
  const f = (path, sha) => ({ path, sizeBytes: 5e9, sha256: sha, downloadUrl: `https://x/${path}` });
  let rows = [{ id: 'old-gguf', name: 'old-abliterated-GGUF', hostedFileCount: 1 }, { id: 'pick-gguf', name: 'pick-heretic-GGUF', hostedFileCount: 1 }];
  let pickSha = 'a'.repeat(64);
  const client = {
    search: async (q) => ({ rows: q === 'abliterated' ? rows : [], next: null }),
    model: async (id) => ({ ...MODEL, id, name: `x/${id === 'new-gguf' ? 'Qwen3.9-14B-Heretic-GGUF' : id}`, ramNeededGb: 10 }),
    plan: async () => ({ available: true, files: [f('pick.Q4_K_M.gguf', pickSha)] }),
  };
  const picks = [{ role: 'best overall', id: 'pick-gguf' }];
  const first = await churnScan({ client, picks, now: new Date('2026-10-15T04:00:00Z') });
  assert.match(first.report, /Baseline: 2 hosted/); assert.equal(first.added, 0);
  rows = [rows[1], { id: 'new-gguf', name: 'new-heretic-GGUF', hostedFileCount: 2 }];
  pickSha = 'b'.repeat(64);
  const second = await churnScan({ client, state: first.state, picks, now: new Date('2026-11-01T04:00:00Z') });
  assert.equal(second.added, 1); assert.equal(second.removed, 1); assert.equal(second.worth, 1);
  assert.match(second.report, /Worth a look[^\n]*: 1[\s\S]*new-gguf — 1\.7 GB, ~10 GB RAM/);
  assert.match(second.report, /## Removed \(1\)\n\n- old-gguf/);
  assert.equal(second.pickChanges.length, 1, 'a pick whose file bytes changed is flagged');
  assert.match(second.report, /⚠️ best overall \(pick-gguf\): file changed/);
});
