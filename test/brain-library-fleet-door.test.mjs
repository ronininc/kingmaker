// Fleet closeout, item 1 — lib/brain-library-fleet-door.mjs.
// The door range fetcher must answer the access layer's exact
// fetchModelRange contract from the release assets' download URLs:
// ranges honored (206), ranges spanning part boundaries joined, a
// range-ignoring 200 sliced, HTML refused, HTTP failure named — and the
// prefetch window must never change a single byte.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDoorRangeFetcher, loadDoorModels, smallestWeightsModel } from '../lib/brain-library-fleet-door.mjs';

const PART0 = Buffer.alloc(1000, 0).map((_, i) => i % 251);
const PART1 = Buffer.alloc(500, 0).map((_, i) => (i * 7) % 253);
const WHOLE = Buffer.concat([PART0, PART1]);
const MODEL = {
  tag: 'test:model', slug: 'test-model',
  weights: {
    release: 'model-test-model', gguf: 'test.gguf', size: WHOLE.length, sha256: 'x'.repeat(64),
    parts: [{ name: 'test.gguf.part-000', size: PART0.length }, { name: 'test.gguf.part-001', size: PART1.length }],
  },
};
const partBytes = (name) => (name.endsWith('part-000') ? PART0 : PART1);

// A fetchImpl that behaves like the door's CDN: 206 + Content-Range for
// ranged requests against the part carried in the URL.
const cdnFetch = async (url, opts = {}) => {
  const name = decodeURIComponent(url.split('/').pop());
  const part = partBytes(name);
  const range = /^bytes=(\d+)-(\d+)$/.exec(opts.headers?.range ?? '');
  if (range) {
    const start = Number(range[1]); const end = Math.min(Number(range[2]), part.length - 1);
    return new Response(part.subarray(start, end + 1), { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${part.length}` } });
  }
  return new Response(part, { status: 200 });
};

test('a range inside one part is answered byte-exact', async () => {
  const fetchRange = createDoorRangeFetcher({ fetchImpl: cdnFetch });
  const got = await fetchRange({ model: MODEL, start: 10, end: 109, mode: 'stream' });
  assert.deepEqual(got.bytes, WHOLE.subarray(10, 110));
  assert.equal(got.via, 'browser-download-url');
});

test('a range spanning the part boundary is joined in order', async () => {
  const fetchRange = createDoorRangeFetcher({ fetchImpl: cdnFetch });
  const got = await fetchRange({ model: MODEL, start: 990, end: 1010, mode: 'stream' });
  assert.deepEqual(got.bytes, WHOLE.subarray(990, 1011));
});

test('the tail range ends at the model size, not the part size', async () => {
  const fetchRange = createDoorRangeFetcher({ fetchImpl: cdnFetch });
  const got = await fetchRange({ model: MODEL, start: 1490, end: 1499, mode: 'stream' });
  assert.deepEqual(got.bytes, WHOLE.subarray(1490, 1500));
});

test('a range-ignoring 200 is sliced to the ask', async () => {
  const noRangeFetch = async (url) => new Response(partBytes(decodeURIComponent(url.split('/').pop())), { status: 200 });
  const fetchRange = createDoorRangeFetcher({ fetchImpl: noRangeFetch });
  const got = await fetchRange({ model: MODEL, start: 5, end: 24, mode: 'stream' });
  assert.deepEqual(got.bytes, WHOLE.subarray(5, 25));
});

test('an HTML answer is refused, never returned as bytes', async () => {
  const htmlFetch = async () => new Response('<html><body>504</body></html>', { status: 206, headers: { 'content-type': 'text/html' } });
  const fetchRange = createDoorRangeFetcher({ fetchImpl: htmlFetch });
  await assert.rejects(() => fetchRange({ model: MODEL, start: 0, end: 9, mode: 'stream' }), (e) => e.code === 'FLEET_DOOR_HTML');
});

test('a dead door names its failure with the HTTP status', async () => {
  const deadFetch = async () => new Response('nope', { status: 404 });
  const fetchRange = createDoorRangeFetcher({ fetchImpl: deadFetch, maxAttempts: 1 });
  await assert.rejects(() => fetchRange({ model: MODEL, start: 0, end: 9, mode: 'stream' }), (e) => e.code === 'FLEET_DOOR_RANGE_FAILED' && e.status === 404);
});

test('prefetch changes no byte and serves sequential reads identically', async () => {
  const plain = createDoorRangeFetcher({ fetchImpl: cdnFetch });
  const warm = createDoorRangeFetcher({ fetchImpl: cdnFetch, prefetchRanges: 4 });
  for (let start = 0; start < 1000; start += 100) {
    const a = await plain({ model: MODEL, start, end: start + 99, mode: 'stream' });
    const b = await warm({ model: MODEL, start, end: start + 99, mode: 'stream' });
    assert.deepEqual(b.bytes, a.bytes);
    assert.deepEqual(b.bytes, WHOLE.subarray(start, start + 100));
  }
});

test('loadDoorModels separates weights-bearing models and names the rest', async () => {
  const library = { updatedAt: '2026-01-01T00:00:00Z', models: [MODEL, { tag: 'pointer:only', slug: 'pointer-only', weights: null }] };
  const fetchImpl = async () => new Response(JSON.stringify(library), { status: 200 });
  const door = await loadDoorModels({ libraryUrl: 'https://example.invalid/library.json', fetchImpl });
  assert.deepEqual(door.models.map((m) => m.tag), ['test:model']);
  assert.deepEqual(door.withoutWeights, ['pointer:only']);
  assert.equal(smallestWeightsModel(door.models).tag, 'test:model');
});
