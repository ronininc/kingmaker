import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { materializeLibraryModel } from '../lib/brain-library-fetch.mjs';
import { CARD_MEDIAN_TAG, chooseCardLibraryModel, materializeCardLibraryModel } from '../lib/brain-library-task.mjs';
import { resolveModelStorage, usesModelCard } from '../lib/model-storage.mjs';
import { parseModelName } from '../lib/model-sync.mjs';

const sha = (data) => createHash('sha256').update(data).digest('hex');
const payloads = [Buffer.from('GGUF fixture '), Buffer.from('part two'), Buffer.from('FROM\trelease-source\nPARAMETER temperature 0.2\n')];
const whole = Buffer.concat(payloads.slice(0, 2));
const names = ['fixture.gguf.part-1', 'fixture.gguf.part-2', 'Modelfile'];
const model = {
  tag: CARD_MEDIAN_TAG, slug: 'huihui-ai-qwen3-abliterated-1.7b',
  weights: {
    release: 'fixture-release', gguf: 'fixture.gguf', size: whole.length, sha256: sha(whole),
    parts: payloads.slice(0, 2).map((data, index) => ({ name: names[index], size: data.length, sha256: sha(data) })),
  },
};
const assetPaths = ['/tags/fixture-release', '/assets/1', '/assets/2', '/assets/3'];

