// lib/brain-library-access.mjs — the download/stream split over the Kingmaker Brain Library
// (owner item 13, 2026-11-05; purpose item 14: decentralize the weight/knowledge burden off
// weaker machines, no pay gate anywhere).
//
// The end state in the owner's words: "a person downloads Kingmaker and the Launcher,
// downloads the brains they want, and streams the ones they don't. The knowledge base —
// which also houses the training data — streams through Kingmaker directly. All of it
// appears in Data Sets under the Kingmaker Brain Library."
//
// So every library item — brains (models), training modules, method files, and the
// knowledge library itself (datasets KNOWLEDGE_ID, the dataset that houses the training
// data) — supports two modes, the user's per-item choice, recorded by the mode store in
// lib/datasets.mjs (stream is the default):
//
//   DOWNLOAD — the item is pulled range-by-range into a local store, the assembled bytes
//              are SHA-256-verified against the catalog hash, and reads are then served
//              from the resident copy. The item IS on disk, whole, named and sized.
//   STREAM   — the item is served through portion/range reads only. Each portion is
//              pulled on demand and lands in ONE rolling cache artifact per item
//              (<id>.stream-cache), overwritten by the next portion, so the cache is
//              bounded by the largest single portion ever requested — never by the
//              item's size. No full resident copy ever exists in stream mode. This is
//              the weak-machine property: heavy knowledge does not live resident on
//              weaker hardware.
//
// A SOURCE is the byte-addressable read path behind an item:
//   { id, kind, name, size, sha256|null, readRange(start, length) → Buffer }
// buildCatalogSources() builds the real ones from this tree's catalog: training modules
// (virtual concatenation of their part files — a range opens ONLY the part files it
// overlaps), method files, per-part sources for the module reader, model weights where
// the library carries a pinned hash + an injected range fetcher, and the knowledge
// library (virtual concatenation of every training part — the training data it houses).
// Tests inject deterministic in-memory sources through the same shape; the mechanism
// (chunked pull, hash acceptance, bounded cache, mode recording) is identical either way,
// in the pattern of the app-path streaming proven in the sockets build (item 2:
// downloadPartResumable — range segments, resume-shaped chunking, catalog-hash acceptance).
//
// The knowledge base streams through Kingmaker directly: streamingReadText() adapts this
// access layer into the readText shape lib/module-reader.mjs consumes, so a module-reader
// session read pulls each selected training part through the stream path on demand —
// parts pulled, never bulk-copied — while the reader's index storey (index + manifests,
// small metadata) still reads direct.
//
// No pay gate, no entitlement field: mode is placement only, both modes are always offered.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMethodsIndex, loadTrainingIndex } from './brain-library.mjs';
import { KNOWLEDGE_ID, MODE_DOWNLOAD, MODE_STREAM, createItemModeStore, itemModesPath } from './datasets.mjs';
import { createModuleReader } from './module-reader.mjs';

export { KNOWLEDGE_ID, MODE_DOWNLOAD, MODE_STREAM };
/** One pull segment / one stream portion may not exceed this: portions are bounded by design. */
export const MAX_PORTION_BYTES = 1_048_576;
/** Downloads pull in segments of this size (resume-shaped: a segment is re-pullable on its own). */
export const PULL_SEGMENT_BYTES = 262_144;

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
// Pen-test F6: the folded name alone was NOT injective — every character outside
// [a-zA-Z0-9._-] folded to '-', so distinct ids ("probe:a b" vs "probe:a-b", and
// real-shaped catalog ids using ':' and '/') shared one resident, receipt, and
// cache filename, and one item then served another's bytes as verified. Naming is
// now injective: an id that folding changes (or truncates) gets a suffix of 16 hex
// chars of the SHA-256 of the FULL id appended to its folded base. An id that
// survives folding byte-for-byte keeps its historic plain name — UNLESS it itself
// ends in '-<16 hex>', i.e. it looks exactly like a suffixed name, in which case
// it is suffixed too (otherwise a crafted plain id could impersonate another
// id's suffixed name). Distinct ids therefore never share a file: plain names
// are the ids themselves, suffixed names parse unambiguously as base + full-id
// hash, and no plain name can equal a suffixed one.
const safeName = (id) => {
  const folded = String(id).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'item';
  if (folded === String(id) && !/-[0-9a-f]{16}$/.test(folded)) return folded;
  return `${folded}-${sha256(Buffer.from(String(id), 'utf8')).slice(0, 16)}`;
};

