import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkCardDirectory, isInternalModel, resolveModelStorage, usesModelCard } from '../lib/model-storage.mjs';
import { ensureCardOllama } from '../lib/ollama-runtime.mjs';
import { fakeOllama } from './fixtures/fake-ollama.mjs';

const GB = 2 ** 30;
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'kingmaker-model-card-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const card = join(root, 'synthetic card');
  const state = join(root, 'internal');
  const paths = { state, logs: join(state, 'logs') };
  const env = { ...process.env, KINGMAKER_MODEL_CARD: card, KINGMAKER_OLLAMA_MODELS: join(root, 'internal-override') };
  mkdirSync(card);
  const mountDevice = (dir) => lstatSync(dir, { throwIfNoEntry: false })?.dev ?? null;
  return { root, card, state, paths, env, resolve: (totalMemBytes = 8 * GB) => resolveModelStorage(state, { env, totalMemBytes, mountDevice }) };
}

test('8 GiB and smaller use the card for Ollama and Brain Library assembly', (t) => {
  const f = fixture(t);
  assert.equal(usesModelCard(8 * GB), true);
  assert.equal(usesModelCard(8 * GB + 1), false);
  for (const size of [4, 8]) {
    const storage = f.resolve(size * GB);
    assert.equal(storage.modelsDir, join(f.card, 'ollama-models'));
    assert.equal(storage.libraryDir, join(f.card, 'models', 'library'));
    const dest = checkCardDirectory(storage, join(storage.libraryDir, 'fixture-model'), { create: true });
    writeFileSync(join(dest, 'weights.gguf'), 'synthetic');
    assert.equal(readFileSync(join(f.card, 'models', 'library', 'fixture-model', 'weights.gguf'), 'utf8'), 'synthetic');
    assert.equal(existsSync(f.state), false);
    assert.equal(existsSync(f.env.KINGMAKER_OLLAMA_MODELS), false);
  }
});

test('larger machines preserve both internal paths and explicit Ollama override priority', async (t) => {
  const f = fixture(t);
  const env = { ...f.env, KINGMAKER_MODEL_CARD: 'invalid-relative-card', OLLAMA_MODELS: '/other/models' };
  const layout = resolveModelStorage(f.state, { env, totalMemBytes: 8 * GB + 1 });
  assert.deepEqual(layout, {
    cardRoot: null,
    modelsDir: f.env.KINGMAKER_OLLAMA_MODELS,
    libraryDir: join(f.state, 'models', 'library'),
  });
  assert.equal(resolveModelStorage(f.state, { env: { OLLAMA_MODELS: '/other/models' }, totalMemBytes: 16 * GB }).modelsDir, '/other/models');
  assert.equal(await ensureCardOllama({ paths: f.paths, storage: layout }), null);
});

test('missing or unmounted card fails plainly and does not create a directory or fall back', (t) => {
  const f = fixture(t);
  const expected = /Kingmaker model card is missing.*Insert the card/;
  assert.throws(() => resolveModelStorage(f.state, { env: f.env, totalMemBytes: 8 * GB }), expected);
  const storage = f.resolve();
  rmSync(f.card, { recursive: true });
  assert.throws(() => f.resolve(), expected);
  assert.throws(() => checkCardDirectory(storage, storage.modelsDir, { create: true }), expected);
  assert.equal(existsSync(f.card), false);
  assert.equal(existsSync(f.state), false);
  assert.equal(existsSync(f.env.KINGMAKER_OLLAMA_MODELS), false);
});

test('a pinned installation refuses the wrong card identity without writing', (t) => {
  const f = fixture(t);
  const env = { ...f.env, KINGMAKER_MODEL_CARD_UUID: 'EXPECTED-CARD' };
  assert.throws(
    () => resolveModelStorage(f.state, { env, totalMemBytes: 8 * GB, mountDevice: () => 42, cardIdentity: () => 'other-card' }),
    /Wrong Kingmaker model card.*expected UUID EXPECTED-CARD.*found OTHER-CARD/,
  );
  assert.equal(existsSync(f.state), false);
  assert.equal(existsSync(f.env.KINGMAKER_OLLAMA_MODELS), false);
});

