// Range fetcher for public Brain Library release assets. This is what
// buildCatalogSources({ fetchModelRange }) calls. It does not replace
// lib/brain-library-access.mjs: training modules, methods, and the knowledge
// library stay on that module's stream and download modes.
//
// A stream read is one HTTP range (1 MiB portions, the access layer's bound).
// Ollama cannot run a portion. materializeLibraryModel writes the full GGUF,
// checks the catalog SHA-256, and only then can `ollama create` run. Ollama
// memory-maps that file.
//
// Bytes come from lib/github-release-asset.mjs: the asset API first, the
// browser download URL only after that fails. No credential is sent unless a
// caller injects one, and the default provider returns none.

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdirSync, readFileSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_PORTION_BYTES } from './brain-library-access.mjs';
import { LIBRARY_REPO } from './brain-library.mjs';
import { downloadReleaseAsset, downloadReleaseBytes, fileMatches, isHtmlPayload, isModelfile, releaseTagUrl } from './github-release-asset.mjs';
import { headersFor, noCredentials, redactError } from './library-credentials.mjs';

const OWNER = LIBRARY_REPO.split('/')[0];
const NAME = LIBRARY_REPO.split('/')[1];
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createReleaseCache() {
  return new Map();
}

/** A tether range reader sits in front of the public one. A null answer falls through. */
export function composeRangeFetchers(front, fallback) {
  return async (query) => {
    if (typeof front === 'function') {
      const got = await front(query);
      if (got) return got;
    }
    if (typeof fallback !== 'function') throw new Error('no fetchModelRange is wired');
    return fallback(query);
  };
}

/** Stub. The Launcher tether would answer here later. It returns nothing. */
export function tetherRangeFetcher() {
  return async () => null;
}

function clientOf(options = {}) {
  return {
    owner: options.owner ?? OWNER,
    repo: options.repo ?? NAME,
    credentialProvider: options.credentialProvider ?? noCredentials,
    fetchImpl: options.fetchImpl ?? fetch,
    sleep: options.sleep ?? defaultSleep,
    now: options.now,
    maxAttempts: options.maxAttempts,
    budget: options.budget,
    cache: options.cache ?? createReleaseCache(),
  };
}

function partSpans(weights) {
  let cursor = 0;
  return (weights?.parts ?? []).map((part) => {
    const start = cursor;
    cursor += part.size;
    return { ...part, start, end: cursor - 1 };
  });
}

export async function listReleaseAssets({
  owner = OWNER,
  repo = NAME,
  release,
  credentialProvider = noCredentials,
  fetchImpl = fetch,
  sleep = defaultSleep,
  maxAttempts = 3,
  cache = null,
} = {}) {
  const key = `${owner}/${repo}/${release}`;
  if (cache?.has(key)) return cache.get(key);
  const credential = await credentialProvider.credential?.() ?? null;
  const url = releaseTagUrl({ owner, repo, release });
  let lastStatus = 0;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const response = await fetchImpl(url, {
      headers: headersFor(url, { accept: 'application/vnd.github+json', 'user-agent': 'kingmaker' }, credential),
      redirect: 'follow',
    });
    lastStatus = response.status;
    if (response.status >= 200 && response.status < 300) {
      const text = await response.text();
      if (isHtmlPayload(text, response.headers?.get?.('content-type') || '')) {
        if (attempt < maxAttempts - 1) { await sleep(Math.min(8_000, 500 * 2 ** attempt)); continue; }
        throw redactError(new Error(`release ${release} returned HTML, not the asset list`));
      }
      const body = JSON.parse(text);
      const assets = (body.assets ?? []).map((asset) => ({
        id: asset.id, name: asset.name, size: asset.size, url: asset.url, browser_download_url: asset.browser_download_url,
      }));
      if (cache) cache.set(key, assets);
      return assets;
    }
    try { await response.body?.cancel?.(); } catch { /* dropped */ }
    if ((response.status === 403 || response.status === 429 || response.status >= 500) && attempt < maxAttempts - 1) {
      await sleep(Math.min(8_000, 500 * 2 ** attempt));
      continue;
    }
    break;
  }
  throw redactError(new Error(`release ${release} asset list answered HTTP ${lastStatus || 'none'}`));
}

async function resolveAsset(release, name, client) {
  const assets = await listReleaseAssets({ ...client, release });
  const asset = assets.find((item) => item.name === name);
  if (!asset?.id) throw new Error(`release ${release} has no asset ${name}`);
  return asset;
}

/**
 * One byte range of a published model, or the cached full GGUF in download mode.
 * `streamedToOllama` is always false: Ollama memory-maps the whole file.
 */
