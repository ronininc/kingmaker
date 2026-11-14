// Model hosts: the key rule, unknown values, exact copies between hosts, the speed measurement, keeping a model
// loaded without unloading someone else's, and the doctor rows. See lib/model-hosts.mjs and its neighbours.
// The hosts here are stand-in Ollama servers on loopback that behave like the documented API, including
// refusing an uploaded file whose bytes do not match its SHA-256 name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  credentialFor, findHost, hostClient, hostKind, isUnavailable, loadHosts, LOCAL_HOST_NAME, measured, normalizeUrl, plain,
  probeHost, removeHost, saveHost, show, unavailable,
} from '../lib/model-hosts.mjs';
import { createRequest, parseModelName, planSync, readLocalModel, syncModel } from '../lib/model-sync.mjs';
import { measureSpeed, median, speedAsJson, speedLines, speedPrompt, spread } from '../lib/model-speed.mjs';
import { measuredNeed, parseKeepAlive, planWarm, readOurs, stopModels, warmModel } from '../lib/model-residency.mjs';
import { cmdModelHosts, doctorLines, hostReportRows, memoryBudgetBytes, modelHostDoctor, scorecardLine } from '../lib/model-hosts-cli.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const tmp = () => mkdtempSync(join(tmpdir(), 'km-hosts-'));
const GB = 2 ** 30;

