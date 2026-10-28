import { test } from 'node:test';
import assert from 'node:assert/strict';
import { libraryToken, libraryFetchFile, libraryReleaseAssets, LIBRARY_API } from '../lib/brain-library.mjs';

const none = () => '';
test('token order: KINGMAKER_LIBRARY_TOKEN first, then GITHUB_TOKEN, then gh', () => {
  assert.equal(libraryToken({ env: { KINGMAKER_LIBRARY_TOKEN: 'a', GITHUB_TOKEN: 'b' }, run: none }), 'a');
  assert.equal(libraryToken({ env: { GITHUB_TOKEN: 'b' }, run: none }), 'b');
  assert.equal(libraryToken({ env: {}, run: (c) => (c === 'gh' ? 'g' : '') }), 'g');
  assert.equal(libraryToken({ env: {}, run: none }), null);
});
test('no token: clear message, no network call', async () => {
  let called = false;
  await assert.rejects(libraryFetchFile('library.json', { env: {}, run: none, fetchImpl: () => { called = true; } }), /private.*KINGMAKER_LIBRARY_TOKEN/s);
  assert.equal(called, false);
});
test('authenticated contents API with raw accept', async () => {
  let seen;
  const r = await libraryFetchFile('library.json', { token: 't', fetchImpl: async (url, o) => { seen = { url, o }; return new Response('{"ok":1}'); } });
  assert.equal(seen.url, `${LIBRARY_API}/contents/library.json?ref=main`);
  assert.equal(seen.o.headers.authorization, 'Bearer t');
  assert.equal(seen.o.headers.accept, 'application/vnd.github.raw');
  assert.deepEqual(await r.json(), { ok: 1 });
});
test('404 explains the token cannot read the private repo', async () => {
  await assert.rejects(libraryFetchFile('library.json', { token: 't', fetchImpl: async () => new Response('', { status: 404 }) }), /cannot read ronininc\/kingmaker-brain-library/);
});
test('release assets resolve to the asset API with octet-stream', async () => {
  const a = await libraryReleaseAssets('model-x', { token: 't', fetchImpl: async () => Response.json({ assets: [{ name: 'p1', url: 'https://api.github.com/a/1' }] }) });
  assert.equal(a.p1.url, 'https://api.github.com/a/1');
  assert.equal(a.p1.headers.accept, 'application/octet-stream');
});
