// lib/brain-library-repo.mjs — the Brain Library REPO supplier (FIX-G, 2026-11-13).
//
// The access layer (lib/brain-library-access.mjs) and the method conductor / module
// reader were built remote-ready, but nothing ever supplied them from the library
// repo: methods, training modules and the knowledge library were read from the
// install's bundled catalog/ tree only, and buildCatalogSources had no caller. This
// module is the missing supplier. It builds catalog sources — the SAME ids and kinds
// buildCatalogSources builds locally (method:<id>, training:<id>,
// training-part:<mod>/<part>, the knowledge library) plus the skills lane
// (skill:<slug>) — whose payloads are fetched lazily from the library repo's
// intelligence/ lanes:
//
//   <baseUrl>/intelligence/methods/index.json    schema kingmaker.methods/1 (unchanged)
//   <baseUrl>/intelligence/training/index.json   schema kingmaker.training-modules/1 (unchanged)
//   <baseUrl>/intelligence/skills/index.json     schema kingmaker.skills/1 (thin, new)
//
// Indexes are validated by the same normalizers the bundled path uses. Each payload
// carries a sha256 + size pin in its lane index (module manifests pin their parts),
// so the access layer's DOWNLOAD-mode hash acceptance works remotely exactly as it
// does locally — remotely it is stricter: a payload whose index pin is missing, or
// whose bytes arrive at a different size than pinned, is refused, never served.
// Payloads are KB-scale text: a member fetch is one portion at these sizes, and the
// virtual-source overlap rule still guarantees a range read fetches ONLY the member
// files it overlaps — the portion property survives at file granularity, exactly as
// on the local build. A member's bytes are held only after its first read; a source
// nobody reads costs its index fetch and nothing more.
//
// createRepoReadText is the conductor/reader seam (§1.4 of the design): https →
// fetch (timeout, non-200 throws), file:// → disk, so tests, fixtures and the
// bundled floor share one code path. With `fallbackCatalogUrl` set, a failed repo
// read of a URL under the supplier root is retried against the bundled catalog on
// disk (the offline floor); if the floor misses too, the repo error stands —
// fail-closed, never a different item's bytes.
//
// One module-shape note: the access module injects its virtualSource constructor
// into this module at load (registerVirtualSource below) instead of the other
// way around — a static import cycle back into the access module would evaluate
// this module before the access module's top-level constants initialize, which
// the weights path (brain-library-fetch, a top-level reader of one of those
// constants) cannot survive. The injected constructor is the same function the
// bundled build uses; nothing about the sources changes.
//
// Weights are NOT this module's lane: fetchModelRange keeps its exact contract and
// the bench-cli release-parts machinery remains the weights supplier.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { LIBRARY_RAW, normalizeMethodsIndex, normalizeTrainingIndex, qualityRank } from './brain-library.mjs';
import { KNOWLEDGE_ID } from './datasets.mjs';

// NOTE — no import of ./brain-library-access.mjs here, deliberately: the access
// module imports this one (for buildCatalogSources' `remote` option), and the
// weights module (brain-library-fetch) reads a top-level constant of the access
// module during its own evaluation. A static cycle back into the access module
// would evaluate this module before the access module's constants initialize
// and break that reader. The one access-layer constructor this module needs —
// virtualSource — is injected by the access module itself (see below).

// The slot is declared with `var` and NO initializer, deliberately (sibling of
// the brain-library-fetch LIBRARY_REPO TDZ fix, 2026-11-13). Entering the
// module graph through THIS module starts its import phase first: the chain
// brain-library -> ... -> tool-streaming / brain-library-fetch pulls in the
// access module, whose top level calls registerVirtualSource() — a write to
// this slot — before this module's body has run. A `let`/`const` slot is
// still in its temporal dead zone at that point and the write throws
// "Cannot access 'virtualSourceImpl' before initialization". A `var` binding
// is initialized (to undefined) at module instantiation, before any import in
// the graph evaluates, so the registration write lands; and with no
// initializer, this module's own body — which runs AFTER that registration in
// the same entry order — cannot clobber it back to empty. The slot is only
// ever read at call time (virtualSource below), and the guard there already
// treats undefined exactly like the null it replaces: not registered.
var virtualSourceImpl;
/** Called once by lib/brain-library-access.mjs at module load to inject its
 *  virtualSource constructor (see the note above). */
export function registerVirtualSource(fn) { virtualSourceImpl = fn; }
function virtualSource(opts) {
  if (!virtualSourceImpl) throw new Error('brain-library-repo: virtualSource is not registered — import lib/brain-library-access.mjs before building repo sources');
  return virtualSourceImpl(opts);
}