async function fixture(t, { onAsset = (id) => payloads[id - 1] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'km-library-on-demand-'));
  const card = join(root, 'card');
  mkdirSync(card);
  const paths = { state: join(root, 'state') };
  const calls = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname.replace(/^\/repos\/[^/]+\/[^/]+\/releases/, '');
    calls.push(path);
    if (path === assetPaths[0]) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ assets: names.map((name, index) => ({ id: index + 1, name })) }));
      return;
    }
    const id = assetPaths.indexOf(path);
    if (id > 0) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(onAsset(id, { card, root }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  t.after(async () => {
    await new Promise((closed) => server.close(closed));
    rmSync(root, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const fetchImpl = (url, options) => fetch(baseUrl + new URL(url).pathname, options);
  const resolveStorage = () => resolveModelStorage(paths.state, {
    env: { KINGMAKER_MODEL_CARD: card }, totalMemBytes: 8 * 2 ** 30,
    mountDevice: (path) => lstatSync(path, { throwIfNoEntry: false })?.dev,
  });
  const storage = resolveStorage();
  const dir = join(storage.libraryDir, model.slug, model.weights.sha256);
  const gguf = join(dir, model.weights.gguf);
  const registrations = [];
  const ensureRuntime = async ({ storage: target }) => {
    assert.equal(target.modelsDir, storage.modelsDir);
    return { up: true, bin: '/fixture/ollama', baseUrl };
  };
  const run = (bin, args, { env }) => {
    assert.equal(bin, '/fixture/ollama');
    assert.equal(env.OLLAMA_HOST, baseUrl);
    assert.deepEqual(args, ['create', model.tag, '-f', join(dir, 'Modelfile')]);
    assert.equal(sha(readFileSync(gguf)), model.weights.sha256);
    assert.ok(readFileSync(args[3], 'utf8').startsWith(`FROM ${JSON.stringify(gguf)}\n`));
    registrations.push(args);
    return { status: 0 };
  };
  const opts = { fetchImpl, run, ensureRuntime };
  return { root, card, paths, storage, resolveStorage, dir, gguf, calls, registrations, opts, baseUrl };
}

test('only an unpinned local text task fetches the pinned 8 GB median and registers it on the card', async (t) => {
  const f = await fixture(t);
  let loads = 0;
  const loadCatalog = async () => {
    loads += 1;
    return { models: [{ ...model, tag: 'untested:9b' }, model] };
  };
  const choose = (text, pin) => chooseCardLibraryModel({
    text, pin, paths: f.paths, resolveStorage: f.resolveStorage, loadCatalog, ...f.opts,
  });
  assert.equal(await choose('send the invoice to Ada'), null);
  assert.equal(await choose('draw a logo of a crane'), null);
  assert.equal(await choose('draft a note for Ada', 'owner-pinned:1b'), null);
  assert.equal(loads, 0);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await choose('draft a note for Ada'), {
    hunted: true, model: model.tag, role: 'writer', availability: 'materialized', baseUrl: f.baseUrl, swap: false,
  });
  assert.equal(loads, 1);
  assert.deepEqual(f.calls, assetPaths);
  assert.equal(f.registrations.length, 1);
  assert.deepEqual(readdirSync(f.dir).sort(), ['Modelfile', 'fixture.gguf']);
  assert.equal(existsSync(f.paths.state), false);
});

test('a republished model with a wrong part SHA is never assembled or registered', async (t) => {
  const f = await fixture(t, { onAsset: (id) => id === 2 ? Buffer.alloc(payloads[1].length, 1) : payloads[id - 1] });
  await assert.rejects(materializeCardLibraryModel(f.paths, f.storage, model, f.opts), /asset SHA-256 .* did not match/);
  assert.deepEqual(f.calls, assetPaths.slice(0, 3));
  assert.deepEqual(readdirSync(f.dir), []);
  assert.equal(f.registrations.length, 0);
});

test('a model whose valid parts do not yield the whole GGUF SHA is never registered', async (t) => {
  const f = await fixture(t);
  const bad = { ...model, weights: { ...model.weights, sha256: 'b'.repeat(64) } };
  await assert.rejects(materializeCardLibraryModel(f.paths, f.storage, bad, f.opts), /joined GGUF SHA-256 .* did not match/);
  assert.deepEqual(f.calls, assetPaths.slice(0, 3));
  assert.deepEqual(readdirSync(join(f.storage.libraryDir, model.slug, bad.weights.sha256)), []);
  assert.equal(f.registrations.length, 0);
});

test('an assembled card GGUF is checked against the pin regardless of a sidecar', async (t) => {
  const f = await fixture(t);
  mkdirSync(f.dir, { recursive: true });
  writeFileSync(f.gguf, Buffer.alloc(whole.length));
  writeFileSync(`${f.gguf}.sha256`, model.weights.sha256);
  const result = await materializeCardLibraryModel(f.paths, f.storage, model, f.opts);
  assert.deepEqual(f.calls, assetPaths, 'corrupted artifact is downloaded again');
  assert.equal(result.streamedToOllama, false);
  assert.equal(result.sha256, model.weights.sha256);
  assert.deepEqual(readFileSync(f.gguf), whole);
  const second = await materializeCardLibraryModel(f.paths, f.storage, model, f.opts);
  assert.deepEqual(f.calls, assetPaths, 'verified artifact and Modelfile are reused');
  assert.equal(second.gguf, result.gguf);
});

test('the task can reuse a registered pinned Ollama blob and detects a same-size replacement', async (t) => {
  const f = await fixture(t);
  const parsed = parseModelName(model.tag);
  const manifests = join(f.storage.modelsDir, 'manifests', parsed.registry, parsed.namespace, parsed.model);
  const blobs = join(f.storage.modelsDir, 'blobs');
  mkdirSync(manifests, { recursive: true });
  mkdirSync(blobs, { recursive: true });
  const blob = join(blobs, `sha256-${model.weights.sha256}`);
  writeFileSync(blob, whole);
  writeFileSync(join(manifests, parsed.tag), JSON.stringify({
    layers: [{ mediaType: 'application/vnd.ollama.image.model', digest: `sha256:${model.weights.sha256}`, size: whole.length }],
  }));
  const params = {
    text: 'draft a note', paths: f.paths, resolveStorage: f.resolveStorage, loadCatalog: async () => ({ models: [model] }), ...f.opts,
  };
  assert.equal((await chooseCardLibraryModel(params)).availability, 'installed');
  writeFileSync(`${blob}.changed`, Buffer.alloc(whole.length));
  renameSync(`${blob}.changed`, blob);
  await assert.rejects(chooseCardLibraryModel(params), /Ollama's card weights .* did not match/);
  assert.deepEqual(f.calls, []);
  assert.equal(f.registrations.length, 0);
});

test('an absent card or a stalled card transfer never falls back to the internal disk', async (t) => {
  const f = await fixture(t, { onAsset: (id, { card, root }) => {
    if (id === 1) renameSync(card, join(root, 'detached-card'));
    return payloads[id - 1];
  } });
  let loads = 0;
  const params = {
    text: 'draft a note', paths: f.paths, resolveStorage: f.resolveStorage,
    loadCatalog: async () => { loads += 1; return { models: [model] }; }, ...f.opts,
  };
  await assert.rejects(chooseCardLibraryModel(params), /Kingmaker model card is missing/);
  assert.deepEqual(f.calls, assetPaths.slice(0, 2));
  await assert.rejects(chooseCardLibraryModel(params), /Kingmaker model card is missing/);
  assert.equal(loads, 1);
  assert.equal(existsSync(f.paths.state), false);
  assert.equal(existsSync(f.card), false);
  assert.equal(f.registrations.length, 0);
});

test('missing median pins fail before requesting release assets', async (t) => {
  const f = await fixture(t);
  await assert.rejects(chooseCardLibraryModel({
    text: 'draft a note', paths: f.paths, resolveStorage: f.resolveStorage, ...f.opts,
    loadCatalog: async () => ({ models: [{ ...model, weights: null }, { ...model, tag: 'untested:9b' }] }),
  }), /The Brain Library has no pinned weights/);
  assert.deepEqual(f.calls, []);
  assert.equal(existsSync(f.storage.libraryDir), false);
});

test('above 8 GB library assembly keeps the local state layout', async (t) => {
  const f = await fixture(t);
  assert.equal(usesModelCard(16 * 2 ** 30), false);
  const storage = resolveModelStorage(f.paths.state, {
    totalMemBytes: 16 * 2 ** 30, mountDevice: () => assert.fail('local layout must not resolve a card'),
  });
  const dir = join(storage.libraryDir, model.slug);
  const result = await materializeLibraryModel(model, { dir, fetchImpl: f.opts.fetchImpl });
  assert.equal(result.gguf, join(f.paths.state, 'models', 'library', model.slug, model.weights.gguf));
  assert.deepEqual(readFileSync(result.gguf), whole);
  assert.equal(existsSync(f.storage.libraryDir), false);
});
