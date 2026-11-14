// lib/model-sync.mjs — carry a model from one host to another and know it arrived intact.
//
// Two hosts are compared by what they report for each model (GET /api/tags: a digest per model).
// A model that is missing or different on the destination is copied the exact way when the source
// is THIS Mac: its files are read from this Mac's own Ollama store, each one is uploaded under its
// SHA-256 name (the destination checks the bytes against that name and refuses a mismatch), and
// the destination is asked to build the model from those exact files.
//
// When the source is another machine its files cannot be read from here, so the destination is
// asked to download the model by name instead. That is only "the same model" if the two listings
// then show the same digest, and the result says which of the two happened. Nothing is claimed
// that was not checked.

import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { LOCAL_HOST_NAME, unavailable } from './model-hosts.mjs';

/** Where this Mac's Ollama keeps models: OLLAMA_MODELS, else ~/.ollama/models. */
export const localModelsDir = (env = process.env, home = homedir()) => String(env.OLLAMA_MODELS || '').trim() || join(home, '.ollama', 'models');

/** A model name as Ollama files it: registry / namespace / name / tag. "qwen3:4b", "user/m:tag", "hf.co/u/r:Q4_K_M". */
export function parseModelName(name) {
  const text = String(name ?? '').trim();
  if (!text || /\s|\.\.|\\/.test(text)) throw new Error(`"${name}" is not a model name`);
  const colon = text.lastIndexOf(':');
  const hasTag = colon > text.lastIndexOf('/');
  const tag = hasTag ? text.slice(colon + 1) : 'latest';
  const parts = (hasTag ? text.slice(0, colon) : text).split('/').filter(Boolean);
  if (!parts.length || !tag || parts.length > 3) throw new Error(`"${name}" is not a model name`);
  let registry = 'registry.ollama.ai', namespace = 'library', model;
  if (parts.length === 1) [model] = parts;
  else if (parts.length === 2) [namespace, model] = parts;
  else [registry, namespace, model] = parts;
  for (const p of [registry, namespace, model, tag]) if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(p)) throw new Error(`"${name}" is not a model name`);
  return { registry, namespace, model, tag };
}

const sameModel = (a, b) => a === b || `${a}:latest` === b || a === `${b}:latest`;
const digestOf = (tags, name) => { const hit = (tags ?? []).find((m) => sameModel(m.name ?? m.model, name)); return hit ? String(hit.digest ?? '') || null : undefined; };

/**
 * What a sync would do, from the two listings alone. Pure.
 * state: 'same' (both list the same digest) | 'missing' (not on the destination) | 'different' (both have it,
 * digests differ) | 'not-on-source'
 */
export function planSync({ fromTags, toTags, models = null }) {
  const names = models?.length ? models : (fromTags ?? []).map((m) => m.name ?? m.model).filter(Boolean);
  return names.map((model) => {
    const fromDigest = digestOf(fromTags, model), toDigest = digestOf(toTags, model);
    const state = fromDigest === undefined ? 'not-on-source' : toDigest === undefined ? 'missing' : fromDigest && fromDigest === toDigest ? 'same' : 'different';
    return { model, state, fromDigest: fromDigest ?? null, toDigest: toDigest ?? null };
  });
}

const WEIGHT_TYPES = Object.freeze({
  'application/vnd.ollama.image.model': 'weights',
  'application/vnd.ollama.image.projector': 'projector',
  'application/vnd.ollama.image.adapter': 'adapter',
});
const MESSAGES_TYPE = 'application/vnd.ollama.image.messages';
const TEXT_TYPES = Object.freeze({
  'application/vnd.ollama.image.template': 'template',
  'application/vnd.ollama.image.system': 'system',
  'application/vnd.ollama.image.license': 'license',
  'application/vnd.ollama.image.params': 'params',
});

/**
 * Read one model's manifest from this Mac's store: which files it is made of and where each one is.
 * → { files: [{ role, digest, bytes, path }], text: { template, system, license[], params }, complete }
 * `complete` is false when a file the manifest names is not on disk at its recorded size.
 */