export const SKILLS_SCHEMA = 'kingmaker.skills/1';
export const DEFAULT_TIMEOUT_MS = 20_000;

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const repoRoot = (baseUrl, intelligencePath) => `${String(baseUrl ?? LIBRARY_RAW).replace(/\/+$/, '')}/${String(intelligencePath ?? 'intelligence').replace(/^\/+|\/+$/g, '')}`;

/** The repo index URL for one lane ('methods' | 'training' | 'skills'). */
export function repoIndexUrl(lane, { baseUrl = LIBRARY_RAW, intelligencePath = 'intelligence' } = {}) {
  return `${repoRoot(baseUrl, intelligencePath)}/${lane}/index.json`;
}

/** Remote intelligence is on unless the owner forces the bundled floor. */
export function libraryRemoteEnabled(env = process.env) {
  return String(env?.KINGMAKER_LIBRARY_REMOTE ?? '').trim().toLowerCase() !== 'off';
}

function fetchFailed(url, cause) {
  const err = new Error(`brain-library-repo: fetch of ${url} failed (${cause?.message ?? cause})`);
  err.code = 'REPO_FETCH_FAILED'; err.url = url; err.cause = cause;
  return err;
}

/** Pure: validate + normalize a parsed skills index (schema kingmaker.skills/1).
 *  Thin by design: metadata only — bodies stay in the payload files. */
export function normalizeSkillsIndex(index) {
  if (!index || index.schema !== SKILLS_SCHEMA || !Array.isArray(index.skills)) {
    throw new Error(`brain-library-repo: skills index is not ${SKILLS_SCHEMA}`);
  }
  return index.skills.map((s) => {
    if (!s?.slug || !s?.file || !s?.sha256 || !Number.isFinite(s?.size) || s.size < 0 || !s?.quality || qualityRank(s.quality.tier) < 0 || !Number.isFinite(s.quality.score)) {
      throw new Error(`brain-library-repo: skill entry is malformed (slug=${s?.slug ?? '?'})`);
    }
    return {
      slug: s.slug, title: s.title ?? s.slug, file: s.file, size: s.size, sha256: s.sha256,
      lane: s.lane ?? null, quality: { tier: s.quality.tier, score: s.quality.score, basis: s.quality.basis ?? null },
    };
  });
}

/**
 * One lazily fetched payload behind a virtual-source member / source readRange.
 * Nothing crosses the wire until the first read; the fetched bytes are then held
 * by this member (payloads are portions at catalog sizes). A fetch that arrives
 * at a different size than the index pin is refused and NOT cached, so a later
 * read retries the wire rather than serving suspect bytes.
 */
function lazyMember({ key, url, size, fetchBuffer }) {
  let held = null;
  const load = () => {
    if (!held) {
      held = fetchBuffer(url).then((buf) => {
        if (buf.length !== size) {
          throw new Error(`brain-library-repo: "${key}" arrived as ${buf.length} bytes; the index pins ${size} — payload refused`);
        }
        return buf;
      });
      held.catch(() => { held = null; });
    }
    return held;
  };
  return {
    key, size,
    read: load,
    readRange: async (start, length) => (await load()).subarray(start, Math.min(size, start + length)),
  };
}

/**
 * Build the repo-supplied catalog sources. Fetches the three lane indexes (the
 * skills lane is optional: a repo without one simply contributes no skill
 * sources) and each training module's manifest; payloads stay lazy. Rejects
 * with a REPO_FETCH_FAILED error when the repo cannot be read — callers that
 * merge over the bundled floor (buildCatalogSources' `remote` option) turn
 * that into the floor standing alone, never into fabricated content.
 */
