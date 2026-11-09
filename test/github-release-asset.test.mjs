import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { downloadReleaseAsset, downloadReleaseBytes, fileMatches, openReleaseAsset } from '../lib/github-release-asset.mjs';
import { noCredentials } from '../lib/library-credentials.mjs';

const HTML = '<!DOCTYPE html><html><body>504 Gateway Timeout</body></html>';
const MODELFILE = 'FROM "./weights.gguf"\nPARAMETER temperature 0.2\n';
const API = 'https://api.github.com/repos/ronininc/kingmaker-brain-library/releases/assets/645365878';
const SIGNED = 'https://release-assets.githubusercontent.com/signed-modelfile';
const DIRECT = 'https://github.com/ronininc/kingmaker-brain-library/releases/download/model-granite/Modelfile';

function spec(over = {}) {
  return {
    owner: 'ronininc',
    repo: 'kingmaker-brain-library',
    assetId: 645365878,
    release: 'model-granite',
    name: 'Modelfile',
    credentialProvider: noCredentials,
    sleep: async () => {},
    now: () => 1_700_000_000_000,
    maxAttempts: 3,
    ...over,
  };
}

test('asset bytes come from the API redirect, with no credential by default', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url === API) {
      return new Response(null, { status: 302, headers: { location: SIGNED, 'x-ratelimit-remaining': '59', 'x-ratelimit-limit': '60' } });
    }
    assert.equal(init.headers.authorization, undefined);
    return new Response(MODELFILE, { status: 200, headers: { 'content-type': 'text/plain' } });
  };
  const got = await downloadReleaseBytes(spec({ fetchImpl }));
  assert.equal(got.via, 'api');
  assert.equal(got.bytes.toString('utf8'), MODELFILE);
  assert.equal(calls[0].url, API);
  assert.equal(calls[0].init.headers.accept, 'application/octet-stream');
  assert.equal(calls[0].init.headers.authorization, undefined);
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[1].url, SIGNED);
});

test('a 504 HTML body from the direct URL is not written; the API body is', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'asset-'));
  const dest = join(dir, 'Modelfile');
  let directHits = 0;
  const fetchImpl = async (url) => {
    if (url === API) return new Response(null, { status: 302, headers: { location: SIGNED } });
    if (url === SIGNED) return new Response(MODELFILE, { status: 200, headers: { 'content-type': 'text/plain' } });
    directHits += 1;
    return new Response(HTML, { status: 504, headers: { 'content-type': 'text/html' } });
  };
  const saved = await downloadReleaseAsset(spec({ fetchImpl }), dest);
  assert.equal(saved.via, 'api');
  assert.equal(directHits, 0);
  assert.equal(readFileSync(dest, 'utf8'), MODELFILE);
  assert.equal(readFileSync(dest, 'utf8').includes('<html>'), false);
});

test('API 504 HTML falls through to the direct URL and never leaves the HTML on disk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'asset-'));
  const dest = join(dir, 'Modelfile');
  const sleeps = [];
  const fetchImpl = async (url) => {
    if (String(url).includes('api.github.com')) return new Response(HTML, { status: 504, headers: { 'content-type': 'text/html' } });
    return new Response(MODELFILE, { status: 200, headers: { 'content-type': 'text/plain' } });
  };
  const saved = await downloadReleaseAsset(spec({ fetchImpl, sleep: async (ms) => sleeps.push(ms) }), dest);
  assert.equal(saved.via, 'direct');
  assert.equal(readFileSync(dest, 'utf8'), MODELFILE);
  assert.ok(sleeps.length >= 1);
});

test('a non-2xx body is never written, including when the fallback is also an error page', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'asset-'));
  const dest = join(dir, 'Modelfile');
  const fetchImpl = async () => new Response(HTML, { status: 504, headers: { 'content-type': 'text/html' } });
  await assert.rejects(() => downloadReleaseAsset(spec({ fetchImpl }), dest), /HTTP 504/);
  assert.equal(existsSync(dest), false);
  assert.equal(existsSync(`${dest}.${process.pid}.partial`), false);
});

test('HTTP 200 HTML is refused and not saved', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'asset-'));
  const dest = join(dir, 'Modelfile');
  const fetchImpl = async (url) => {
    if (String(url).includes('api.github.com')) return new Response(null, { status: 302, headers: { location: SIGNED } });
    return new Response(HTML, { status: 200, headers: { 'content-type': 'text/html' } });
  };
  await assert.rejects(() => downloadReleaseAsset(spec({ fetchImpl }), dest), /HTML/);
  assert.equal(existsSync(dest), false);
});

test('an injected credential reaches only api.github.com and never an error', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, authorization: init.headers?.authorization ?? null });
    if (String(url).includes('api.github.com')) return new Response(HTML, { status: 500, headers: { 'content-type': 'text/html' } });
    return new Response(HTML, { status: 500, headers: { 'content-type': 'text/html' } });
  };
  const credentialProvider = { async credential() { return { header: 'authorization', value: 'Bearer super-secret-token' }; } };
  await assert.rejects(() => openReleaseAsset(spec({ fetchImpl, credentialProvider, maxAttempts: 1 })), (error) => {
    assert.equal(String(error.message).includes('super-secret-token'), false);
    return true;
  });
  const api = calls.filter((call) => call.url.includes('api.github.com'));
  const other = calls.filter((call) => !call.url.includes('api.github.com'));
  assert.ok(api.every((call) => call.authorization === 'Bearer super-secret-token'));
  assert.ok(other.every((call) => call.authorization == null));
});

test('a rate-limit response backs off instead of hammering', async () => {
  const sleeps = [];
  let apiCalls = 0;
  const now = 1_700_000_000_000;
  const fetchImpl = async (url) => {
    if (String(url).includes('api.github.com')) {
      apiCalls += 1;
      if (apiCalls === 1) {
        return new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String((now / 1000) + 2) } });
      }
      return new Response(null, { status: 302, headers: { location: SIGNED, 'x-ratelimit-remaining': '58' } });
    }
    return new Response(MODELFILE, { status: 200, headers: { 'content-type': 'text/plain' } });
  };
  const got = await downloadReleaseBytes(spec({ fetchImpl, sleep: async (ms) => sleeps.push(ms), now: () => now }));
  assert.equal(got.bytes.toString('utf8'), MODELFILE);
  assert.ok(sleeps.some((ms) => ms >= 1000));
});

test('a part already on disk with the catalog checksum is not downloaded again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'asset-'));
  const dest = join(dir, 'part-000');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(dest, MODELFILE);
  const sha256 = createHash('sha256').update(MODELFILE).digest('hex');
  let called = false;
  const saved = await downloadReleaseAsset(spec({
    expectedSha256: sha256,
    expectedSize: Buffer.byteLength(MODELFILE),
    fetchImpl: async () => { called = true; return new Response(HTML, { status: 504 }); },
  }), dest);
  assert.equal(called, false);
  assert.equal(saved.skipped, true);
  assert.equal(await fileMatches(dest, sha256, Buffer.byteLength(MODELFILE)), true);
});
