// lib/brain-library-fleet-door.mjs — Fleet Replication closeout, item 1:
// the door range fetcher, wired into the fleet catalog publish composition.
//
// The fleet catalog builder (lib/brain-library-fleet-catalog.mjs) publishes
// model descriptors when the publish build passes
// buildCatalogSources({ fetchModelRange, models }): model weights become
// sources whose readRange is answered by the injected fetcher, and the
// builder computes every portion pin from the bytes that fetcher returns.
// Until this module, no publish run ever wired a fetcher, so the published
// catalog carried no model entries.
//
// This module supplies the two things the publish composition needs:
//
//   loadDoorModels()       — the door's own model list: library.json from
//     the public kingmaker-brain-library repo, fetched unauthenticated from
//     LIBRARY_RAW — exactly where the shipped engine reads its catalog
//     (lib/brain-library.mjs). Only entries that publish weights can become
//     sources; the rest are named in `withoutWeights`, never dropped
//     silently.
//
//   createDoorRangeFetcher() — a fetchModelRange with the access layer's
//     exact contract ({ model, start, end, mode: 'stream' } → { bytes, … }),
//     answered by HTTP Range requests against the release assets' browser
//     download URLs — the same URLs the shipped CLI's pull constructs
//     (github.com/<repo>/releases/download/<release>/<part>).
//
// Why not lib/brain-library-fetch.mjs's fetchModelRange, the runtime
// fetcher? It is API-first by design (GET /repos/…/releases/assets/<id>),
// and GitHub's unauthenticated API budget is 60 requests an hour. A publish
// pass reads a whole model portion by portion — 1,057 range reads for the
// smallest weights model at 1 MiB portions — so the API-first path cannot
// complete a publish run unauthenticated; it would die RATE_LIMITED an hour
// in. The download-URL path is the door's public path: github.com redirects
// to the asset CDN, Range is honored there, and no API budget is consumed.
// github-release-asset.mjs itself sanctions this path (it is its own
// fallback); the pins are the acceptance test either way — the builder
// refuses to publish a descriptor whose computed whole-item hash differs
// from the catalog's pinned sha256, so a wrong byte from any transport is
// a publish failure, never a published lie.
//
// No credential is read or sent anywhere in this module: the door is public
// by design, and a range answer is believed only after its hash lands in a
// descriptor that must match the door catalog's own pin.

import { createHash } from 'node:crypto';
import { LIBRARY_RAW, LIBRARY_REPO } from './brain-library.mjs';
import { browserDownloadUrl, isHtmlPayload } from './github-release-asset.mjs';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function doorError(code, message, extra = {}) {
  const err = new Error(`brain-library-fleet-door: ${message}`);
  err.code = code;
  return Object.assign(err, extra);
}

/**
 * The door's model list, read live from the published library.json.
 * → { models, withoutWeights, libraryUrl, updatedAt }
 * `models` carries only entries whose weights block is complete enough to
 * be a source (size + whole sha256 + at least one part) — the same gate
 * buildCatalogSources applies — and every excluded entry is named in
 * `withoutWeights` with its tag.
 */