export async function fetchModelRange({ model, start = 0, end = null, mode = 'stream', ...options } = {}) {
  if (!model?.weights) throw new Error('fetchModelRange needs a library model that publishes weights');
  const client = clientOf(options);
  if (mode === 'download') {
    const file = await materializeLibraryModel(model, { ...options, cache: client.cache, create: false });
    return {
      mode: 'download', transport: 'cached-file', streamedToOllama: false, ollamaReady: true,
      gguf: file.gguf, sha256: model.weights.sha256, note: file.note,
    };
  }
  if (mode !== 'stream') throw new Error(`unknown fetch mode ${mode}`);
  const rangeEnd = end ?? (start + MAX_PORTION_BYTES - 1);
  const spans = partSpans(model.weights);
  const chunks = [];
  let via = null;
  let cursor = start;
  while (cursor <= rangeEnd) {
    const span = spans.find((part) => cursor >= part.start && cursor <= part.end);
    if (!span) break;
    const localStart = cursor - span.start;
    const localEnd = Math.min(rangeEnd - span.start, span.size - 1);
    const asset = await resolveAsset(model.weights.release, span.name, client);
    const got = await downloadReleaseBytes({
      ...client, assetId: asset.id, release: model.weights.release, name: span.name,
      range: { start: localStart, end: localEnd },
    }, { maxBytes: localEnd - localStart + 1 });
    if (!got.bytes.length) break;
    chunks.push(got.bytes);
    via = via ?? got.via;
    cursor += got.bytes.length;
  }
  if (!chunks.length) throw new Error(`byte ${start} is outside ${model.tag}`);
  const bytes = Buffer.concat(chunks);
  return {
    mode: 'stream', transport: 'http-range', via, bytes, start, end: start + bytes.length - 1,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    verification: 'UNVERIFIED', streamedToOllama: false, ollamaReady: false,
    note: 'One HTTP range of a release asset. Ollama cannot run this portion. The full GGUF has to be on disk first.',
  };
}

async function joinParts(paths, dest, expectedSha256) {
  const hash = createHash('sha256');
  const out = createWriteStream(dest);
  try {
    for (const path of paths) {
      for await (const chunk of createReadStream(path)) {
        hash.update(chunk);
        if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
      }
    }
    await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve())));
  } catch (error) {
    out.destroy();
    rmSync(dest, { force: true });
    throw error;
  }
  const sha256 = hash.digest('hex');
  if (sha256 !== expectedSha256) {
    rmSync(dest, { force: true });
    rmSync(`${dest}.sha256`, { force: true });
    throw new Error(`joined GGUF SHA-256 ${sha256.slice(0, 12)} did not match ${expectedSha256.slice(0, 12)}`);
  }
  writeFileSync(`${dest}.sha256`, `${sha256}\n`, { mode: 0o600 });
  return sha256;
}

/** Full GGUF plus a real Modelfile. Matching checksums on disk are not downloaded again.
 *  An HTML Modelfile (a saved 504 page) is deleted and fetched again, and never kept. */
export async function materializeLibraryModel(model, { dir, create = false, run = null, ...options } = {}) {
  const weights = model?.weights;
  if (!weights?.parts?.length || !weights.sha256 || !weights.gguf) throw new Error(`${model?.tag || 'model'} has no republished weights`);
  mkdirSync(dir, { recursive: true });
  const client = clientOf(options);
  const gguf = join(dir, weights.gguf);
  const whole = await fileMatches(gguf, weights.sha256, weights.size);
  if (!whole) {
    let free = null;
    try { const space = statfsSync(dir); free = space.bavail * space.bsize; } catch { free = null; }
    if (free != null && free < weights.size * 2) throw new Error(`not enough free disk (${(free / 1e9).toFixed(1)} GB free; assembling ${model.tag} needs about ${((weights.size * 2) / 1e9).toFixed(1)} GB)`);
    const partPaths = [];
    for (const part of weights.parts) {
      const partPath = join(dir, part.name);
      partPaths.push(partPath);
      if (await fileMatches(partPath, part.sha256, part.size)) continue;
      const asset = await resolveAsset(weights.release, part.name, client);
      await downloadReleaseAsset({
        ...client, assetId: asset.id, release: weights.release, name: part.name,
        expectedSha256: part.sha256, expectedSize: part.size,
      }, partPath);
    }
    await joinParts(partPaths, gguf, weights.sha256);
    for (const partPath of partPaths) rmSync(partPath, { force: true });
  }
  const modelfilePath = join(dir, 'Modelfile');
  let text = '';
  try { text = readFileSync(modelfilePath, 'utf8'); } catch { text = ''; }
  if (!isModelfile(text)) {
    rmSync(modelfilePath, { force: true });
    const assetName = weights.modelfile || 'Modelfile';
    const asset = await resolveAsset(weights.release, assetName, client);
    const got = await downloadReleaseBytes({
      ...client, assetId: asset.id, release: weights.release, name: assetName,
    }, { maxBytes: 1_000_000 });
    text = got.bytes.toString('utf8');
    if (!isModelfile(text)) throw new Error('the Modelfile asset was not a Modelfile; it was not saved');
  }
  writeFileSync(modelfilePath, text.replace(/^FROM .*$/m, `FROM ${JSON.stringify(gguf)}`), { mode: 0o600 });
  let created = false;
  if (create && typeof run === 'function') {
    const bin = options.ollamaBin || process.env.OLLAMA_BIN || 'ollama';
    const result = await run(bin, ['create', model.tag, '-f', modelfilePath]);
    if (result?.status !== 0 && result !== 0 && result?.ok !== true) throw new Error('Ollama could not create the library model');
    created = true;
  }
  return {
    tag: model.tag, gguf, modelfile: modelfilePath, sha256: weights.sha256, created,
    streamedToOllama: false, transport: 'cached-file',
    note: 'Ollama memory-maps the full GGUF. These bytes are a cached download checked against the catalog, not a live stream into the runner.',
  };
}

export async function cachedLibraryTags(root, models) {
  const tags = [];
  for (const model of models ?? []) {
    if (!model?.weights?.sha256 || !model.slug) continue;
    const gguf = join(root, 'models', 'library', model.slug, model.weights.gguf);
    if (await fileMatches(gguf, model.weights.sha256, model.weights.size ?? null)) tags.push(model.tag);
  }
  return tags;
}
