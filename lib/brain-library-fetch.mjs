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
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { MAX_PORTION_BYTES } from './brain-library-access.mjs';
import { LIBRARY_REPO, toolPlatformKey } from './brain-library.mjs';
import { downloadReleaseAsset, downloadReleaseBytes, fileMatches, isHtmlPayload, isModelfile, releaseTagUrl } from './github-release-asset.mjs';
import { headersFor, noCredentials, redactError } from './library-credentials.mjs';
// Tool-section imports (tool streaming, appended section below): spawn drives the docker CLI;
// unpackBundle unpacks library-zip tool payloads.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { unpackBundle } from './extensions.mjs';

// Tool payloads are whole program trees, not extension bundles: Blender's archive
// is 626 MB and unpacks to ~1.5 GB, so unpackBundle's extensions-grade default
// ceiling (4 × 200 MB) refuses every real tool the lane exists to stream — the
// download verifies, then materialize dies at the unpack. The archive reaching
// the unpack below is sha256-pinned by the catalog and re-checked immediately
// before it, so this ceiling is a zip-bomb brake, not a trust decision: 8 GiB of
// unpacked tree — far past any admitted tool, far short of a disk-fill.
const MAX_TOOL_UNPACK_BYTES = 8 * 1024 * 1024 * 1024;

// LIBRARY_REPO is imported from brain-library.mjs, which sits in an import
// cycle with this module (brain-library -> model-bench -> fast-route ->
// direct-reasoning -> method-conductor -> tool-streaming -> this module).
// Reading it at module top level hits the temporal dead zone whenever the
// tree is entered through brain-library.mjs or brain-library-access.mjs, so
// resolve it at first use instead: by then every module in the cycle has
// finished initializing, and the value is the same constant either way.
const repoOwner = () => LIBRARY_REPO.split('/')[0];
const repoName = () => LIBRARY_REPO.split('/')[1];
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
    owner: options.owner ?? repoOwner(),
    repo: options.repo ?? repoName(),
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
  owner = repoOwner(),
  repo = repoName(),
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


// ============================================================================
// TOOL MATERIALIZE MACHINERY (kingmaker.tools/1 — tool streaming)
// ----------------------------------------------------------------------------
// Everything below this line is the tool lane's materialize layer, ported as a
// delimited section: materializeTool pulls a staged tool platform's parts
// through the access layer, re-verifies the assembled archive against the
// catalog SHA-256, unpacks library-zip payloads (or `docker load`s a
// docker-image-tar payload — hash verification always precedes any docker
// invocation), and records the result in the persistent tool registry
// (readToolRegistry / toolDescriptor are the registry's read shape).
// It shares only node:* bindings and toolPlatformKey with the model-range
// machinery above; no model export above is changed or shadowed.
// ============================================================================