/** A stand-in Ollama. `state` is what it holds; tests read and change it directly. */
async function fakeOllama({ models = {}, loaded = {}, version = '0.9.9', requireKey = null, slowMs = 0 } = {}) {
  const state = { models: { ...models }, loaded: { ...loaded }, blobs: new Map(), requests: [], creates: [], pulls: [], prompts: [], version, loadCount: 0 };
  const body = (req) => new Promise((resolve) => { const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => resolve(Buffer.concat(chunks))); });
  const server = http.createServer(async (req, res) => {
    state.requests.push({ method: req.method, url: req.url, auth: req.headers.authorization ?? null });
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
    if (requireKey && req.headers.authorization !== `Bearer ${requireKey}`) return send(401, { error: 'unauthorized' });
    if (slowMs) await new Promise((r) => setTimeout(r, slowMs));
    if (req.url === '/api/version') return send(200, { version: state.version });
    if (req.url === '/api/tags') return send(200, { models: Object.entries(state.models).map(([name, m]) => ({ name, model: name, digest: m.digest, size: m.size })) });
    if (req.url === '/api/ps') return send(200, { models: Object.entries(state.loaded).map(([name, m]) => ({ name, model: name, size: m.size, size_vram: m.size_vram, expires_at: m.expires_at ?? '2026-11-12T00:00:00Z' })) });
    const blob = /^\/api\/blobs\/sha256:([0-9a-f]{64})$/.exec(req.url);
    if (blob && req.method === 'HEAD') { res.writeHead(state.blobs.has(blob[1]) ? 200 : 404); return res.end(); }
    if (blob && req.method === 'POST') {
      const bytes = await body(req);
      if (sha(bytes) !== blob[1]) return send(400, { error: 'digest mismatch' });
      state.blobs.set(blob[1], bytes); res.writeHead(201); return res.end();
    }
    const payload = req.method === 'POST' ? JSON.parse((await body(req)).toString('utf8') || '{}') : {};
    const lines = (objs) => { res.writeHead(200, { 'content-type': 'application/x-ndjson' }); res.end(objs.map((o) => JSON.stringify(o)).join('\n') + '\n'); };
    if (req.url === '/api/create') {
      state.creates.push(payload);
      const digests = Object.values(payload.files ?? {}).map((d) => String(d).replace('sha256:', ''));
      if (!digests.length || digests.some((d) => !state.blobs.has(d))) return lines([{ error: 'a file named in the request is not on this host' }]);
      const size = digests.reduce((n, d) => n + state.blobs.get(d).length, 0);
      // A real host writes its own manifest, so the listing digest is its own, not the source's.
      state.models[payload.model] = { digest: sha(Buffer.from(JSON.stringify({ rebuilt: payload.model, digests }))), size };
      return lines([{ status: 'parsing GGUF' }, { status: 'writing manifest' }, { status: 'success' }]);
    }
    if (req.url === '/api/pull') {
      state.pulls.push(payload.model);
      const from = state.registry?.[payload.model];
      if (!from) return lines([{ error: 'pull model manifest: file does not exist' }]);
      state.models[payload.model] = { ...from };
      return lines([{ status: 'pulling manifest' }, { status: 'success' }]);
    }
    if (req.url === '/api/generate') {
      const name = payload.model;
      if (!state.models[name]) return send(404, { error: `model '${name}' not found` });
      if (payload.keep_alive === 0) { delete state.loaded[name]; return send(200, { model: name, response: '', done: true, done_reason: 'unload' }); }
      const wasLoaded = Boolean(state.loaded[name]);
      if (!wasLoaded) { state.loadCount += 1; state.loaded[name] = { size: state.models[name].size, size_vram: state.models[name].size, keep_alive: payload.keep_alive }; }
      else state.loaded[name].keep_alive = payload.keep_alive;
      if (payload.prompt == null) return send(200, { model: name, response: '', done: true });
      state.prompts.push(payload.prompt);
      const out = [{ response: 'One ' }, { response: 'two ' }, { response: 'three.' },
        { response: '', done: true, load_duration: wasLoaded ? 1_000_000 : 3_000_000_000, prompt_eval_count: 30, prompt_eval_duration: 300_000_000, eval_count: 100, eval_duration: 2_000_000_000 + state.prompts.length * 100_000_000 }];
      return lines(state.dropTimings ? out.map((o) => (o.done ? { response: '', done: true } : o)) : out);
    }
    return send(404, { error: 'not found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, state, close: () => new Promise((r) => server.close(r)) };
}

/** A model store laid out the way Ollama's is, with real files, for the exact-copy path. */
function localStore(dir, name, { weights = randomBytes(4096), template = '{{ .Prompt }}', params = { temperature: 0.2, stop: ['<end>'] }, projector = null, adapter = null } = {}) {
  const n = parseModelName(name);
  const put = (buf) => { const d = sha(buf); mkdirSync(join(dir, 'blobs'), { recursive: true }); writeFileSync(join(dir, 'blobs', `sha256-${d}`), buf); return `sha256:${d}`; };
  const layers = [{ mediaType: 'application/vnd.ollama.image.model', digest: put(weights), size: weights.length }];
  if (projector) layers.push({ mediaType: 'application/vnd.ollama.image.projector', digest: put(projector), size: projector.length });
  if (adapter) layers.push({ mediaType: 'application/vnd.ollama.image.adapter', digest: put(adapter), size: adapter.length });
  const t = Buffer.from(template), p = Buffer.from(JSON.stringify(params));
  layers.push({ mediaType: 'application/vnd.ollama.image.template', digest: put(t), size: t.length }, { mediaType: 'application/vnd.ollama.image.params', digest: put(p), size: p.length });
  const manifestDir = join(dir, 'manifests', n.registry, n.namespace, n.model);
  mkdirSync(manifestDir, { recursive: true });
  const manifest = JSON.stringify({ schemaVersion: 2, layers });
  writeFileSync(join(manifestDir, n.tag), manifest);
  return { weights, weightsDigest: layers[0].digest, manifestDigest: sha(Buffer.from(manifest)), bytes: weights.length };
}

// ── unknown values ─────────────────────────────────────────────────────────────────────────────

test('a value that could not be measured is "unavailable", never a number', () => {
  const u = unavailable('the host did not answer', 'turn it on');
  assert.equal(isUnavailable(u), true);
  assert.equal(isUnavailable(0), false); assert.equal(isUnavailable(null), false); assert.equal(isUnavailable({ unavailable: true }), false, 'a look-alike object is not one');
  assert.equal(show(u, (v) => `${v} ms`), 'unavailable (the host did not answer)');
  assert.equal(show(12, (v) => `${v} ms`), '12 ms');
  assert.equal(show(undefined), 'unavailable (not known)');
  assert.deepEqual(plain(u), { unavailable: true, reason: 'the host did not answer', fix: 'turn it on' });
  assert.equal(measured(5), 5); assert.equal(measured(0), 0);
  for (const bad of [undefined, null, Number.NaN, -1, '7', Infinity]) assert.equal(isUnavailable(measured(bad)), true, String(bad));
  assert.equal(isUnavailable(measured(0, 'x', { allowZero: false })), true, 'a size of zero is not a size');
});

// ── addresses and the key rule ─────────────────────────────────────────────────────────────────

test('a host address is put in one form and sorted into this Mac, the local network, or the internet', () => {
  assert.equal(normalizeUrl('192.168.1.20:11434'), 'http://192.168.1.20:11434');
  assert.equal(normalizeUrl('http://studio.local/'), 'http://studio.local:11434');
  assert.equal(normalizeUrl('https://models.example.com'), 'https://models.example.com:443');
  for (const bad of ['', 'ftp://x', 'http://user:pw@host:1', 'not a url at all']) assert.throws(() => normalizeUrl(bad), undefined, bad);
  for (const u of ['127.0.0.1:11434', 'http://localhost:11438', 'http://[::1]:11434']) assert.equal(hostKind(u), 'local', u);
  for (const u of ['10.0.0.5:11434', '192.168.1.20:11434', '172.20.1.1:1', 'studio.local:11434', 'gpubox:11434', '100.64.0.9:11434']) assert.equal(hostKind(u), 'lan', u);
  for (const u of ['https://models.example.com', '8.8.8.8:11434', '172.32.0.1:11434', '100.128.0.1:1']) assert.equal(hostKind(u), 'remote', u);
});

test('a host is sent only its own key: never a provider key, and never over plain http across the internet', () => {
  const env = { STUDIO_KEY: 'studio-secret', OPENAI_API_KEY: 'sk-real-provider-key', COPY_OF_PROVIDER: 'sk-real-provider-key' };
  assert.deepEqual(credentialFor({ name: 'a', url: '192.168.1.2:11434' }, env), { headers: {}, key: 'none', why: 'no key is set up for this host' });
  const lan = credentialFor({ name: 'studio', url: '192.168.1.2:11434', keyEnv: 'STUDIO_KEY' }, env);
  assert.equal(lan.key, 'sent'); assert.equal(lan.headers.authorization, 'Bearer studio-secret');
  const named = credentialFor({ name: 'x', url: '192.168.1.2:11434', keyEnv: 'OPENAI_API_KEY' }, env);
  assert.equal(named.key, 'withheld'); assert.deepEqual(named.headers, {});
  const copied = credentialFor({ name: 'x', url: '192.168.1.2:11434', keyEnv: 'COPY_OF_PROVIDER' }, env);
  assert.equal(copied.key, 'withheld', 'the same value under another name is still a provider key'); assert.deepEqual(copied.headers, {});
  const plainRemote = credentialFor({ name: 'far', url: 'http://models.example.com:11434', keyEnv: 'STUDIO_KEY' }, env);
  assert.equal(plainRemote.key, 'withheld'); assert.match(plainRemote.why, /plain http/);
  assert.equal(credentialFor({ name: 'far', url: 'https://models.example.com', keyEnv: 'STUDIO_KEY' }, env).key, 'sent');
  assert.equal(credentialFor({ name: 'studio', url: '192.168.1.2:11434', keyEnv: 'UNSET_ONE' }, env).key, 'none');
});

test('the host list always starts with this Mac, stores only the name of a key, and refuses a provider key', () => {
  const dir = tmp();
  try {
    assert.deepEqual(loadHosts(dir, {}).map((h) => h.name), [LOCAL_HOST_NAME]);
    assert.equal(loadHosts(dir, { OLLAMA_HOST: '127.0.0.1:11438' })[0].url, 'http://127.0.0.1:11438');
    assert.equal(loadHosts(dir, { OLLAMA_HOST: 'http://far.example.com:11434' })[0].url, 'http://127.0.0.1:11434', 'a far-away OLLAMA_HOST is not "this Mac"');
    const saved = saveHost(dir, { name: 'Studio', url: '192.168.1.20', keyEnv: 'STUDIO_KEY' }, {});
    assert.deepEqual(saved, { name: 'studio', url: 'http://192.168.1.20:11434', keyEnv: 'STUDIO_KEY', kind: 'lan' });
    const onDisk = readFileSync(join(dir, 'model-hosts.json'), 'utf8');
    assert.ok(onDisk.includes('STUDIO_KEY') && !onDisk.includes('studio-secret'));
    assert.throws(() => saveHost(dir, { name: 'bad', url: '10.0.0.1', keyEnv: 'ANTHROPIC_API_KEY' }, {}), /provider keys/);
    assert.throws(() => saveHost(dir, { name: LOCAL_HOST_NAME, url: '10.0.0.1' }, {}), /this Mac/);
    assert.throws(() => saveHost(dir, { name: 'Bad Name!', url: '10.0.0.1' }, {}), /host name/);
    assert.equal(findHost(dir, 'studio', {}).url, 'http://192.168.1.20:11434');
    assert.equal(findHost(dir, null, {}).name, LOCAL_HOST_NAME);
    assert.throws(() => findHost(dir, 'nope', {}), /no host named "nope"\. Known: this-mac, studio/);
    assert.equal(removeHost(dir, 'studio', {}), true); assert.equal(removeHost(dir, 'studio', {}), false);
    writeFileSync(join(dir, 'model-hosts.json'), '{ damaged');
    assert.deepEqual(loadHosts(dir, {}).map((h) => h.name), [LOCAL_HOST_NAME], 'a damaged file reads as none added');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a host is really sent its own key and nothing else from the environment', async () => {
  const far = await fakeOllama({ requireKey: 'studio-secret' });
  try {
    const env = { STUDIO_KEY: 'studio-secret', OPENAI_API_KEY: 'sk-real-provider-key', ANTHROPIC_API_KEY: 'sk-ant-real' };
    const client = hostClient({ name: 'studio', url: far.url, keyEnv: 'STUDIO_KEY' }, { env });
    assert.equal(await client.version(), '0.9.9');
    assert.ok(far.state.requests.every((r) => r.auth === 'Bearer studio-secret'));
    const seen = JSON.stringify(far.state.requests);
    assert.ok(!seen.includes('sk-real-provider-key') && !seen.includes('sk-ant-real'));
    const wrong = hostClient({ name: 'studio', url: far.url, keyEnv: 'OPENAI_API_KEY' }, { env });
    await assert.rejects(wrong.version(), /401/);
    assert.equal(far.state.requests.at(-1).auth, null, 'the provider key was withheld, so the host saw no key at all');
  } finally { await far.close(); }
});

test('one look at a host reports what it read, and marks the rest unavailable', async () => {
  const host = await fakeOllama({ models: { 'qwen3:4b': { digest: 'a'.repeat(64), size: 3 * GB } }, loaded: { 'qwen3:4b': { size: 3 * GB, size_vram: undefined } } });
  try {
    const p = await probeHost({ name: 'box', url: host.url });
    assert.equal(p.reachable, true); assert.equal(p.version, '0.9.9'); assert.equal(p.installedCount, 1);
    assert.ok(Number.isInteger(p.latencyMs) && p.latencyMs >= 0);
    assert.equal(p.resident[0].bytes, 3 * GB);
    assert.equal(isUnavailable(p.resident[0].gpuBytes), true, 'the host gave no GPU figure, so none is shown');
  } finally { await host.close(); }
  const dead = await probeHost({ name: 'gone', url: 'http://127.0.0.1:9' }, { timeoutMs: 800 });
  assert.equal(dead.reachable, false);
  for (const k of ['latencyMs', 'version', 'installedCount', 'resident']) assert.equal(isUnavailable(dead[k]), true, k);
});

// ── sync ───────────────────────────────────────────────────────────────────────────────────────

test('model names are filed the way Ollama files them', () => {
  assert.deepEqual(parseModelName('qwen3:4b'), { registry: 'registry.ollama.ai', namespace: 'library', model: 'qwen3', tag: '4b' });
  assert.deepEqual(parseModelName('llama3.2'), { registry: 'registry.ollama.ai', namespace: 'library', model: 'llama3.2', tag: 'latest' });
  assert.deepEqual(parseModelName('kimocoder/kalidroid:27b'), { registry: 'registry.ollama.ai', namespace: 'kimocoder', model: 'kalidroid', tag: '27b' });
  assert.deepEqual(parseModelName('hf.co/TrevorJS/gemma-4-12B-it-GGUF:Q4_K_M'), { registry: 'hf.co', namespace: 'TrevorJS', model: 'gemma-4-12B-it-GGUF', tag: 'Q4_K_M' });
  for (const bad of ['', 'a b', '../etc/passwd', 'a/b/c/d:e', 'x:', ':y']) assert.throws(() => parseModelName(bad), /not a model name/, bad);
});

test('two listings are compared by digest', () => {
  const fromTags = [{ name: 'a:1', digest: 'd1' }, { name: 'b:latest', digest: 'd2' }, { name: 'c:1', digest: 'd3' }];
  const toTags = [{ name: 'a:1', digest: 'd1' }, { name: 'b', digest: 'OTHER' }];
  assert.deepEqual(planSync({ fromTags, toTags }).map((r) => [r.model, r.state]), [['a:1', 'same'], ['b:latest', 'different'], ['c:1', 'missing']]);
  assert.deepEqual(planSync({ fromTags, toTags, models: ['zzz'] }).map((r) => r.state), ['not-on-source']);
});

test('an exact copy uploads each file under its SHA-256, rebuilds the model, and proves every file arrived', async () => {
  const dir = tmp(); const dest = await fakeOllama(); const src = await fakeOllama();
  try {
    const made = localStore(dir, 'qwen3:4b');
    src.state.models['qwen3:4b'] = { digest: made.manifestDigest, size: made.bytes };
    const local = readLocalModel('qwen3:4b', { modelsDir: dir });
    assert.equal(local.complete, true); assert.equal(local.files.length, 1); assert.equal(local.text.template, '{{ .Prompt }}');
    assert.deepEqual(createRequest(local), { model: 'qwen3:4b', files: { 'model.gguf': made.weightsDigest }, template: '{{ .Prompt }}', parameters: { temperature: 0.2, stop: ['<end>'] } });

    const from = hostClient({ name: 'this-mac', url: src.url }), to = hostClient({ name: 'studio', url: dest.url });
    const r = await syncModel({ model: 'qwen3:4b', from, to, local: true, modelsDir: dir });
    assert.equal(r.how, 'exact-copy');
    assert.deepEqual(r.verified, { everyFileOnDestination: true, listed: true, sameListingDigest: false });
    assert.match(r.note, /same SHA-256.*listing digest differs/s, 'says plainly that the listing digest differs and why');
    assert.deepEqual(dest.state.blobs.get(made.weightsDigest.slice(7)), made.weights, 'the destination holds the same bytes');
    assert.equal(r.uploaded.length, 1);

    // Again: the file is already there, so nothing is uploaded a second time.
    const again = await syncModel({ model: 'qwen3:4b', from, to, local: true, modelsDir: dir, force: true });
    assert.equal(again.uploaded.length, 0); assert.equal(again.skipped.length, 1);
    assert.equal(again.verified.everyFileOnDestination, true);
  } finally { await dest.close(); await src.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a file that does not match its name is refused by the destination and the copy fails', async () => {
  const dir = tmp(); const dest = await fakeOllama(); const src = await fakeOllama();
  try {
    const made = localStore(dir, 'qwen3:4b');
    src.state.models['qwen3:4b'] = { digest: made.manifestDigest, size: made.bytes };
    // The file on disk is changed after the manifest was written: same length, different bytes.
    writeFileSync(join(dir, 'blobs', made.weightsDigest.replace(':', '-')), randomBytes(made.bytes));
    const from = hostClient({ name: 'this-mac', url: src.url }), to = hostClient({ name: 'studio', url: dest.url });
    await assert.rejects(syncModel({ model: 'qwen3:4b', from, to, local: true, modelsDir: dir }), /refused the upload \(400\)/);
    assert.equal(dest.state.models['qwen3:4b'], undefined, 'no model was built from a bad file');
  } finally { await dest.close(); await src.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('from another machine the model is downloaded by name, and a different build is called a different build', async () => {
  const src = await fakeOllama({ models: { 'qwen3:4b': { digest: 'aaaa', size: 100 }, 'gemma:2b': { digest: 'gggg', size: 100 } } });
  const dest = await fakeOllama();
  try {
    dest.state.registry = { 'qwen3:4b': { digest: 'aaaa', size: 100 }, 'gemma:2b': { digest: 'NEWER', size: 100 } };
    const from = hostClient({ name: 'laptop', url: src.url }), to = hostClient({ name: 'studio', url: dest.url });
    const same = await syncModel({ model: 'qwen3:4b', from, to, local: false });
    assert.equal(same.how, 'downloaded-by-name'); assert.equal(same.verified.sameListingDigest, true);
    assert.equal(isUnavailable(same.verified.everyFileOnDestination), true, 'the files were not compared, and it says so');
    const diff = await syncModel({ model: 'gemma:2b', from, to, local: false });
    assert.equal(diff.verified.sameListingDigest, false);
    assert.match(diff.note, /NOT the one laptop lists.*different builds/s);
    const already = await syncModel({ model: 'qwen3:4b', from, to, local: false });
    assert.equal(already.how, 'already-there'); assert.equal(dest.state.pulls.filter((m) => m === 'qwen3:4b').length, 1);
    await assert.rejects(syncModel({ model: 'missing:1', from, to, local: false }), /laptop does not have missing:1/);
  } finally { await src.close(); await dest.close(); }
});

test('a model with an adapter, or with a file missing, is not rebuilt as something else', async () => {
  const dir = tmp();
  try {
    localStore(dir, 'tuned:1', { adapter: randomBytes(64) });
    const req = createRequest(readLocalModel('tuned:1', { modelsDir: dir }));
    assert.equal(req.unavailable, true); assert.match(req.reason, /adapter/);
    const made = localStore(dir, 'holes:1', { projector: randomBytes(64) });
    assert.deepEqual(Object.keys(createRequest(readLocalModel('holes:1', { modelsDir: dir })).files), ['model.gguf', 'projector.gguf']);
    rmSync(join(dir, 'blobs', made.weightsDigest.replace(':', '-')));
    assert.equal(readLocalModel('holes:1', { modelsDir: dir }).complete, false);
    assert.equal(readLocalModel('never-pulled:1', { modelsDir: dir }), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── speed ──────────────────────────────────────────────────────────────────────────────────────

test('every run gets a prompt no other run had, and the typical figure is a median', () => {
  const prompts = Array.from({ length: 12 }, (_, i) => speedPrompt(i, 'seed'));
  assert.equal(new Set(prompts).size, 12);
  assert.equal(new Set(prompts.map((p) => p.split('\n')[0])).size, 12, 'the very first line differs, so nothing cached is reused');
  assert.notEqual(speedPrompt(0, 'a'), speedPrompt(0, 'b'));
  assert.equal(median([3, 1, 2]), 2); assert.equal(median([4, 1, 3, 2]), 2.5); assert.equal(median([]), null);
  assert.deepEqual(spread([{ x: 10 }, { x: 30 }, { x: 20 }], 'x'), { median: 20, min: 10, max: 30, of: 3 });
  assert.equal(isUnavailable(spread([{ x: null }, {}], 'x')), true);
});

test('a cold first run is reported by itself and kept out of the typical figures', async () => {
  const host = await fakeOllama({ models: { 'qwen3:4b': { digest: 'd', size: 3 * GB } } });
  try {
    const client = hostClient({ name: 'box', url: host.url });
    const r = await measureSpeed(client, { model: 'qwen3:4b', runs: 4, seed: 't' });
    assert.equal(r.runs.length, 4);
    assert.deepEqual(r.runs.map((x) => x.cold), [true, false, false, false]);
    assert.equal(r.cold.n, 1); assert.equal(r.cold.loadMs, 3000);
    assert.equal(r.warm.runs, 3);
    assert.equal(r.warm.genTokS.of, 3);
    assert.ok(r.warm.genTokS.min <= r.warm.genTokS.median && r.warm.genTokS.median <= r.warm.genTokS.max);
    assert.equal(r.warm.promptTokS.median, 100, '30 tokens in 0.3 s, read from the host\'s own counters');
    assert.equal(new Set(host.state.prompts).size, 4, 'the host saw four different prompts');
    assert.equal(r.memory.bytes, 3 * GB);
    const text = speedLines(r).join('\n');
    assert.match(text, /cold start \(run 1, not in the figures above\)/);
    assert.match(text, /writing speed:\s+[\d.]+ tokens\/s typical \(lowest [\d.]+, highest [\d.]+, 3 runs\)/);
  } finally { await host.close(); }
});

test('with a warm-up every timed run is warm; one warm run is called one run, not typical', async () => {
  const host = await fakeOllama({ models: { 'qwen3:4b': { digest: 'd', size: 3 * GB } } });
  try {
    const client = hostClient({ name: 'box', url: host.url });
    const warmed = await measureSpeed(client, { model: 'qwen3:4b', runs: 2, warmup: true });
    assert.deepEqual(warmed.runs.map((x) => x.cold), [false, false]); assert.equal(warmed.cold, null);
    assert.match(speedLines(warmed).join('\n'), /cold start: not measured/);
    const one = await measureSpeed(client, { model: 'qwen3:4b', runs: 1 });
    assert.ok(one.notes.some((n) => /Only one warm run/.test(n)));
    assert.match(speedLines(one).join('\n'), /\(one run\)/);
  } finally { await host.close(); }
});

test('figures the host did not give are unavailable in the result, the text and the JSON', async () => {
  const host = await fakeOllama({ models: { 'qwen3:4b': { digest: 'd', size: 3 * GB } }, loaded: { 'qwen3:4b': { size: 3 * GB, size_vram: 3 * GB } } });
  try {
    host.state.dropTimings = true;
    const client = hostClient({ name: 'box', url: host.url });
    const r = await measureSpeed(client, { model: 'qwen3:4b', runs: 2 });
    assert.equal(isUnavailable(r.runs[0].genTokS), true); assert.equal(isUnavailable(r.warm.genTokS), true);
    assert.ok(Number.isInteger(r.runs[0].ttftMs), 'time to first token is timed here, so it is still known');
    const text = speedLines(r).join('\n');
    assert.match(text, /writing speed:\s+unavailable \(no run reported it\)/);
    assert.ok(!/NaN|Infinity|undefined|null tokens/.test(text), text);
    const json = speedAsJson(r);
    assert.deepEqual(json.warm.genTokS, { unavailable: true, reason: 'no run reported it' });
    assert.ok(!JSON.stringify(json).includes('NaN'));
  } finally { await host.close(); }
});

// ── keeping a model loaded ─────────────────────────────────────────────────────────────────────

test('times are read the way Ollama writes them', () => {
  assert.equal(parseKeepAlive('24h'), '24h'); assert.equal(parseKeepAlive('90'), 90); assert.equal(parseKeepAlive('forever'), -1); assert.equal(parseKeepAlive(''), '30m');
  assert.throws(() => parseKeepAlive('soon'), /not a time/);
});

test('warming is planned from what is loaded: it fits, it must ask, or it cannot be told', () => {
  const ours = { box: { 'mine:1': {} } };
  const base = { model: 'new:1', needBytes: 4 * GB, budgetBytes: 8 * GB, ours, hostName: 'box' };
  assert.equal(planWarm({ ...base, resident: [] }).action, 'load');
  assert.equal(planWarm({ ...base, resident: [{ name: 'new:1', bytes: 4 * GB }] }).action, 'already-loaded');
  assert.equal(planWarm({ ...base, resident: [{ name: 'other:1', bytes: 3 * GB }] }).action, 'load');
  const tight = planWarm({ ...base, resident: [{ name: 'theirs:1', bytes: 3 * GB }, { name: 'mine:1', bytes: 3 * GB }] });
  assert.equal(tight.action, 'ask'); assert.equal(tight.fits, false);
  assert.deepEqual(tight.wouldUnload.map((o) => [o.name, o.ours]), [['mine:1', true]], 'Kingmaker\'s own model goes first, and that is enough');
  const both = planWarm({ ...base, needBytes: 7 * GB, resident: [{ name: 'theirs:1', bytes: 3 * GB }, { name: 'mine:1', bytes: 3 * GB }] });
  assert.deepEqual(both.wouldUnload.map((o) => o.name), ['mine:1', 'theirs:1']); assert.match(both.why, /theirs:1 \(not loaded by Kingmaker\)/);
  const never = planWarm({ ...base, needBytes: 20 * GB, resident: [{ name: 'theirs:1', bytes: 3 * GB }] });
  assert.equal(never.impossible, true);
  const blind = planWarm({ ...base, budgetBytes: unavailable('another machine'), resident: [{ name: 'theirs:1', bytes: 3 * GB }] });
  assert.equal(blind.action, 'ask'); assert.equal(isUnavailable(blind.fits), true); assert.match(blind.why, /cannot be worked out/);
  const pinned = planWarm({ ...base, needBytes: 4 * GB, budgetBytes: 6 * GB, pinned: ['reflex:1'], ours: { box: { 'mine:1': {} } }, resident: [{ name: 'reflex:1', bytes: 2 * GB }, { name: 'mine:1', bytes: 2 * GB }] });
  assert.deepEqual(pinned.wouldUnload.map((o) => o.name), ['mine:1'], 'the pinned seat is the last thing to go');
});

test('warming never unloads another model unless told to, and stop-all leaves other people\'s models', async () => {
  const dir = tmp();
  const host = await fakeOllama({ models: { 'theirs:1': { digest: 't', size: 5 * GB }, 'mine:1': { digest: 'm', size: 5 * GB }, 'small:1': { digest: 's', size: 1 * GB } }, loaded: { 'theirs:1': { size: 5 * GB, size_vram: 5 * GB } } });
  try {
    const client = hostClient({ name: 'box', url: host.url });
    const refused = await warmModel(client, { stateDir: dir, model: 'mine:1', needBytes: 5 * GB, budgetBytes: 8 * GB });
    assert.equal(refused.loaded, false); assert.equal(refused.plan.action, 'ask');
    assert.deepEqual(Object.keys(host.state.loaded), ['theirs:1'], 'nothing was touched');
    assert.deepEqual(readOurs(dir), {});

    const fits = await warmModel(client, { stateDir: dir, model: 'small:1', needBytes: 1 * GB, budgetBytes: 8 * GB, keepAlive: '24h' });
    assert.equal(fits.loaded, true); assert.equal(host.state.loaded['small:1'].keep_alive, '24h');
    assert.ok(readOurs(dir).box['small:1']);

    const forced = await warmModel(client, { stateDir: dir, model: 'mine:1', needBytes: 5 * GB, budgetBytes: 8 * GB, evict: true });
    assert.equal(forced.loaded, true);
    assert.deepEqual(forced.unloaded, ['small:1', 'theirs:1'], 'Kingmaker\'s own went first; the other one only because it was allowed');

    host.state.loaded['theirs:1'] = { size: 5 * GB, size_vram: 5 * GB };
    const stop = await stopModels(client, { stateDir: dir, target: 'all' });
    assert.deepEqual(stop.unloaded, ['mine:1']);
    assert.deepEqual(stop.left.map((l) => l.name), ['theirs:1']); assert.match(stop.left[0].why, /--everyone/);
    assert.deepEqual(Object.keys(host.state.loaded), ['theirs:1']);
    const everyone = await stopModels(client, { stateDir: dir, target: 'all', everyone: true });
    assert.deepEqual(everyone.unloaded, ['theirs:1']);
    assert.deepEqual((await stopModels(client, { stateDir: dir, target: 'mine:1' })).left, [{ name: 'mine:1', why: 'it is not loaded' }]);
  } finally { await host.close(); rmSync(dir, { recursive: true, force: true }); }
});

// ── doctor and the commands ────────────────────────────────────────────────────────────────────

test('the memory limit is known for this Mac, and unavailable for another machine unless the owner gives one', () => {
  // The local limit is the MEASURED free memory (injected here through the function's own
  // freeBytes seam) — not a class fraction of total RAM: the class budget died with the profiles.
  assert.equal(memoryBudgetBytes({ name: 'this-mac', kind: 'local' }, { env: {}, freeBytes: 4.8 * GB }), 4.8 * GB);
  assert.equal(isUnavailable(memoryBudgetBytes({ name: 'studio', kind: 'lan' }, { env: {}, ramBytes: 8 * GB })), true);
  assert.equal(memoryBudgetBytes({ name: 'studio', kind: 'lan' }, { env: { KINGMAKER_MODEL_BUDGET_GB: '24' }, ramBytes: 8 * GB }), 24 * GB);
});

test('doctor rows name each problem with its fix, and the scorecard counts only real checks', async () => {
  const dir = tmp();
  const host = await fakeOllama({ models: { 'qwen3:4b': { digest: 'd', size: 3 * GB } }, loaded: { 'qwen3:4b': { size: 3 * GB, size_vram: 2 * GB } } });
  try {
    saveHost(dir, { name: 'studio', url: host.url }, {});
    saveHost(dir, { name: 'gone', url: 'http://127.0.0.1:9' }, {});
    const report = await modelHostDoctor({ stateDir: dir, env: { OLLAMA_HOST: host.url, OLLAMA_MODELS: dir }, freeBytesOf: () => 50 * GB });
    const lines = doctorLines(report.rows);
    const text = lines.join('\n');
    assert.match(text, /✓ model host this-mac \(http:\/\/127\.0\.0\.1:\d+\): answering in \d+ ms, Ollama 0\.9\.9, 1 model installed/);
    assert.match(text, /· loaded on studio: qwen3:4b, 3\.00 GB in memory, 2\.00 GB on the GPU \(not loaded by Kingmaker\)/);
    assert.match(text, /✗ model host gone \(http:\/\/127\.0\.0\.1:9\): not answering/);
    assert.match(text, /→ Check that gone is on and reachable, or remove it: kingmaker models hosts remove gone/);
    assert.match(text, /✓ model folder .*: 50\.00 GB free/);
    assert.equal(scorecardLine(text.split('\n')), '3 of 4 checks pass. 1 needs attention (marked ✗, each with its fix on the line below it).');
    assert.equal(scorecardLine(['✓ a', '· info', '✓ b']), 'All 2 checks pass.');
    assert.equal(scorecardLine(['· only information']), null);
    const low = await modelHostDoctor({ stateDir: dir, env: { OLLAMA_HOST: host.url }, freeBytesOf: () => 1 * GB });
    assert.ok(low.rows.some((r) => r.ok === false && /1\.00 GB free/.test(r.text) && /Under 5 GB/.test(r.fix)));
    const blind = await modelHostDoctor({ stateDir: dir, env: { OLLAMA_HOST: host.url }, freeBytesOf: () => unavailable('the folder is not there yet') });
    assert.ok(blind.rows.some((r) => r.ok === null && /free space unavailable \(the folder is not there yet\)/.test(r.text)));
  } finally { await host.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a host that withholds a key, or is reached in the clear across the internet, is a failed check', () => {
  const rows = hostReportRows({ name: 'far', url: 'http://models.example.com:11434', kind: 'remote', reachable: true, latencyMs: 40, version: '1.0', installedCount: 2, resident: [], credential: { key: 'withheld', why: 'plain http across the internet' } });
  assert.equal(rows.filter((r) => r.ok === false).length, 2);
  assert.match(doctorLines(rows).join('\n'), /✗ key for far: not sent\n {4}→ plain http/);
});

test('the commands: add a host, list it, copy a model to it, warm it, see whose it is, time it, stop it', async () => {
  const dir = tmp(); const store = tmp();
  const local = await fakeOllama(); const studio = await fakeOllama();
  const out = []; const err = [];
  const run = (verb, ...args) => cmdModelHosts({ state: dir }, verb, args, { env: { OLLAMA_HOST: local.url, OLLAMA_MODELS: store, KINGMAKER_MODEL_BUDGET_GB: '8' }, out: (l) => out.push(l), err: (l) => err.push(l) });
  try {
    const made = localStore(store, 'qwen3:4b');
    local.state.models['qwen3:4b'] = { digest: made.manifestDigest, size: made.bytes };

    assert.equal(await run('hosts', 'add', 'studio', studio.url), 0);
    assert.equal(await run('hosts', 'add', 'bad', '10.0.0.1', '--key-env', 'OPENAI_API_KEY'), 1);
    assert.match(err.at(-1), /provider keys/);
    out.length = 0; assert.equal(await run('hosts'), 0);
    assert.match(out.join('\n'), /✓ model host this-mac .*\n· loaded on this-mac: nothing\n✓ model host studio /);

    out.length = 0; assert.equal(await run('sync', 'qwen3:4b', '--to', 'studio', '--dry-run'), 0);
    assert.deepEqual(out, ['qwen3:4b: not on the destination']); assert.equal(studio.state.creates.length, 0);
    out.length = 0; assert.equal(await run('sync', 'qwen3:4b', '--to', 'studio'), 0);
    assert.match(out.at(-1), /^✓ qwen3:4b: Every weight file is on the destination under the same SHA-256/);
    assert.ok(studio.state.models['qwen3:4b']);
    assert.equal(await run('sync', 'qwen3:4b', '--to', 'this-mac'), 1); assert.match(err.at(-1), /same host/);
    assert.equal(await run('sync', 'nope:1', '--to', 'studio'), 1);

    out.length = 0; assert.equal(await run('warm', 'qwen3:4b', '24h', '--host', 'studio'), 0);
    assert.match(out.at(-1), /qwen3:4b is loaded on studio, held for 24h\./);
    out.length = 0; assert.equal(await run('ps', '--host', 'studio'), 0);
    assert.match(out[0], /^qwen3:4b {2}0\.00 GB in memory, .*\(Kingmaker's\)$/);
    assert.equal(await run('warm', 'not-installed:1', '--host', 'studio'), 1);
    assert.match(err.at(-1), /studio does not have not-installed:1 installed.*\n {4}→ kingmaker models sync not-installed:1 --to studio/);

    out.length = 0; assert.equal(await run('speed', 'qwen3:4b', '--host', 'studio', '--runs', '2', '--json'), 0);
    const json = JSON.parse(out.join('\n'));
    assert.equal(json.host, 'studio'); assert.equal(json.runs.length, 2); assert.equal(json.warm.runs, 2);

    out.length = 0; assert.equal(await run('stop', 'all', '--host', 'studio'), 0);
    assert.match(out[0], /Unloaded on studio: qwen3:4b\./);
    assert.equal(await run('hosts', 'remove', 'studio'), 0);
    assert.equal(await run('ps', '--host', 'studio'), 1); assert.match(err.at(-1), /no host named "studio"/);
  } finally { await local.close(); await studio.close(); rmSync(dir, { recursive: true, force: true }); rmSync(store, { recursive: true, force: true }); }
});

test('without --evict, a model that would push another out is not loaded and the command says how to go ahead', async () => {
  const dir = tmp();
  const host = await fakeOllama({ models: { 'theirs:1': { digest: 't', size: 6 * GB }, 'mine:1': { digest: 'm', size: 6 * GB } }, loaded: { 'theirs:1': { size: 6 * GB, size_vram: 6 * GB } } });
  const out = []; const err = [];
  const run = (verb, ...args) => cmdModelHosts({ state: dir }, verb, args, { env: { OLLAMA_HOST: host.url, KINGMAKER_MODEL_BUDGET_GB: '8' }, out: (l) => out.push(l), err: (l) => err.push(l) });
  try {
    assert.equal(await run('warm', 'mine:1'), 2);
    assert.match(out.join('\n'), /would unload: theirs:1 \(not loaded by Kingmaker\)/);
    assert.match(out.at(-1), /Nothing was changed\. To go ahead: kingmaker models warm mine:1 --evict/);
    assert.deepEqual(Object.keys(host.state.loaded), ['theirs:1']);
    assert.equal(await run('warm', 'mine:1', '--evict'), 0);
    assert.deepEqual(Object.keys(host.state.loaded), ['mine:1']);
    assert.match(out.at(-1), /Unloaded to make room: theirs:1\./);
  } finally { await host.close(); rmSync(dir, { recursive: true, force: true }); }
});

// ── found in review ────────────────────────────────────────────────────────────────────────────

test('a public name that only starts like a private address is remote, and gets no key over plain http', () => {
  for (const u of ['http://10.models.example.com:11434', 'http://127.models.example.com:11434', 'http://192.168.evil.example:11434', 'http://172.16.example.org:1', 'http://100.64.example.net:1']) {
    assert.equal(hostKind(u), 'remote', u);
    const c = credentialFor({ name: 'x', url: u, keyEnv: 'STUDIO_KEY' }, { STUDIO_KEY: 'studio-secret' });
    assert.equal(c.key, 'withheld', u); assert.deepEqual(c.headers, {}, u);
  }
  assert.throws(() => hostKind('http://999.1.1.1:1'), /not an address/, 'numbers that are not an address are refused outright');
  assert.equal(hostKind('http://10.0.0.5:11434'), 'lan'); assert.equal(hostKind('http://127.0.0.1:11434'), 'local');
  assert.equal(hostKind('http://[fd12:3456::1]:11434'), 'lan'); assert.equal(hostKind('http://[2001:db8::1]:11434'), 'remote');
  assert.equal(hostKind('http://nas.home.arpa:11434'), 'lan');
});

test('a port the owner typed is kept, including 80 and 443', () => {
  assert.equal(normalizeUrl('http://models.example.com:80'), 'http://models.example.com:80');
  assert.equal(normalizeUrl('http://models.example.com:80/'), 'http://models.example.com:80');
  assert.equal(normalizeUrl('https://models.example.com:443'), 'https://models.example.com:443');
  assert.equal(normalizeUrl('https://models.example.com:8443'), 'https://models.example.com:8443');
  assert.equal(normalizeUrl('models.example.com:80'), 'http://models.example.com:80');
  assert.equal(normalizeUrl('http://models.example.com'), 'http://models.example.com:11434', 'no port typed: Ollama\'s');
  assert.equal(normalizeUrl('http://[::1]:80'), 'http://[::1]:80');
});

test('the size of a model\'s file never counts as "it fits": only a size seen loaded on that host does', async () => {
  const base = { model: 'new:1', budgetBytes: 8 * GB, ours: {}, hostName: 'box', resident: [{ name: 'theirs:1', bytes: 3 * GB }] };
  const floorFits = planWarm({ ...base, needBytes: unavailable('not measured'), atLeastBytes: 4 * GB });
  assert.equal(floorFits.action, 'ask', 'a 4 GB file beside 3 GB in an 8 GB limit looks like it fits, and that is exactly the trap');
  assert.equal(isUnavailable(floorFits.fits), true); assert.match(floorFits.why, /cannot be worked out/);
  const floorTooBig = planWarm({ ...base, needBytes: unavailable('not measured'), atLeastBytes: 6 * GB });
  assert.equal(floorTooBig.fits, false, 'when even the file does not fit, that much is certain');
  assert.deepEqual(floorTooBig.wouldUnload.map((o) => o.name), ['theirs:1']);
  assert.equal(planWarm({ ...base, needBytes: 4 * GB, atLeastBytes: 3 * GB }).action, 'load', 'a measured size that fits is trusted');

  const dir = tmp();
  const host = await fakeOllama({ models: { 'theirs:1': { digest: 't', size: 3 * GB }, 'mine:1': { digest: 'm', size: 4 * GB } } });
  try {
    const client = hostClient({ name: 'box', url: host.url });
    assert.equal(isUnavailable(measuredNeed(dir, 'box', 'mine:1')), true);
    await warmModel(client, { stateDir: dir, model: 'mine:1', atLeastBytes: 4 * GB, budgetBytes: 8 * GB });
    assert.equal(measuredNeed(dir, 'box', 'mine:1'), 4 * GB, 'after one load the real figure is on file');
    await stopModels(client, { stateDir: dir, target: 'mine:1' });
    assert.equal(measuredNeed(dir, 'box', 'mine:1'), 4 * GB, 'and it is kept after the model is unloaded');
    host.state.loaded['theirs:1'] = { size: 3 * GB, size_vram: 3 * GB };
    const next = await warmModel(client, { stateDir: dir, model: 'mine:1', atLeastBytes: 4 * GB, budgetBytes: 8 * GB });
    assert.equal(next.loaded, true, 'now it is known to fit beside the other one, so it loads without asking');
    assert.deepEqual(Object.keys(host.state.loaded).sort(), ['mine:1', 'theirs:1']);
    const fresh = await warmModel(hostClient({ name: 'box', url: host.url }), { stateDir: tmp(), model: 'mine:1', atLeastBytes: 4 * GB, budgetBytes: 8 * GB });
    assert.equal(fresh.plan.action, 'already-loaded');
  } finally { await host.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a first run that cannot be told cold from warm is left out of the typical figures', async () => {
  const host = await fakeOllama({ models: { 'qwen3:4b': { digest: 'd', size: 3 * GB } } });
  try {
    host.state.dropTimings = true; // the host reports no load time
    const real = hostClient({ name: 'box', url: host.url });
    let psCalls = 0;
    const client = { ...real, ps: async () => { psCalls += 1; if (psCalls === 1) throw new Error('ps failed'); return real.ps(); } };
    const r = await measureSpeed(client, { model: 'qwen3:4b', runs: 3 });
    assert.deepEqual(r.runs.map((x) => x.cold), [null, false, false]);
    assert.equal(r.warm.runs, 2, 'only the two runs known to be warm are counted');
    assert.equal(r.cold, null);
    assert.ok(r.notes.some((n) => /Run 1 is left out/.test(n)));
    const only = await measureSpeed({ ...real, ps: async () => { throw new Error('ps failed'); } }, { model: 'qwen3:4b', runs: 1 });
    assert.equal(isUnavailable(only.warm), true); assert.match(speedLines(only).join('\n'), /warm: unavailable \(no run is known to be a warm one\)/);
  } finally { await host.close(); }
});

test('sync with no model and no --all copies nothing', async () => {
  const dir = tmp(); const store = tmp();
  const local = await fakeOllama({ models: { 'a:1': { digest: 'x', size: 10 }, 'b:1': { digest: 'y', size: 10 } } }); const studio = await fakeOllama();
  const out = []; const err = [];
  const run = (verb, ...args) => cmdModelHosts({ state: dir }, verb, args, { env: { OLLAMA_HOST: local.url, OLLAMA_MODELS: store }, out: (l) => out.push(l), err: (l) => err.push(l) });
  try {
    await run('hosts', 'add', 'studio', studio.url);
    assert.equal(await run('sync', '--to', 'studio'), 1);
    assert.match(err.at(-1), /Name a model, or pass --all/);
    assert.equal(studio.state.pulls.length + studio.state.creates.length, 0);
    out.length = 0; assert.equal(await run('sync', '--all', '--to', 'studio', '--dry-run'), 0);
    assert.deepEqual(out, ['a:1: not on the destination', 'b:1: not on the destination']);
  } finally { await local.close(); await studio.close(); rmSync(dir, { recursive: true, force: true }); rmSync(store, { recursive: true, force: true }); }
});

test('stored messages travel with an exact copy; a part this code does not know stops the exact copy', async () => {
  const dir = tmp(); const dest = await fakeOllama(); const src = await fakeOllama();
  try {
    const made = localStore(dir, 'tutor:1');
    const addLayer = (name, mediaType, bytes) => {
      const n = parseModelName(name), file = join(dir, 'manifests', n.registry, n.namespace, n.model, n.tag);
      const m = JSON.parse(readFileSync(file, 'utf8'));
      const d = sha(bytes); writeFileSync(join(dir, 'blobs', `sha256-${d}`), bytes);
      m.layers.push({ mediaType, digest: `sha256:${d}`, size: bytes.length });
      writeFileSync(file, JSON.stringify(m));
    };
    const turns = [{ role: 'user', content: 'What is 2+2?' }, { role: 'assistant', content: '4.' }];
    addLayer('tutor:1', 'application/vnd.ollama.image.messages', Buffer.from(JSON.stringify(turns)));
    const local = readLocalModel('tutor:1', { modelsDir: dir });
    assert.deepEqual(local.text.messages, turns); assert.deepEqual(local.unsupported, []);
    assert.deepEqual(createRequest(local).messages, turns);
    src.state.models['tutor:1'] = { digest: made.manifestDigest, size: made.bytes };
    const from = hostClient({ name: 'this-mac', url: src.url }), to = hostClient({ name: 'studio', url: dest.url });
    await syncModel({ model: 'tutor:1', from, to, local: true, modelsDir: dir });
    assert.deepEqual(dest.state.creates.at(-1).messages, turns, 'the destination was asked to build it with the same example turns');

    localStore(dir, 'odd:1');
    addLayer('odd:1', 'application/vnd.ollama.image.something-new', Buffer.from('x'));
    const odd = createRequest(readLocalModel('odd:1', { modelsDir: dir }));
    assert.equal(odd.unavailable, true); assert.match(odd.reason, /something-new/);
    localStore(dir, 'badturns:1');
    addLayer('badturns:1', 'application/vnd.ollama.image.messages', Buffer.from('not json'));
    assert.equal(createRequest(readLocalModel('badturns:1', { modelsDir: dir })).unavailable, true);
  } finally { await dest.close(); await src.close(); rmSync(dir, { recursive: true, force: true }); }
});
