// The two knowledge paths on a FRESH, isolated profile (access model, 2026-11-16):
//   free    — a missing method gets the honest two-path reply; the user writes their own method, it is tested in
//             isolation, saved to THEIR library, then found and run — with no curated-library access at all.
//   member  — the curated library is reached through the REAL update-host worker (update-host/worker.js, loaded as in
//             test/update-host-addons.test.mjs) behind a loopback server: no entitlement → never contacted / 401;
//             a host-signed library.methods entitlement → the one missing method is pulled, verified, cached, run.
// Model calls are stubbed (deterministic); the live-model runs are in the acceptance proof, not here.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalBrain, handleMethodRequest } from '../lib/method-request.mjs';
import { writeMethod } from '../lib/method-writing.mjs';

const enc = new TextEncoder();
const b64 = (bytes) => { let s = ''; for (const byte of bytes) s += String.fromCharCode(byte); return btoa(s); };
function derLen(n) { return n < 0x80 ? [n] : [0x81, n]; }
function derInt(bytes) { let i = 0; while (i < bytes.length - 1 && bytes[i] === 0x00) i++; let v = [...bytes.slice(i)]; if (v[0] & 0x80) v = [0x00, ...v]; return [0x02, ...derLen(v.length), ...v]; }
function ecdsaRawToDer(raw) { const r = derInt(raw.slice(0, 32)); const s = derInt(raw.slice(32, 64)); const body = [...r, ...s]; return Uint8Array.from([0x30, ...derLen(body.length), ...body]); }
const src = readFileSync(new URL('../update-host/worker.js', import.meta.url), 'utf8');
const worker = (await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'))).default;
const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
const CERT_SIGNING_KEY = '-----BEGIN PRIVATE KEY-----\n' + b64(pkcs8).replace(/(.{64})/g, '$1\n') + '\n-----END PRIVATE KEY-----\n';
async function mint(claims) {
  const payload = JSON.stringify(claims);
  const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, enc.encode(payload)));
  return { payload, sig: b64(ecdsaRawToDer(raw)), alg: 'ES256' };
}
const member = (over = {}) => mint({ schema: 'ronin.entitlement/1', issuer: 'ronin-update-host', installId: 'i1', deviceSha256: 'd', sku: 'library.methods', grantedAt: '2026-11-16T00:00:00Z', expiresAt: null, order: 'mem_1', ...over });

const CURATED = `# Method — Sail race pilot\n\n\`\`\`kingmaker-method\n${JSON.stringify({ id: 'sail-race-pilot', version: '1.0', title: 'Sail race pilot', domain: 'sailing', inputs: { prompt: '' }, weights: { role: 'writer' },
  steps: [{ n: 1, id: 'plan', type: 'note', text: 'Steer outside the no-go cone.' }, { n: 2, id: 'helm', type: 'reason', into: 'answer', preamble: 'Pick helm and sheet.', prompt: '{{inputs.prompt}}' },
    { n: 3, id: 'record', type: 'write-json', path: 'result.json', value: { method: 'sail-race-pilot', answer: '{{answer}}' } }, { n: 4, id: 'check', type: 'verify', assertions: [{ file: 'result.json', field: 'method', equals: 'sail-race-pilot' }] }] }, null, 2)}\n\`\`\`\n`;
const CUR_BUF = Buffer.from(CURATED);
const INDEX = Buffer.from(JSON.stringify({ schema: 'kingmaker.methods/1', methods: [{ id: 'sail-race-pilot', title: 'Sail race pilot', domain: 'sailing', file: 'sail-race-pilot.method.md', size: CUR_BUF.length, sha256: createHash('sha256').update(CUR_BUF).digest('hex'), quality: { tier: 'vetted', score: 90, basis: 'curated fixture' } }] }));
const R2 = { 'library/methods/index.json': INDEX, 'library/methods/sail-race-pilot.method.md': CUR_BUF };