/** Pure: the segments a pull of `size` bytes walks, each at most `segmentBytes`. */
export function planSegments(size, segmentBytes = PULL_SEGMENT_BYTES) {
  const out = [];
  for (let start = 0; start < size; start += segmentBytes) out.push({ start, length: Math.min(segmentBytes, size - start) });
  return out;
}

/** An in-memory source over one Buffer (fixtures, small catalog files, composed content). */
export function bufferSource({ id, kind, name, data, sha256: pinned = null }) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  return {
    id, kind, name: name ?? id, size: buf.length, sha256: pinned ?? sha256(buf),
    readRange: async (start, length) => buf.subarray(start, Math.min(buf.length, start + length)),
  };
}

/**
 * A virtual source over ordered member files (training module = its parts; the knowledge
 * library = every training part). A range read opens ONLY the member files it overlaps —
 * the portion property at the file level. `members` is [{ key, size, read() → Buffer }].
 */
export function virtualSource({ id, kind, name, members, sha256: pinned = null }) {
  const spans = [];
  let size = 0;
  for (const m of members) { spans.push({ ...m, start: size, end: size + m.size }); size += m.size; }
  return {
    id, kind, name: name ?? id, size, sha256: pinned, members: spans.map((s) => s.key),
    readRange: async (start, length) => {
      const wantEnd = Math.min(size, start + length);
      const chunks = [];
      for (const s of spans) {
        if (s.end <= start || s.start >= wantEnd) continue; // member not overlapped: never opened
        const body = await s.read();
        chunks.push(body.subarray(Math.max(0, start - s.start), wantEnd - s.start));
      }
      return Buffer.concat(chunks);
    },
  };
}

/** The real catalog sources from this tree's catalog/ tree. Sizes are stat'ed, never read whole.
 *  `fetchModelRange`, when supplied, is the only way model weights become sources. It is
 *  called as `fetchModelRange({ model, start, end, mode: 'stream' })` and must resolve
 *  to `{ bytes }`. Training modules, method files, and the knowledge library are built
 *  exactly as before when it is omitted. `models` is the library catalog entries that
 *  publish weights; omitted, no model source is added. */
export async function buildCatalogSources({ catalogDir = fileURLToPath(new URL('../catalog/', import.meta.url)), fetchModelRange = null, models = null } = {}) {
  const sources = new Map();
  const training = loadTrainingIndex({ indexUrl: new URL('training/index.json', `file://${catalogDir}`) });
  const knowledgeMembers = [];
  for (const mod of training) {
    const dir = join(catalogDir, 'training', mod.dir);
    const manifest = JSON.parse(await readFile(join(dir, 'module.json'), 'utf8'));
    const members = [];
    for (const p of manifest.parts ?? []) {
      const path = join(dir, p.file);
      const m = { key: `${mod.id}/${p.file}`, size: (await stat(path)).size, read: () => readFile(path) };
      members.push(m); knowledgeMembers.push(m);
      sources.set(`training-part:${mod.id}/${p.id}`, bufferSource({
        id: `training-part:${mod.id}/${p.id}`, kind: 'training-part', name: `${manifest.title ?? mod.id} — ${p.heading}`,
        data: await readFile(path),
      }));
    }
    sources.set(`training:${mod.id}`, virtualSource({ id: `training:${mod.id}`, kind: 'training', name: manifest.title ?? mod.id, members }));
  }
  // The knowledge base, which houses the training data: every training part, in index order.
  sources.set(KNOWLEDGE_ID, virtualSource({ id: KNOWLEDGE_ID, kind: 'knowledge', name: 'Knowledge library', members: knowledgeMembers }));
  const methods = loadMethodsIndex({ indexUrl: new URL('methods/index.json', `file://${catalogDir}`) });
  for (const meth of methods) {
    const path = join(catalogDir, 'methods', meth.file);
    sources.set(`method:${meth.id}`, bufferSource({
      id: `method:${meth.id}`, kind: 'method', name: meth.title ?? meth.id, data: await readFile(path),
    }));
  }
  if (typeof fetchModelRange === 'function') {
    for (const model of models ?? []) {
      const weights = model?.weights;
      if (!weights?.size || !weights?.sha256 || !Array.isArray(weights.parts) || !weights.parts.length) continue;
      const id = `model:${model.slug || model.tag}`;
      sources.set(id, {
        id, kind: 'model', name: model.tag ?? id, size: weights.size, sha256: weights.sha256,
        readRange: async (start, length) => {
          const got = await fetchModelRange({ model, start, end: start + length - 1, mode: 'stream' });
          const bytes = Buffer.isBuffer(got?.bytes) ? got.bytes : Buffer.from(got?.bytes ?? []);
          return bytes.subarray(0, length);
        },
      });
    }
  }
  return sources;
}