test('an apparent card subdirectory cannot redirect model writes to disk', (t) => {
  const f = fixture(t);
  const storage = f.resolve();
  mkdirSync(f.state);
  symlinkSync(f.state, join(f.card, 'models'), 'dir');
  assert.throws(() => checkCardDirectory(storage, storage.libraryDir, { create: true }), /must be on the Kingmaker model card/);
  assert.throws(() => checkCardDirectory(storage, f.state, { create: true }), /must be on the Kingmaker model card/);
  assert.equal(existsSync(join(f.state, 'library')), false);
});

test('the Open-JEV tag and slug are reserved for the internal lane', () => {
  assert.equal(isInternalModel({ tag: 'zefancai/open-jev-2b:merged' }), true);
  assert.equal(isInternalModel({ slug: 'zefancai-open-jev-2b-merged' }), true);
  assert.equal(isInternalModel('open-jev:latest'), true);
  assert.equal(isInternalModel('open-jev-experiment:latest'), false);
  assert.equal(isInternalModel('qwen3:1.7b'), false);
});

test('an unowned Ollama endpoint is refused before any model-store writes', async (t) => {
  const f = fixture(t);
  const server = await fakeOllama();
  t.after(() => server.close());
  await assert.rejects(ensureCardOllama({
    paths: f.paths, env: f.env, storage: f.resolve(), port: Number(new URL(server.base).port),
  }), /without a matching Kingmaker model-card store/);
  assert.deepEqual(server.requests.map(({ path }) => path), ['/api/tags']);
  assert.equal(existsSync(join(f.card, 'ollama-models')), false);
});

test('managed Ollama receives the checked card store and reuses only its own listener', {
  skip: !existsSync('/usr/sbin/lsof'),
}, async (t) => {
  const f = fixture(t);
  const portProbe = createServer();
  await new Promise((resolve) => portProbe.listen(0, '127.0.0.1', resolve));
  const port = portProbe.address().port;
  await new Promise((resolve) => portProbe.close(resolve));

  const bin = join(f.root, 'fake-ollama');
  writeFileSync(bin, `#!${process.execPath}
const { createServer } = require('node:http');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const [ip, port] = process.env.OLLAMA_HOST.split(':');
createServer((req, res) => {
  if (req.url === '/api/pull') {
    writeFileSync(join(process.env.OLLAMA_MODELS, 'downloaded.gguf'), 'synthetic weights');
    res.end('{}');
  } else res.end(JSON.stringify({ models: [{ name: 'mock:1b' }] }));
}).listen(Number(port), ip);
`, { mode: 0o755 });
  const storage = f.resolve();
  const options = { paths: f.paths, env: { ...f.env, KINGMAKER_OLLAMA_BIN: bin }, storage, port, timeoutMs: 5_000 };
  const first = await ensureCardOllama(options);
  const record = join(f.state, 'card-ollama-runtime.json');
  const { pid } = JSON.parse(readFileSync(record, 'utf8'));
  t.after(() => { try { process.kill(pid, 'SIGTERM'); } catch { /* already stopped */ } });
  assert.equal(first.modelsDir, storage.modelsDir);
  assert.deepEqual(first.models, ['mock:1b']);
  assert.deepEqual(await ensureCardOllama(options), first);
  assert.equal((await fetch(`${first.baseUrl}/api/pull`, { method: 'POST' })).ok, true);
  assert.equal(readFileSync(join(f.card, 'ollama-models', 'downloaded.gguf'), 'utf8'), 'synthetic weights');
  assert.equal(existsSync(f.env.KINGMAKER_OLLAMA_MODELS), false);
});

test('normal CLI model pull and startup report missing card without touching internal weights', { skip: !usesModelCard() }, (t) => {
  const f = fixture(t);
  const cli = new URL('../lib/kingmaker.mjs', import.meta.url).pathname;
  const env = { ...f.env, SOL_GHOST_HOME: f.state, KINGMAKER_ADDONS: 'off' };
  for (const args of [['models', 'pull', 'qwen3:1.7b'], ['models', 'setup'], ['start']]) {
    assert.throws(() => execFileSync(process.execPath, [cli, ...args], { env, stdio: 'pipe' }), (error) => {
      assert.match(String(error.stderr), /Kingmaker model card is missing.*Insert the card/);
      return true;
    });
  }
  assert.equal(existsSync(f.state), false);
  assert.equal(existsSync(f.env.KINGMAKER_OLLAMA_MODELS), false);
});