async function updateHost() {
  const hits = [];
  const env = { CERT_SIGNING_KEY, UPDATE_KEYS: 'op', DEVICES: { get: async () => null, put: async () => {} },
    RELEASES: { get: async (k) => (R2[k] ? { size: R2[k].length, httpEtag: '"x"', writeHttpMetadata() {}, body: R2[k] } : null) } };
  const server = http.createServer(async (req, res) => {
    const r = await worker.fetch(new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers }), env);
    hits.push({ path: req.url, status: r.status });
    res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/library`, hits, close: () => new Promise((r) => server.close(r)) };
}
const stubReasoner = async ({ preamble, prompt }) => `${preamble.split('.')[0]} → ${prompt}`;
const freshProfile = () => { const state = mkdtempSync(join(tmpdir(), 'km-fresh-')); return { state, work: (n) => { const d = join(state, 'tasks', n); mkdirSync(d, { recursive: true }); return d; } }; };

test('free install: a missing method is stated plainly with both paths; no link is invented; the curated library is not contacted', async () => {
  const host = await updateHost(); const p = freshProfile();
  delete process.env.KINGMAKER_SUBSCRIBE_URL;
  try {
    const brain = createLocalBrain({ state: p.state, remote: { baseUrl: host.url, intelligencePath: '' }, reasoner: stubReasoner });
    const r = await handleMethodRequest('Kingmaker, run the sail race pilot', { brain, workDir: p.work('a') });
    assert.equal(r.outcome, 'refused'); assert.equal(r.hunt.status, 'not-entitled');
    const text = r.lines.join('\n');
    assert.match(text, /I don't have a method for "sail race pilot" yet, so I haven't done it\./);
    assert.match(text, /needs a membership, so I couldn't check whether it has one — I won't promise it does/);
    assert.match(text, /the subscription link is not configured on this install/);
    assert.match(text, /Or I can help build a method for you/);
    assert.doesNotMatch(text, /https?:\/\/\S+subscribe/i);
    assert.deepEqual(host.hits, [], 'no entitlement → the client never asks the curated library');
  } finally { await host.close(); rmSync(p.state, { recursive: true, force: true }); }
});

test('the boundary is the server: a forged or missing entitlement sent anyway gets 401 → not-entitled, nothing cached', async () => {
  const host = await updateHost(); const p = freshProfile();
  try {
    const forged = { ...(await member()), payload: (await member()).payload.replace('library.methods', 'library.methodz') };
    const brain = createLocalBrain({ state: p.state, remote: { baseUrl: host.url, intelligencePath: '' }, reasoner: stubReasoner, entitlement: forged });
    const r = await handleMethodRequest('run the sail race pilot', { brain, workDir: p.work('a') });
    assert.equal(r.hunt.status, 'not-entitled'); assert.deepEqual(host.hits.map((h) => h.status), [401]);
    assert.equal(existsSync(join(p.state, 'brain-library', 'methods', 'sail-race-pilot.method.md')), false);
  } finally { await host.close(); rmSync(p.state, { recursive: true, force: true }); }
});

test('member: a verified entitlement pulls the ONE missing curated method through the real gate, caches it, runs it, then reuses it with no request', async () => {
  const host = await updateHost(); const p = freshProfile();
  try {
    mkdirSync(join(p.state, 'entitlements'), { recursive: true });
    writeFileSync(join(p.state, 'entitlements', 'library.methods.json'), JSON.stringify(await member()));
    const brain = () => createLocalBrain({ state: p.state, remote: { baseUrl: host.url, intelligencePath: '' }, reasoner: stubReasoner });
    const r = await handleMethodRequest('Kingmaker, run the sail race pilot.', { brain: brain(), workDir: p.work('a'), inputs: { prompt: 'wind 040, heading 090' } });
    assert.equal(r.outcome, 'completed', r.lines.join('\n')); assert.equal(r.hunt.status, 'acquired');
    assert.equal(r.method.layer, 'curated library'); assert.equal(r.method.id, 'sail-race-pilot');
    assert.deepEqual(host.hits.map((h) => [h.path, h.status]), [['/library/methods/index.json', 200], ['/library/methods/sail-race-pilot.method.md', 200]]);
    assert.equal(r.network.externalInference, 0);
    host.hits.length = 0;
    const again = await handleMethodRequest('run the sail race pilot', { brain: brain(), workDir: p.work('b'), inputs: { prompt: 'wind 180' } });
    assert.equal(again.outcome, 'completed'); assert.equal(again.hunt, null); assert.deepEqual(host.hits, [], 'cached: no request');
  } finally { await host.close(); rmSync(p.state, { recursive: true, force: true }); }
});

test('free install: the user writes their own method, it is tested in isolation, saved to THEIR library, then found and run — no curated access; it survives a lapsed membership', async () => {
  const host = await updateHost(); const p = freshProfile();
  try {
    const draft = async () => JSON.stringify({ title: 'Miles to kilometres', domain: 'conversion', steps: [{ id: 'rule', type: 'note', text: 'km = miles × 1.609344' }, { id: 'convert', type: 'reason', preamble: 'Convert miles to kilometres. km = miles × 1.609344. Answer with the number and "km".', prompt: '{{inputs.prompt}}' }] });
    const reasoner = async ({ prompt }) => `${(Number(/[\d.]+/.exec(prompt)[0]) * 1.609344).toFixed(2)} km`;
    const w = await writeMethod({ task: 'convert miles to kilometres', sample: '5 miles', expect: '8.05 km', draft, reasoner, model: 'stub', userStore: join(p.state, 'abilities', 'methods'), draftsDir: join(p.state, 'abilities', 'drafts') });
    assert.equal(w.status, 'promoted', w.reason); assert.equal(w.receipt.test.verify, 'executed');
    assert.match(readFileSync(w.path, 'utf8'), /## Provenance[\s\S]*library: user \(never uploaded/);
    const brain = createLocalBrain({ state: p.state, remote: { baseUrl: host.url, intelligencePath: '' }, reasoner });
    const r = await handleMethodRequest('Kingmaker, convert 12 miles to kilometres', { brain, workDir: p.work('use'), inputs: { prompt: '12 miles', expect: '' } });
    assert.equal(r.outcome, 'completed', r.lines.join('\n')); assert.equal(r.method.layer, 'your abilities'); assert.equal(r.outputs.answer, '19.31 km');
    assert.deepEqual(host.hits, [], 'own method: no curated-library contact');
  } finally { await host.close(); rmSync(p.state, { recursive: true, force: true }); }
});

test('a draft that fails its isolated test is NOT promoted and stays in drafts with its trace', async () => {
  const p = freshProfile();
  try {
    const draft = async () => JSON.stringify({ title: 'Bad converter', domain: 'conversion', steps: [{ id: 'convert', type: 'reason', preamble: 'Convert.', prompt: '{{inputs.prompt}}' }] });
    const w = await writeMethod({ task: 'convert miles badly', sample: '5 miles', expect: '8.05 km', draft, reasoner: async () => 'about 8 km', userStore: join(p.state, 'abilities', 'methods'), draftsDir: join(p.state, 'abilities', 'drafts') });
    assert.equal(w.status, 'not-promoted'); assert(existsSync(join(w.draftDir, 'test-receipt.json')));
    assert.equal(existsSync(join(p.state, 'abilities', 'methods', 'index.json')), false);
  } finally { rmSync(p.state, { recursive: true, force: true }); }
});

test('a drafted method may not smuggle in tool or declare steps', async () => {
  const p = freshProfile();
  try {
    const draft = async () => JSON.stringify({ title: 'x', steps: [{ id: 'a', type: 'declare', action: 'rm -rf /', reason: 'x' }, { id: 'b', type: 'reason', preamble: 'x' }] });
    await assert.rejects(writeMethod({ task: 'x task', sample: 's', draft, reasoner: async () => 'y', userStore: join(p.state, 'u'), draftsDir: join(p.state, 'd') }), /METHOD_DRAFT_STEP_REFUSED/);
  } finally { rmSync(p.state, { recursive: true, force: true }); }
});