export async function buildRepoCatalogSources({ baseUrl = LIBRARY_RAW, fetchImpl = fetch, intelligencePath = 'intelligence', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const root = repoRoot(baseUrl, intelligencePath);
  const fetchBuffer = async (url) => {
    let res;
    try { res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) }); }
    catch (e) { throw fetchFailed(url, e); }
    if (!res?.ok) throw fetchFailed(url, new Error(`HTTP ${res?.status ?? 'no response'}`));
    return Buffer.from(await res.arrayBuffer());
  };
  const fetchJson = async (url) => JSON.parse((await fetchBuffer(url)).toString('utf8'));
  const pinOf = (entry, what) => {
    const size = Number(entry?.size);
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(`brain-library-repo: ${what} carries no size pin in the repo index — the intelligence layout requires sha256+size pins on every payload`);
    }
    return { size, sha256: entry?.sha256 ?? null };
  };

  const sources = new Map();

  // ── Training + knowledge ──────────────────────────────────────────────────
  const trainingRaw = await fetchJson(`${root}/training/index.json`);
  const training = normalizeTrainingIndex(trainingRaw);
  const modulePins = new Map((trainingRaw.modules ?? []).map((m) => [m.id, m]));
  const knowledgeMembers = [];
  for (const mod of training) {
    const modBase = `${root}/training/${mod.dir}`;
    const manifest = await fetchJson(`${modBase}/module.json`);
    const partPins = new Map((manifest.parts ?? []).map((p) => [p.id, p]));
    const members = [];
    for (const p of manifest.parts ?? []) {
      const pin = pinOf(partPins.get(p.id), `training part "${mod.id}/${p.id}"`);
      const member = lazyMember({ key: `${mod.id}/${p.file}`, url: `${modBase}/${p.file}`, size: pin.size, fetchBuffer });
      members.push(member); knowledgeMembers.push(member);
      sources.set(`training-part:${mod.id}/${p.id}`, {
        id: `training-part:${mod.id}/${p.id}`, kind: 'training-part',
        name: `${manifest.title ?? mod.id} — ${p.heading}`, size: pin.size, sha256: pin.sha256,
        readRange: member.readRange,
      });
    }
    const modPin = modulePins.get(mod.id) ?? {};
    sources.set(`training:${mod.id}`, virtualSource({
      id: `training:${mod.id}`, kind: 'training', name: manifest.title ?? mod.id, members,
      sha256: modPin.sha256 ?? null,
    }));
  }
  // The knowledge base, which houses the training data: every training part, in index order.
  sources.set(KNOWLEDGE_ID, virtualSource({ id: KNOWLEDGE_ID, kind: 'knowledge', name: 'Knowledge library', members: knowledgeMembers }));

  // ── Methods ───────────────────────────────────────────────────────────────
  const methodsRaw = await fetchJson(`${root}/methods/index.json`);
  const methods = normalizeMethodsIndex(methodsRaw);
  const methodPins = new Map((methodsRaw.methods ?? []).map((m) => [m.id, m]));
  for (const meth of methods) {
    const pin = pinOf(methodPins.get(meth.id), `method "${meth.id}"`);
    const member = lazyMember({ key: meth.file, url: `${root}/methods/${meth.file}`, size: pin.size, fetchBuffer });
    sources.set(`method:${meth.id}`, {
      id: `method:${meth.id}`, kind: 'method', name: meth.title ?? meth.id,
      size: pin.size, sha256: pin.sha256, readRange: member.readRange,
    });
  }

  // ── Skills (optional lane: absent index = no skill sources, not an error) ──
  try {
    const skillsRaw = await fetchJson(`${root}/skills/index.json`);
    for (const s of normalizeSkillsIndex(skillsRaw)) {
      const member = lazyMember({ key: s.file, url: `${root}/skills/${s.file}`, size: s.size, fetchBuffer });
      sources.set(`skill:${s.slug}`, {
        id: `skill:${s.slug}`, kind: 'skill', name: s.title,
        size: s.size, sha256: s.sha256, readRange: member.readRange,
      });
    }
  } catch (e) { if (e?.code !== 'REPO_FETCH_FAILED') throw e; }

  return sources;
}

/**
 * The readText seam for the method conductor and the module reader: https →
 * fetch with a timeout (non-200 throws REPO_FETCH_FAILED); file:// and plain
 * paths → disk, so tests, fixtures and the bundled floor share this code path.
 * `fallbackCatalogUrl` (a file:// URL of the bundled catalog/ root) is the
 * offline floor for conductors: a failed repo read under the supplier root is
 * retried against the bundled file at the same lane-relative path; a floor
 * miss rethrows the repo error — fail-closed, never substituted bytes.
 */
export function createRepoReadText({ baseUrl = LIBRARY_RAW, intelligencePath = 'intelligence', fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, readDisk = (loc) => readFile(loc, 'utf8'), fallbackCatalogUrl = null } = {}) {
  const root = repoRoot(baseUrl, intelligencePath);
  return async (loc) => {
    const url = String(loc);
    if (!/^https?:\/\//.test(url)) return readDisk(loc);
    let err;
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res?.ok) throw fetchFailed(url, new Error(`HTTP ${res?.status ?? 'no response'}`));
      return await res.text();
    } catch (e) { err = e?.code === 'REPO_FETCH_FAILED' ? e : fetchFailed(url, e); }
    if (fallbackCatalogUrl && url.startsWith(`${root}/`)) {
      try { return await readDisk(new URL(url.slice(root.length + 1), fallbackCatalogUrl)); }
      catch { /* the floor misses too: the repo error stands */ }
    }
    throw err;
  };
}
