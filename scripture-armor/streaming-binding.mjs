// scripture-armor/streaming-binding.mjs — the small (streaming) build's binding
// to the Brain Library streaming layer.
//
// DESIGN CONSTRAINT (owner, 2026-11-05): this flavor is INVOCATION-AWARE ONLY.
// The streamed capability is inert until a function call invokes it; nothing
// in this module watches, polls, or stays resident between calls. There are
// no timers, watchers, or background loops here by design. Omni-awareness —
// continuous watching, including between jobs — is a property of the full,
// always-loaded build, and no part of the streaming flavor may claim it.
//
// BINDING RULE: this module binds ONLY to a portion-precise puller that ships
// inside this product's own tree (in a source checkout: ../lib/brain-puller.mjs;
// in a staged bundle: ./streaming/brain-puller.mjs). It never reaches into
// another build's tree at runtime. When no puller is present at either
// location the binding fails closed and names the wall instead of improvising
// a substitute puller.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const STREAMING_SCHEMA = 'scripture-armor.streaming/1';
export const AWARENESS = 'invocation-aware-only';
export const WALL_NO_PULLER = 'WALL-STREAMING-LAYER-ABSENT: no portion-precise Brain Library puller (lib/brain-puller.mjs: fetchRange/pullPortion/downloadPartResumable) is present in this installation; the binding binds only to a puller inside this product\'s own tree and never improvises a substitute.';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function pullerCandidates({ bundleRoot = HERE } = {}) {
  return [
    path.join(bundleRoot, 'streaming', 'brain-puller.mjs'),
    path.join(bundleRoot, '..', 'lib', 'brain-puller.mjs'),
  ];
}

/** Resolve the streaming binding. Inert: performs no network or file writes. */
export function resolveStreamingBinding(opts = {}) {
  const candidates = pullerCandidates(opts);
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    return { schema: STREAMING_SCHEMA, awareness: AWARENESS, available: false, wall: WALL_NO_PULLER, candidates };
  }
  return { schema: STREAMING_SCHEMA, awareness: AWARENESS, available: true, pullerPath: found, candidates };
}

// The portion store's manifest schema (churn-scan.mjs's STORE_SCHEMA — the
// churn scan is the store's manager; the binding is its writer at pull time).
export const PORTION_STORE_SCHEMA = 'scripture-armor.portion-store/1';

const portionIdOf = ({ slug, part, start, length }) => `${slug}__${part}__${start}__${length}`.replace(/[^A-Za-z0-9._-]+/g, '_');

/**
 * Persist pulled portions in the portion store: bytes under files/, one
 * manifest entry per portion in portions.json, each entry carrying the
 * library linkage (model slug, part name, range, and the catalog part hash
 * at pull time) the daily churn scan verifies and refreshes against.
 */
function persistPortions(storeDir, entries) {
  const filesDir = path.join(storeDir, 'files');
  fs.mkdirSync(filesDir, { recursive: true });
  const manifestPath = path.join(storeDir, 'portions.json');
  let manifest = { schema: PORTION_STORE_SCHEMA, portions: [] };
  if (fs.existsSync(manifestPath)) {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.schema !== PORTION_STORE_SCHEMA || !Array.isArray(manifest.portions)) throw new Error('invalid portion store manifest: ' + manifestPath);
  }
  const nowIso = new Date().toISOString();
  for (const { bytes, ...entry } of entries) {
    const file = `${entry.id}.bin`;
    fs.writeFileSync(path.join(filesDir, file), bytes);
    const record = { ...entry, file, pulledAt: nowIso, lastUsedAt: nowIso };
    const i = manifest.portions.findIndex((p) => p.id === entry.id);
    if (i >= 0) manifest.portions[i] = { ...manifest.portions[i], ...record, pulledAt: manifest.portions[i].pulledAt ?? nowIso };
    else manifest.portions.push(record);
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { storeDir, manifestPath, held: manifest.portions.length };
}

/**
 * The loaded-skill entry point: the ONLY way streamed capability is reached.
 * A caller names a function and the portions it needs; the binding resolves
 * the puller and pulls exactly those portions through it, which persist in
 * the portion store for the daily churn scan to manage. Any puller error
 * aborts the invocation before anything persists — the binding fails closed.
 * Between invocations this module does nothing and knows nothing.
 *
 * portions: [{ model: <slug|catalog model>, part: <index|name>, start,
 *              length | startFraction/lengthFraction, expectedSha256? }]
 * Returns { schema, awareness, pulled: [summaries], store } — the summaries
 * carry each portion's sha256 and the puller's verification grade; raw bytes
 * live in the store, not in the result.
 */
export async function invokeStreamed({ portions, storeDir, ...rest } = {}) {
  const binding = resolveStreamingBinding(rest);
  if (!binding.available) throw Object.assign(new Error(binding.wall), { code: 'STREAMING_LAYER_ABSENT' });
  const puller = await import(binding.pullerPath);
  if (typeof puller.pullPortion !== 'function' || typeof puller.resolveBrain !== 'function') {
    throw Object.assign(new Error('WALL-STREAMING-LAYER-ABSENT: resolved puller lacks pullPortion/resolveBrain exports'), { code: 'STREAMING_LAYER_ABSENT' });
  }
  const entries = [];
  for (const portion of portions ?? []) {
    const model = typeof portion.model === 'string' ? await puller.resolveBrain(portion.model, rest) : portion.model;
    const parts = model?.weights?.parts ?? [];
    const partEntry = typeof portion.part === 'number' ? parts[portion.part] : parts.find((p) => p.name === portion.part) ?? parts[portion.part ?? 0];
    if (!partEntry) throw new Error(`invokeStreamed: no part "${portion.part}" in ${model?.slug ?? 'model'}'s weights`);
    const pulled = await puller.pullPortion(model, portion, rest);
    entries.push({
      id: portionIdOf(pulled),
      slug: pulled.slug,
      part: pulled.part,
      start: pulled.start,
      length: pulled.length,
      sha256: pulled.sha256,
      size: pulled.bytes.length,
      bytesMoved: pulled.bytesMoved,
      verification: pulled.verification,
      partSha256: partEntry.sha256,
      release: model.weights.release,
      bytes: pulled.bytes,
    });
  }
  const store = storeDir ? persistPortions(storeDir, entries) : null;
  const pulled = entries.map(({ bytes, ...summary }) => summary);
  return { schema: STREAMING_SCHEMA, awareness: AWARENESS, pulled, store };
}