/**
 * The access layer. `sources` is a Map (or plain object) of id → source. `storeDir` holds
 * downloaded residents (<id>.resident + <id>.resident.json receipts); `cacheDir` holds the
 * bounded stream cache (<id>.stream-cache, one rolling artifact per item). `modeStore` is a
 * datasets.mjs item mode store (a file-backed one is made from `stateDir` when omitted).
 */
export function createBrainLibraryAccess({ sources, storeDir, cacheDir, modeStore = null, stateDir = null, maxPortionBytes = MAX_PORTION_BYTES } = {}) {
  if (!sources) throw new Error('brain-library-access: sources are required');
  const byId = sources instanceof Map ? sources : new Map(Object.entries(sources));
  if (!storeDir || !cacheDir) throw new Error('brain-library-access: storeDir and cacheDir are required');
  const modes = modeStore ?? createItemModeStore({ file: itemModesPath(stateDir ?? join(dirname(storeDir), 'state')) });
  const residentPath = (id) => join(storeDir, `${safeName(id)}.resident`);
  const receiptPath = (id) => join(storeDir, `${safeName(id)}.resident.json`);
  const cachePath = (id) => join(cacheDir, `${safeName(id)}.stream-cache`);
  const source = (id) => { const s = byId.get(id); if (!s) throw new Error(`brain-library-access: unknown library item "${id}"`); return s; };
  const dirBytes = async (dir) => {
    let total = 0; const files = [];
    let names = []; try { names = await readdir(dir); } catch { return { files, bytes: 0 }; }
    for (const n of names) { const p = join(dir, n); try { const st = await stat(p); if (st.isFile()) { files.push({ name: n, path: p, bytes: st.size }); total += st.size; } } catch { /* gone */ } }
    return { files, bytes: total };
  };

  async function residentReceipt(id) {
    try { return JSON.parse(await readFile(receiptPath(id), 'utf8')); } catch { return null; }
  }
  /** True only when the resident copy exists AND its bytes still hash to the receipt. */
  async function verifyResident(id) {
    const receipt = await residentReceipt(id);
    if (!receipt || !existsSync(residentPath(id))) return null;
    const data = await readFile(residentPath(id));
    const digest = sha256(data);
    return { ...receipt, ok: digest === receipt.sha256 && data.length === receipt.bytes, actualSha256: digest, actualBytes: data.length };
  }

  /** Every item with its recorded mode and its on-disk truth (resident? cache? sized). */
  async function listItems() {
    const out = [];
    for (const s of byId.values()) {
      const receipt = await residentReceipt(s.id);
      const cache = existsSync(cachePath(s.id)) ? (await stat(cachePath(s.id))).size : 0;
      out.push({
        id: s.id, kind: s.kind, name: s.name, size: s.size, sha256: s.sha256 ?? null,
        mode: modes.mode(s.id), resident: Boolean(receipt), residentBytes: receipt?.bytes ?? null,
        verified: receipt ? (await verifyResident(s.id))?.ok ?? false : false,
        cacheBytes: cache,
      });
    }
    return out;
  }

  /** Record the user's per-item choice (lib/datasets.mjs mode store). */
  function setMode(id, mode) { source(id); return modes.set(id, mode); }
  function getMode(id) { source(id); return modes.mode(id); }

  /**
   * DOWNLOAD mode: pull the item segment-by-segment through the range read path into the
   * local store, then accept it only when the assembled bytes hash to the source's pinned
   * SHA-256 (catalog-hash acceptance). A hash mismatch deletes the pull — a corrupt
   * resident is never served. On success the item's recorded mode becomes 'download'.
   */
  async function download(id) {
    const s = source(id);
    await mkdir(storeDir, { recursive: true });
    const tmp = `${residentPath(id)}.part`;
    const chunks = [];
    for (const seg of planSegments(s.size)) {
      const data = await s.readRange(seg.start, seg.length);
      if (data.length !== seg.length) throw new Error(`brain-library-access: short pull of "${id}" at ${seg.start} (got ${data.length} of ${seg.length})`);
      chunks.push(data);
    }
    const whole = Buffer.concat(chunks);
    const digest = sha256(whole);
    if (s.sha256 && digest !== s.sha256) {
      await rm(tmp, { force: true });
      throw new Error(`brain-library-access: hash mismatch pulling "${id}" (catalog ${s.sha256}, pulled ${digest}) — resident refused`);
    }
    await writeFile(tmp, whole);
    await rename(tmp, residentPath(id));
    const receipt = { id, kind: s.kind, bytes: whole.length, sha256: digest, verified: true, at: new Date().toISOString() };
    await writeFile(receiptPath(id), JSON.stringify(receipt, null, 2), { mode: 0o600 });
    await rm(cachePath(id), { force: true }); // resident now; the stream cache for this item is moot
    modes.set(id, MODE_DOWNLOAD);
    return { ...receipt, path: residentPath(id), mode: MODE_DOWNLOAD };
  }

  /**
   * Read one portion of an item. Downloaded items serve the portion from the resident
   * copy (from: 'local', nothing touches the cache). Streamed items pull exactly that
   * range through the source and land it in the item's single rolling cache artifact —
   * overwritten next portion, so stream cache per item never exceeds one portion.
   */
  async function readPortion(id, { start = 0, length } = {}) {
    const s = source(id);
    if (!Number.isFinite(length) || length <= 0) throw new Error('brain-library-access: readPortion needs a positive length');
    if (length > maxPortionBytes) throw new Error(`brain-library-access: portion of ${length} exceeds the ${maxPortionBytes}-byte portion bound — pull it in portions`);
    if (start < 0 || start >= s.size) throw new Error(`brain-library-access: portion start ${start} is outside "${id}" (${s.size} bytes)`);
    const mode = modes.mode(id);
    if (mode === MODE_DOWNLOAD) {
      const v = await verifyResident(id);
      if (v?.ok) {
        const data = await readFile(residentPath(id));
        return { id, mode, from: 'local', start, data: data.subarray(start, Math.min(data.length, start + length)), cacheBytes: 0, cacheFile: null };
      }
      // Recorded downloaded but no verified resident: fall through to the stream path
      // rather than serving unverified bytes; the caller can re-run download().
    }
    const data = await s.readRange(start, length);
    await mkdir(cacheDir, { recursive: true });
    await writeFile(cachePath(id), data); // the rolling artifact: this portion replaces the last
    return { id, mode: MODE_STREAM, from: 'stream', start, data, cacheBytes: data.length, cacheFile: cachePath(id) };
  }

  /** Convenience: a portion decoded as UTF-8 text (training/method/knowledge reads). */
  async function readTextPortion(id, opts) {
    const r = await readPortion(id, opts);
    return { ...r, text: r.data.toString('utf8') };
  }

  /**
   * Stream an item end to end in portions (a job consuming a whole brain it did not
   * download): every portion passes through the bounded rolling cache; at no point does
   * a resident copy exist. `onPortion(data, start)` receives each portion in order.
   */
  async function streamThrough(id, { portionBytes = 65_536, onPortion } = {}) {
    const s = source(id);
    let portions = 0, bytes = 0;
    for (const seg of planSegments(s.size, Math.min(portionBytes, maxPortionBytes))) {
      const r = await readPortion(id, seg);
      if (r.from !== 'stream') throw new Error(`brain-library-access: "${id}" is resident — streamThrough is the no-resident path`);
      portions++; bytes += r.data.length;
      if (onPortion) await onPortion(r.data, seg.start);
    }
    return { id, portions, bytes, mode: MODE_STREAM };
  }

  /** Remove an item's resident copy + cache and record it back to the stream default. */
  async function forget(id) {
    source(id);
    await rm(residentPath(id), { force: true });
    await rm(receiptPath(id), { force: true });
    await rm(cachePath(id), { force: true });
    modes.set(id, MODE_STREAM);
  }

  /** The disk truth, for the weak-machine demonstration: what each dir holds, named + sized. */
  async function diskState() {
    const store = await dirBytes(storeDir);
    const cache = await dirBytes(cacheDir);
    return { storeDir, cacheDir, storeFiles: store.files, storeBytes: store.bytes, cacheFiles: cache.files, cacheBytes: cache.bytes };
  }

  return { listItems, setMode, getMode, download, readPortion, readTextPortion, streamThrough, forget, verifyResident, diskState, modes };
}