export async function loadDoorModels({ libraryUrl = `${LIBRARY_RAW}/library.json`, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(libraryUrl, { headers: { 'user-agent': 'kingmaker-fleet-publish' } });
  if (res.status !== 200) throw doorError('FLEET_DOOR_UNAVAILABLE', `the door catalog answered HTTP ${res.status} at ${libraryUrl}`, { status: res.status });
  const text = await res.text();
  if (isHtmlPayload(text, res.headers?.get?.('content-type') || '')) {
    throw doorError('FLEET_DOOR_UNAVAILABLE', `the door catalog at ${libraryUrl} returned HTML, not library.json`);
  }
  const library = JSON.parse(text);
  const models = [];
  const withoutWeights = [];
  for (const m of library?.models ?? []) {
    const w = m?.weights;
    if (w?.size && w?.sha256 && Array.isArray(w?.parts) && w.parts.length) models.push(m);
    else withoutWeights.push(m?.tag ?? m?.slug ?? 'unknown');
  }
  return { models, withoutWeights, libraryUrl, updatedAt: library?.updatedAt ?? null };
}

/** The smallest weights-bearing model — the sane proof/publish-run pick. */
export function smallestWeightsModel(models) {
  const sorted = [...(models ?? [])].sort((a, b) => a.weights.size - b.weights.size);
  return sorted[0] ?? null;
}

function partSpans(weights) {
  let cursor = 0;
  return (weights?.parts ?? []).map((part) => {
    const start = cursor;
    cursor += part.size;
    return { ...part, start, end: cursor - 1 };
  });
}

/**
 * A fetchModelRange over the door's public download URLs.
 * Options: `repo` (default LIBRARY_REPO), `fetchImpl`, `sleep`,
 * `maxAttempts` (per range; 403/429/5xx back off like the codebase's own
 * asset path), `onRange({ model, start, end, bytes, via })` — a receipt
 * hook fired per answered range, for publish-run accounting.
 * `prefetchRanges` (default 0) is a publish-run optimization: after a range
 * is answered, the next N same-size ranges of the same part are fetched in
 * the background (the part's total size is learned from the 206
 * Content-Range header, so prefetch never runs past the part's end).
 * Callers read portion by portion in order — the catalog builder does — so
 * the prefetched promises are consumed in order; a failed prefetch is
 * swallowed and the real request simply fetches again and reports its own
 * failure. Correctness never depends on the window.
 */
export function createDoorRangeFetcher({ repo = LIBRARY_REPO, fetchImpl = fetch, sleep = defaultSleep, maxAttempts = 4, onRange = null, prefetchRanges = 0 } = {}) {
  const [owner, repoName] = String(repo).split('/');
  if (!owner || !repoName) throw new Error(`brain-library-fleet-door: repo must be "owner/name", got "${repo}"`);
  const prefetchCache = new Map(); // `${url}|${start}|${end}` -> Promise<{bytes,total}|null>

  async function fetchRangeOnce(url, start, end) {
    let lastStatus = 0;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const res = await fetchImpl(url, { headers: { range: `bytes=${start}-${end}`, 'user-agent': 'kingmaker-fleet-publish' }, redirect: 'follow' });
      lastStatus = res.status;
      if (res.status === 206) {
        const bytes = Buffer.from(await res.arrayBuffer());
        if (isHtmlPayload(bytes, res.headers?.get?.('content-type') || '')) throw doorError('FLEET_DOOR_HTML', `${url} answered an HTML page for range ${start}-${end}`);
        const m = /\/(\d+)$/.exec(res.headers?.get?.('content-range') || '');
        return { bytes, total: m ? Number(m[1]) : null };
      }
      if (res.status === 200) {
        // The range was ignored and the whole part arrived: slice the ask
        // out of it rather than failing a public door for being generous.
        const all = Buffer.from(await res.arrayBuffer());
        if (isHtmlPayload(all, res.headers?.get?.('content-type') || '')) throw doorError('FLEET_DOOR_HTML', `${url} answered an HTML page`);
        return { bytes: all.subarray(start, end + 1), total: all.length };
      }
      try { await res.body?.cancel?.(); } catch { /* dropped */ }
      const retryable = res.status === 403 || res.status === 429 || res.status >= 500;
      if (!retryable || attempt === maxAttempts - 1) break;
      await sleep(Math.min(8_000, 500 * 2 ** attempt));
    }
    throw doorError('FLEET_DOOR_RANGE_FAILED', `${url} answered HTTP ${lastStatus || 'none'} for range ${start}-${end}`, { status: lastStatus });
  }

  async function fetchRange(url, start, end) {
    const key = `${url}|${start}|${end}`;
    const hit = prefetchCache.get(key);
    if (hit) {
      prefetchCache.delete(key);
      const got = await hit;
      if (got) return got.bytes;
      // a swallowed prefetch failure: fall through and fetch for real
    }
    const got = await fetchRangeOnce(url, start, end);
    if (prefetchRanges > 0 && got.total != null) {
      const len = end - start + 1;
      for (let i = 1; i <= prefetchRanges; i++) {
        const ns = start + i * len;
        if (ns > got.total - 1) break;
        const ne = Math.min(ns + len - 1, got.total - 1);
        const k = `${url}|${ns}|${ne}`;
        if (!prefetchCache.has(k)) prefetchCache.set(k, fetchRangeOnce(url, ns, ne).catch(() => null));
      }
      while (prefetchCache.size > prefetchRanges * 2) prefetchCache.delete(prefetchCache.keys().next().value);
    }
    return got.bytes;
  }

  return async function fetchModelRange({ model, start = 0, end = null, mode = 'stream' } = {}) {
    if (!model?.weights) throw new Error('brain-library-fleet-door: fetchModelRange needs a library model that publishes weights');
    if (mode !== 'stream') throw new Error(`brain-library-fleet-door: only stream mode is a range fetch (got ${mode})`);
    const rangeEnd = end ?? start;
    const spans = partSpans(model.weights);
    const chunks = [];
    let cursor = start;
    while (cursor <= rangeEnd) {
      const span = spans.find((p) => cursor >= p.start && cursor <= p.end);
      if (!span) break;
      const localStart = cursor - span.start;
      const localEnd = Math.min(rangeEnd - span.start, span.size - 1);
      const url = browserDownloadUrl({ owner, repo: repoName, release: model.weights.release, name: span.name });
      const bytes = await fetchRange(url, localStart, localEnd);
      if (!bytes.length) break;
      chunks.push(bytes);
      if (onRange) { try { await onRange({ model: model.tag ?? model.slug, start: cursor, end: cursor + bytes.length - 1, bytes: bytes.length, via: url }); } catch { /* a receipt hook never breaks the fetch */ } }
      cursor += bytes.length;
    }
    if (!chunks.length) throw doorError('FLEET_DOOR_OUT_OF_RANGE', `byte ${start} is outside ${model.tag}`, { start });
    const bytes = Buffer.concat(chunks);
    return {
      mode: 'stream', transport: 'http-range', via: 'browser-download-url', bytes,
      start, end: start + bytes.length - 1, sha256: sha256(bytes),
      verification: 'UNVERIFIED — the caller checks these bytes against the pins',
      streamedToOllama: false, ollamaReady: false,
    };
  };
}