export function readLocalModel(name, { modelsDir = localModelsDir() } = {}) {
  const n = parseModelName(name);
  const manifestPath = join(modelsDir, 'manifests', n.registry, n.namespace, n.model, n.tag);
  if (!existsSync(manifestPath)) return null;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const blobPath = (digest) => join(modelsDir, 'blobs', String(digest).replace(':', '-'));
  const files = [], text = { template: null, system: null, license: [], params: null, messages: null };
  const unsupported = []; // parts of the model this code does not know how to carry across
  let complete = true;
  for (const layer of manifest.layers ?? []) {
    const digest = String(layer.digest ?? '');
    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error(`the manifest for ${name} lists a file with no usable digest`);
    const path = blobPath(digest);
    const onDisk = existsSync(path) ? statSync(path).size : null;
    if (WEIGHT_TYPES[layer.mediaType]) {
      if (onDisk == null || (Number.isFinite(layer.size) && onDisk !== layer.size)) complete = false;
      files.push({ role: WEIGHT_TYPES[layer.mediaType], digest, bytes: Number.isFinite(layer.size) ? layer.size : onDisk, path });
    } else if (TEXT_TYPES[layer.mediaType]) {
      if (onDisk == null) { complete = false; continue; }
      const body = readFileSync(path, 'utf8');
      const role = TEXT_TYPES[layer.mediaType];
      if (role === 'license') text.license.push(body);
      else if (role === 'params') { try { text.params = JSON.parse(body); } catch { unsupported.push('parameters that could not be read'); } }
      else text[role] = body;
    } else if (layer.mediaType === MESSAGES_TYPE) {
      // Stored example turns are part of how the model answers. They go across in the create request, or not at all.
      if (onDisk == null) { complete = false; continue; }
      let turns = null;
      try { turns = JSON.parse(readFileSync(path, 'utf8')); } catch { /* handled below */ }
      if (Array.isArray(turns) && turns.every((t) => t && typeof t.role === 'string' && typeof t.content === 'string')) text.messages = [...(text.messages ?? []), ...turns.map((t) => ({ role: t.role, content: t.content }))];
      else unsupported.push('stored messages that could not be read');
    } else {
      unsupported.push(String(layer.mediaType || 'a part with no type'));
    }
  }
  return { name, manifestPath, files, text, complete, unsupported };
}

/**
 * The request that rebuilds a model on the destination from files it already holds by digest.
 * Weights and projector go in `files` under plain names; an adapter cannot be expressed this way
 * with the documented fields, so a model that has one is reported and not rebuilt as something else.
 */
export function createRequest(local) {
  if (local.files.some((f) => f.role === 'adapter')) {
    return unavailable('this model carries an adapter file; the exact copy needs a rebuild that the documented create request cannot express', 'download it by name on the destination, or copy it with Ollama\'s own tools');
  }
  // A part of the model this code does not recognise would be left behind without a word, and the copy would
  // still "verify" because every file it did send arrived. Such a model is not rebuilt.
  if (local.unsupported?.length) {
    return unavailable(`this model has a part an exact rebuild would leave out (${[...new Set(local.unsupported)].join(', ')})`, 'download it by name on the destination, or copy it with Ollama\'s own tools');
  }
  const weights = local.files.filter((f) => f.role === 'weights');
  if (!weights.length) return unavailable('this model\'s manifest names no weight file');
  const files = {};
  weights.forEach((f, i) => { files[weights.length === 1 ? 'model.gguf' : `model-${String(i + 1).padStart(5, '0')}-of-${String(weights.length).padStart(5, '0')}.gguf`] = f.digest; });
  local.files.filter((f) => f.role === 'projector').forEach((f, i) => { files[i ? `projector-${i + 1}.gguf` : 'projector.gguf'] = f.digest; });
  const body = { model: local.name, files };
  if (local.text.template) body.template = local.text.template;
  if (local.text.system) body.system = local.text.system;
  if (local.text.license.length) body.license = local.text.license.length === 1 ? local.text.license[0] : local.text.license;
  if (local.text.params && typeof local.text.params === 'object' && Object.keys(local.text.params).length) body.parameters = local.text.params;
  if (local.text.messages?.length) body.messages = local.text.messages;
  return body;
}

/**
 * Copy one model to `to`. `from` is a host client too; `local` says whether it is this Mac's own Ollama
 * (the host named "this-mac"). A tunnel to another machine also has a loopback address, so the address alone
 * is not the test: only this Mac's own store can be read from here.
 * → { model, how: 'exact-copy' | 'downloaded-by-name' | 'already-there', uploaded: [{digest,bytes}], skipped: [...],
 *     verified: { everyFileOnDestination, listed, sameListingDigest }, note }
 * Throws only for a real failure. A copy that could not be proven identical says so in `verified` and `note`.
 */
