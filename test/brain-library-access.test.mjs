import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { bufferSource, buildCatalogSources, createBrainLibraryAccess, KNOWLEDGE_ID, MAX_PORTION_BYTES, planSegments } from '../lib/brain-library-access.mjs';
import { composeRangeFetchers, fetchModelRange, tetherRangeFetcher } from '../lib/brain-library-fetch.mjs';
import { MODE_DOWNLOAD, MODE_STREAM } from '../lib/datasets.mjs';

test('shipped access keeps the 1 MiB portion bound and the segment plan', () => {
  assert.equal(MAX_PORTION_BYTES, 1_048_576);
  assert.deepEqual(planSegments(10, 4), [{ start: 0, length: 4 }, { start: 4, length: 4 }, { start: 8, length: 2 }]);
});

test('download keeps a verified resident and stream keeps one rolling portion', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'access-'));
  const data = Buffer.from('abcdefghij');
  const source = bufferSource({ id: 'note', kind: 'method', name: 'Note', data });
  const access = createBrainLibraryAccess({
    sources: new Map([[source.id, source]]),
    storeDir: join(dir, 'store'),
    cacheDir: join(dir, 'cache'),
    stateDir: join(dir, 'state'),
  });
  assert.equal(access.getMode('note'), MODE_STREAM);
  const first = await access.readPortion('note', { start: 0, length: 4 });
  assert.equal(first.from, 'stream');
  assert.equal(first.data.toString(), 'abcd');
  await access.readPortion('note', { start: 4, length: 2 });
  const rolling = await access.diskState();
  assert.equal(rolling.cacheBytes, 2);
  assert.equal(rolling.storeBytes, 0);
  const saved = await access.download('note');
  assert.equal(saved.mode, MODE_DOWNLOAD);
  assert.equal(saved.sha256, source.sha256);
  const local = await access.readPortion('note', { start: 0, length: 4 });
  assert.equal(local.from, 'local');
  assert.equal(local.data.toString(), 'abcd');
  await assert.rejects(() => access.readPortion('note', { start: 0, length: MAX_PORTION_BYTES + 1 }), /portion bound/);
});

test('a hash mismatch never becomes a resident', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'access-bad-'));
  const source = bufferSource({ id: 'bad', kind: 'method', name: 'Bad', data: Buffer.from('nope'), sha256: '0'.repeat(64) });
  const access = createBrainLibraryAccess({
    sources: new Map([[source.id, source]]),
    storeDir: join(dir, 'store'),
    cacheDir: join(dir, 'cache'),
    stateDir: join(dir, 'state'),
  });
  await assert.rejects(() => access.download('bad'), /hash mismatch/);
  const disk = await access.diskState();
  assert.equal(disk.storeBytes, 0);
});

test('catalog sources stay training and knowledge until a range fetcher is injected', async () => {
  const sources = await buildCatalogSources();
  assert.ok(sources.has(KNOWLEDGE_ID));
  assert.ok([...sources.keys()].some((id) => id.startsWith('training:')));
  assert.ok([...sources.keys()].some((id) => id.startsWith('method:')));
  assert.equal([...sources.keys()].some((id) => id.startsWith('model:')), false);
});

test('fetchModelRange is the model source, and a tether in front can answer first', async () => {
  const model = {
    tag: 'example/writer:q4',
    slug: 'example-writer-q4',
    weights: { release: 'model-example', gguf: 'writer.gguf', sha256: 'ab'.repeat(32), size: 8, parts: [{ name: 'writer.gguf.part-000', size: 8, sha256: 'cd'.repeat(32) }] },
  };
  let ranged = 0;
  const fetchImpl = async (url) => {
    ranged += 1;
    if (String(url).includes('/releases/tags/')) {
      return Response.json({ assets: [{ id: 11, name: 'writer.gguf.part-000', size: 8, url: 'https://api.github.com/repos/ronininc/kingmaker-brain-library/releases/assets/11' }] });
    }
    if (String(url).endsWith('/assets/11')) return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/part' } });
    return new Response(Buffer.from('abcd'), { status: 206, headers: { 'content-type': 'application/octet-stream', 'content-range': 'bytes 0-3/8' } });
  };
  const tether = tetherRangeFetcher();
  const github = (query) => fetchModelRange({ ...query, fetchImpl, cache: new Map() });
  const sources = await buildCatalogSources({
    fetchModelRange: composeRangeFetchers(async () => ({ bytes: Buffer.from('tether') }), github),
    models: [model],
  });
  const fromTether = await sources.get('model:example-writer-q4').readRange(0, 4);
  assert.equal(fromTether.toString(), 'teth');
  assert.equal(ranged, 0);
  const direct = await buildCatalogSources({ fetchModelRange: github, models: [model] });
  const bytes = await direct.get('model:example-writer-q4').readRange(0, 4);
  assert.equal(bytes.toString(), 'abcd');
  assert.equal(await tether(), null);
  const training = await buildCatalogSources();
  assert.equal(training.has('model:example-writer-q4'), false);
});