export { toolPlatformKey };
export const TOOL_REGISTRY_FILE = 'tools-registry.json';
export const TOOL_RECEIPT_FILE = 'materialized.json';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** The persistent registry of materialized tools (one record per id+platform). */
export function readToolRegistry(toolsDir) {
  try {
    const parsed = JSON.parse(readFileSync(join(toolsDir, TOOL_REGISTRY_FILE), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

function writeToolRegistry(toolsDir, registry) {
  mkdirSync(toolsDir, { recursive: true });
  writeFileSync(join(toolsDir, TOOL_REGISTRY_FILE), `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
}

/**
 * The lib/mcp.mjs-shaped descriptor for a materialized tool — the shape the tool-calling
 * layer surfaces (name, description, inputSchema). The frozen TOOLS list in lib/mcp.mjs
 * is NOT edited; descriptors for streamed tools are produced here, from the registry,
 * so a pulled tool becomes callable surface without a code change.
 */
export function toolDescriptor(tool, record = null) {
  if (record?.image) {
    // A docker-image tool: no binPath exists to point at — the callable surface is
    // the image itself, run through docker. The descriptor says exactly that.
    return {
      name: tool.id,
      description: `${tool.name} ${tool.version} — a Brain Library tool shipped as a Docker image (${record.image}), streamed and loaded locally. Runs the image with the given arguments (docker run ${record.image} <args>).`,
      inputSchema: {
        type: 'object',
        properties: {
          args: { type: 'array', items: { type: 'string' }, description: 'arguments passed to the image entrypoint, in order' },
          cwd: { type: 'string', description: 'working directory for the run (defaults to the conduction workDir)' },
        },
        required: [],
      },
      tool: { id: tool.id, version: tool.version, license: tool.license, provides: [...tool.provides] },
      image: record.image, execution: record.execution, platform: record.platform,
    };
  }
  return {
    name: tool.id,
    description: `${tool.name} ${tool.version} — a Brain Library tool, streamed and materialized locally${record?.binPath ? ` (binary: ${record.binPath})` : ''}. Runs the tool's own binary with the given arguments.`,
    inputSchema: {
      type: 'object',
      properties: {
        args: { type: 'array', items: { type: 'string' }, description: 'arguments passed to the binary, in order' },
        cwd: { type: 'string', description: 'working directory for the run (defaults to the conduction workDir)' },
      },
      required: [],
    },
    tool: { id: tool.id, version: tool.version, license: tool.license, provides: [...tool.provides] },
    ...(record ? { binPath: record.binPath, dir: record.dir, platform: record.platform } : {}),
  };
}

/** Pure: where each provided command lives inside a materialized tree. */
export function binPathsFor(tool, platformPayload, dir) {
  const binAbs = join(dir, platformPayload.bin);
  const out = {};
  for (const command of tool.provides) {
    if (platformPayload.bin === command || basename(platformPayload.bin) === command) out[command] = binAbs;
    else if (existsSync(join(dir, 'bin', command))) out[command] = join(dir, 'bin', command);
    else if (existsSync(join(dir, command))) out[command] = join(dir, command);
    else out[command] = binAbs; // the declared bin IS the tool's entry (e.g. Blender.app's binary serves 'blender')
  }
  return out;
}

/**
 * Run the docker CLI once, capturing bounded output. `inputPath`, when given,
 * streams into the child's stdin (docker load reads the archive from stdin — the
 * joined archive is never copied). Resolves { code, stdout, stderr }; a spawn
 * failure (docker absent → ENOENT) rejects with the original error, which the
 * image lane turns into its named prerequisite refusal.
 */
function runDocker(dockerBin, args, { inputPath = null } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(dockerBin, args, { stdio: [inputPath ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout = (stdout + d).slice(-8192); });
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-8192); });
    child.on('error', rejectPromise);
    child.on('close', (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
    if (inputPath) {
      const input = createReadStream(inputPath);
      input.on('error', () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } });
      input.pipe(child.stdin);
    }
  });
}

const dockerMissingError = (dockerBin, toolId) => new Error(`brain-library-fetch: ${toolId} is a docker-image tool, but the docker CLI ("${dockerBin}") was not found on PATH — Docker is the missing prerequisite for the docker-image-tar format; refusing (fail closed)`);

/** True when the image is already local. A dead daemon is a named refusal, never an "absent". */
async function dockerImagePresent(dockerBin, image, toolId) {
  let r;
  try { r = await runDocker(dockerBin, ['image', 'inspect', image]); }
  catch (e) { if (e?.code === 'ENOENT') throw dockerMissingError(dockerBin, toolId); throw e; }
  if (r.code === 0) return true;
  if (/cannot connect to the docker daemon|is the docker daemon running/i.test(r.stderr)) {
    throw new Error(`brain-library-fetch: ${toolId} is a docker-image tool, but the Docker daemon is not answering (docker image inspect: ${r.stderr.trim().slice(0, 160)}) — start Docker and pull again (fail closed)`);
  }
  return false;
}

/**
 * The docker-image-tar lane of materializeTool (see the module header for the
 * ordering contract). No addConnector spec is offered for an image tool: an image
 * is not an MCP stdio server, and inventing a connector for it would be a lie —
 * `connector` in the result is null, and the registry record's `execution` shape
 * is the honest callable surface. Note the `adopted` flag's meaning: an adopted
 * image's bytes were never hash-verified against the catalog archive (a local
 * image cannot be re-hashed to its save archive) — presence is the ground truth,
 * and the flag keeps that distinction on the record.
 */