export async function syncModel({ model, from, to, local = from.host.name === LOCAL_HOST_NAME, modelsDir = localModelsDir(), force = false, log = () => {}, openFile = (path) => Readable.toWeb(createReadStream(path)) }) {
  const [fromTags, toTags] = await Promise.all([from.tags(), to.tags()]);
  const [row] = planSync({ fromTags, toTags, models: [model] });
  if (row.state === 'not-on-source') throw new Error(`${from.host.name} does not have ${model}`);
  if (row.state === 'same' && !force) {
    return { model, how: 'already-there', uploaded: [], skipped: [], verified: { everyFileOnDestination: unavailable('not checked: both hosts already list the same digest'), listed: true, sameListingDigest: true }, note: `${to.host.name} already lists the same digest.` };
  }

  const source = local ? readLocalModel(model, { modelsDir }) : null;
  const request = source && source.complete ? createRequest(source) : null;
  if (source && request && !request.unavailable) {
    const uploaded = [], skipped = [];
    for (const f of source.files) {
      if (await to.hasBlob(f.digest)) { skipped.push({ digest: f.digest, bytes: f.bytes }); log(`  already on ${to.host.name}: ${f.role} ${f.digest.slice(7, 19)}`); continue; }
      log(`  uploading ${f.role} ${f.digest.slice(7, 19)} (${(f.bytes / 2 ** 30).toFixed(2)} GB)`);
      await to.pushBlob(f.digest, openFile(f.path), { bytes: f.bytes });
      uploaded.push({ digest: f.digest, bytes: f.bytes });
    }
    const last = await to.create(request, { onLine: (l) => l?.status && log(`  ${to.host.name}: ${l.status}`) });
    if (last?.status && last.status !== 'success') throw new Error(`${to.host.name} did not finish building ${model} (last word: ${last.status})`);
    // Proof, not hope: every file is asked for again by its digest, and the model must now be listed.
    const present = await Promise.all(source.files.map((f) => to.hasBlob(f.digest)));
    const after = await to.tags();
    const listed = digestOf(after, model) !== undefined;
    const sameListingDigest = Boolean(row.fromDigest) && digestOf(after, model) === row.fromDigest;
    return {
      model, how: 'exact-copy', uploaded, skipped,
      verified: { everyFileOnDestination: present.every(Boolean), listed, sameListingDigest },
      note: present.every(Boolean) && listed
        ? (sameListingDigest ? 'Every file is on the destination under the same SHA-256, and both hosts list the same digest.'
          : 'Every weight file is on the destination under the same SHA-256. The listing digest differs because the destination wrote its own manifest; the weights are the same bytes.')
        : 'The copy did not verify: see the fields above.',
    };
  }

  // The source's files cannot be read from here (another machine), or the exact rebuild is not possible.
  const why = !local ? `${from.host.name} is another machine, so its files cannot be read from here`
    : !source ? `this Mac's store has no manifest for ${model}`
      : !source.complete ? 'a file this model needs is missing from this Mac\'s store'
        : request.reason;
  log(`  ${why}; asking ${to.host.name} to download ${model} by name`);
  const last = await to.pull(model, { onLine: (l) => l?.status && !l.completed && log(`  ${to.host.name}: ${l.status}`) });
  if (last?.status && last.status !== 'success') throw new Error(`${to.host.name} did not finish downloading ${model} (last word: ${last.status})`);
  const after = await to.tags();
  const got = digestOf(after, model);
  const sameListingDigest = Boolean(row.fromDigest) && got === row.fromDigest;
  return {
    model, how: 'downloaded-by-name', uploaded: [], skipped: [],
    verified: { everyFileOnDestination: unavailable('the files were not compared one by one'), listed: got !== undefined, sameListingDigest },
    note: sameListingDigest ? `${to.host.name} downloaded it and both hosts now list the same digest.`
      : `${to.host.name} downloaded a model with this name, but its digest is NOT the one ${from.host.name} lists. They are different builds. For an exact copy, run the sync on the machine that has the model.`,
    why,
  };
}