/**
 * A module-reader readText that serves TRAINING PART files through this access layer's
 * stream path: a part file URL (…/training/<dir>/parts/<file>) is resolved to its catalog
 * part source and pulled as portions on demand — never bulk-copied, never resident.
 * Index-storey reads (index.json, module.json — small metadata) pass through to disk.
 * `onPartPull({ id, bytes })` is an optional receipt hook.
 */
export function streamingReadText(access, { readDisk = (loc) => readFile(loc, 'utf8'), onPartPull = null, trainingIndex = null } = {}) {
  let partByPath = null; // Map<pathname suffix 'modules/<dir>/parts/<file>', sourceId>
  async function buildMap() {
    if (partByPath) return partByPath;
    const index = trainingIndex ?? loadTrainingIndex();
    partByPath = new Map();
    for (const mod of index) {
      const manifest = JSON.parse(await readFile(new URL(`${mod.dir}/module.json`, new URL('../catalog/training/', import.meta.url)), 'utf8').catch(() => '{}'));
      for (const p of manifest.parts ?? []) partByPath.set(`${mod.dir}/${p.file}`, `training-part:${mod.id}/${p.id}`);
    }
    return partByPath;
  }
  return async (loc) => {
    const path = decodeURIComponent(new URL(String(loc), 'file:///').pathname ?? String(loc));
    if (!path.includes('/training/modules/') || !path.includes('/parts/')) return readDisk(loc);
    const suffix = path.slice(path.indexOf('/training/') + '/training/'.length);
    const map = await buildMap();
    const sourceId = map.get(suffix);
    if (!sourceId) return readDisk(loc);
    // Portion pulls on demand: walk the part in portions through the stream path and join.
    const items = await access.listItems();
    const item = items.find((i) => i.id === sourceId);
    if (!item) return readDisk(loc);
    const chunks = [];
    for (const seg of planSegments(item.size, 65_536)) {
      const r = await access.readPortion(sourceId, seg);
      chunks.push(r.data);
    }
    if (onPartPull) onPartPull({ id: sourceId, bytes: item.size });
    return Buffer.concat(chunks).toString('utf8');
  };
}

/**
 * The knowledge base streaming through Kingmaker directly (item 13.2): a module-reader
 * session read whose part files arrive through the stream path above. The knowledge
 * library (KNOWLEDGE_ID) houses this training data; reading it this way leaves no
 * resident copy of any part — portions only, in the bounded cache.
 */
export async function readKnowledgeStreamed(access, query, { readerOpts = {}, streamOpts = null, ...readOpts } = {}) {
  const reader = createModuleReader({ ...readerOpts, readText: streamingReadText(access, streamOpts ?? readerOpts.streamOpts ?? {}) });
  return reader.readForSession(query, readOpts);
}