async function materializeDockerImageTool(access, tool, { platform, toolsDir, payload, dockerBin, log }) {
  const image = payload.bin;
  const sourceId = `tool:${tool.id}@${platform}`;
  const dir = join(toolsDir, tool.id, tool.version, platform);
  const receiptLoc = join(dir, TOOL_RECEIPT_FILE);

  let receipt = null;
  try { receipt = JSON.parse(readFileSync(receiptLoc, 'utf8')); } catch { /* not materialized yet */ }

  let adopted = false;
  if (await dockerImagePresent(dockerBin, image, tool.id)) {
    if (receipt?.archiveSha256 === payload.sha256 && receipt?.image === image) {
      adopted = receipt.adopted === true; // reuse carries the record's provenance — an adopted image stays adopted, never laundered into pulled-and-verified
      log('tool_reused', { id: tool.id, platform, image });
    } else {
      adopted = true; // apply-don't-redownload: the node already carries this image
      log('tool_adopted', { id: tool.id, platform, image });
    }
  } else {
    // Pull through the SAME access-layer download as the zip lane — the assembled
    // archive is accepted only against the catalog hash there, and re-verified
    // here — and only AFTER that does any byte reach docker.
    const pullReceipt = await access.download(sourceId);
    const archive = await readFile(pullReceipt.path);
    if (sha256(archive) !== payload.sha256) throw new Error(`brain-library-fetch: pulled archive for ${sourceId} does not match the catalog hash — refused, docker load never ran`);
    let load;
    try { load = await runDocker(dockerBin, ['load'], { inputPath: pullReceipt.path }); }
    catch (e) { if (e?.code === 'ENOENT') throw dockerMissingError(dockerBin, tool.id); throw e; }
    if (load.code !== 0) throw new Error(`brain-library-fetch: docker load of ${sourceId} failed (exit ${load.code}): ${load.stderr.trim().slice(0, 200)} — refused`);
    if (!(await dockerImagePresent(dockerBin, image, tool.id))) {
      throw new Error(`brain-library-fetch: docker load of ${sourceId} completed but image "${image}" is not present locally afterward — refused`);
    }
    log('tool_materialized', { id: tool.id, platform, image, bytes: pullReceipt.bytes });
  }

  receipt = {
    id: tool.id, version: tool.version, platform, sourceId, format: 'docker-image-tar', image,
    archiveSha256: payload.sha256, archiveBytes: payload.size, adopted,
    materializedAt: new Date().toISOString(),
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(receiptLoc, `${JSON.stringify(receipt, null, 2)}\n`);
  const registryRecord = {
    id: tool.id, name: tool.name, version: tool.version, license: tool.license, platform,
    format: 'docker-image-tar', image,
    provides: [...tool.provides], dir, binPath: null, binPaths: {},
    execution: { type: 'docker-run', command: 'docker', args: ['run', '--rm', image], image },
    archiveSha256: payload.sha256, sourceId, adopted, registeredAt: new Date().toISOString(),
  };
  const registry = readToolRegistry(toolsDir);
  registry[`${tool.id}@${platform}`] = registryRecord;
  writeToolRegistry(toolsDir, registry);
  return { tool, platform, sourceId, dir, image, binPath: null, binPaths: {}, receipt, registryRecord, descriptor: toolDescriptor(tool, registryRecord), connector: null };
}

/**
 * Pull + materialize one catalog tool for one platform. `access` is a
 * createBrainLibraryAccess over sources that include `tool:<id>@<platform>`
 * (buildCatalogSources with a toolPayloadDir). Throws — fail closed — when the
 * platform is missing, declared-not-staged, not served by the access layer, or
 * the pulled archive fails the catalog hash (the access layer refuses that
 * itself before this module ever sees bytes).
 * → { tool, platform, sourceId, dir, binPath, binPaths, receipt, registryRecord, descriptor, connector }
 */
export async function materializeTool(access, tool, { platform = toolPlatformKey(), toolsDir, addConnector = null, dockerBin = process.env.DOCKER_BIN ?? 'docker', log = () => {} } = {}) {
  if (!toolsDir) throw new Error('brain-library-fetch: materializeTool needs a toolsDir');
  const payload = tool.platforms?.[platform];
  if (!payload) throw new Error(`brain-library-fetch: ${tool.id} has no build for ${platform} (catalog declares: ${Object.keys(tool.platforms ?? {}).join(', ') || 'none'})`);
  if (payload.payloadStatus !== 'staged') {
    throw new Error(`brain-library-fetch: ${tool.id} ${tool.version} for ${platform} is declared-not-staged — the part layout is declared in the catalog but the payload packaging step has not staged real parts/hashes; refusing to pull (fail closed)`);
  }
  const sourceId = `tool:${tool.id}@${platform}`;
  const dir = join(toolsDir, tool.id, tool.version, platform);
  const receiptLoc = join(dir, TOOL_RECEIPT_FILE);

  // The second format lane: a docker-image tool materializes by loading an image,
  // never by unpacking a tree (materializeDockerImageTool, above).
  if (payload.format === 'docker-image-tar') {
    return materializeDockerImageTool(access, tool, { platform, toolsDir, payload, dockerBin, log });
  }

  // Idempotent reuse: the same archive already materialized here is not re-pulled.
  let existing = null;
  try { existing = JSON.parse(readFileSync(receiptLoc, 'utf8')); } catch { /* not materialized yet */ }
  let pullReceipt = null;
  if (!existing || existing.archiveSha256 !== payload.sha256 || !existsSync(join(dir, payload.bin))) {
    pullReceipt = await access.download(sourceId); // segment pull + catalog-hash acceptance (throws on mismatch / unknown source)
    const archive = await readFile(pullReceipt.path);
    if (sha256(archive) !== payload.sha256) throw new Error(`brain-library-fetch: pulled archive for ${sourceId} does not match the catalog hash — refused`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const entries = unpackBundle(archive, dir, { maxTotal: MAX_TOOL_UNPACK_BYTES }); // extensions-grade safety: no zip-slip, no links; the total uses the tool ceiling above, not the extension-bundle default
    const binAbs = join(dir, payload.bin);
    if (!existsSync(binAbs)) throw new Error(`brain-library-fetch: ${tool.id}'s archive does not contain its declared bin "${payload.bin}" — refused`);
    chmodSync(binAbs, 0o755);
    existing = {
      id: tool.id, version: tool.version, platform, sourceId,
      archiveSha256: payload.sha256, archiveBytes: pullReceipt.bytes, entries,
      materializedAt: new Date().toISOString(),
    };
    writeFileSync(receiptLoc, `${JSON.stringify(existing, null, 2)}\n`);
    log('tool_materialized', { id: tool.id, platform, entries, bytes: pullReceipt.bytes });
  } else {
    log('tool_reused', { id: tool.id, platform });
  }

  const binPaths = binPathsFor(tool, payload, dir);
  for (const p of Object.values(binPaths)) { try { chmodSync(p, 0o755); } catch { /* the declared bin above is the hard requirement */ } }
  const registryRecord = {
    id: tool.id, name: tool.name, version: tool.version, license: tool.license, platform,
    provides: [...tool.provides], dir, binPath: binPaths[tool.provides[0]] ?? join(dir, payload.bin), binPaths,
    archiveSha256: payload.sha256, sourceId, registeredAt: new Date().toISOString(),
  };
  const registry = readToolRegistry(toolsDir);
  registry[`${tool.id}@${platform}`] = registryRecord;
  writeToolRegistry(toolsDir, registry);

  // The REA/MCP-hub registration, when the caller wires it (lib/cli.mjs injects the same
  // dep for extensions). A registration failure is recorded, never fatal: the tool IS
  // materialized and in the registry either way, and the conductor's path needs only the
  // binary. The descriptor is returned regardless — it is the tool-calling layer's shape.
  let connector = null;
  if (addConnector) {
    try {
      const r = await addConnector({ kind: 'mcp', name: tool.id, command: registryRecord.binPath, args: [], env: {}, path: dir, extension: tool.id });
      connector = { ok: Boolean(r?.ok), ...(r?.error ? { error: String(r.error).slice(0, 200) } : {}) };
    } catch (e) { connector = { ok: false, error: String(e?.message ?? e).slice(0, 200) }; }
    registryRecord.connector = connector;
    writeToolRegistry(toolsDir, registry);
  }

  return { tool, platform, sourceId, dir, binPath: registryRecord.binPath, binPaths, receipt: existing, registryRecord, descriptor: toolDescriptor(tool, registryRecord), connector };
}
