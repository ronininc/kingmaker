// lib/module-reader.mjs — the module reader (owner item 9, 2026-11-05): the channel that reads Brain Library
// TRAINING MODULES into a session. The assessment that prompted item 9: the library stream carried model
// selection and pinned weights only — no channel put TEXT into context. This is that channel.
//
// MemPalace architecture (owner item 10): the reader never loads a module whole. It works in two storeys —
//   1. the INDEX storey: catalog/training/index.json + each module's module.json. Headings, keywords, topics
//      and QUALITY metadata only. No part body text exists at this storey, so planning a read costs no context.
//   2. the PART storey: one file per part. The reader opens ONLY the part files its selection chose.
// planSelection() runs entirely on storey 1 and reads no part file at all; readForSession() then opens
// exactly the chosen parts and returns their text, ready to drop into a session's context, under a char
// budget so the context is not destroyed (owner item 10's words).
//
// Source selection is customizable by QUALITY, not just source count: every module carries a quality tier
// (draft < community < vetted < canonical, lib/brain-library.mjs QUALITY_TIERS) and a 0–100 score. Callers
// may set a minimum tier and/or score, and quality breaks and boosts ranking among relevant parts — a
// lower-quality source covering the same topic is passed over for a higher-quality one.
//
// Discovery goes through the Brain Library: the default index is brain-library's TRAINING_INDEX_URL and the
// index is parsed by brain-library's normalizeTrainingIndex. Nothing here hardcodes a catalog path.
//
// Interface (for item 15, method files):
//   const reader = createModuleReader();                       // or { indexUrl, readText } for tests
//   await reader.listModules();                                // → [{ id, title, quality, topics, parts:[{id, heading, keywords}] }] (no body text)
//   await reader.planSelection(query, opts);                   // → { candidates, skippedForQuality } (no part files read)
//   await reader.readForSession(query, opts);                  // → { text, parts, stats } — `text` goes into context
//   opts: { maxParts=3, maxChars=12000, minQualityTier='draft', minQualityScore=0, qualityBoost=true }
//   readText(loc) is injectable: (URL) => Promise<string>. The default reads from disk.

import { readFile } from 'node:fs/promises';
import { QUALITY_TIERS, TRAINING_INDEX_URL, normalizeTrainingIndex, qualityRank } from './brain-library.mjs';

export { QUALITY_TIERS, qualityRank };

const defaultReadText = (loc) => readFile(loc, 'utf8');

const wordsOf = (s) => String(s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
/** Pure: relevance of one part to a query, from index-storey data only (heading, keywords, topics). */
export function scorePart(part, query) {
  const q = String(query ?? '').toLowerCase();
  const qWords = new Set(wordsOf(q));
  let score = 0;
  for (const kw of part.keywords ?? []) {
    const k = String(kw).toLowerCase();
    if (k.includes(' ') || k.includes('-')) { if (q.includes(k)) score += 4; }
    else if (qWords.has(k)) score += 3;
  }
  for (const w of wordsOf(part.heading)) if (qWords.has(w)) score += 2;
  for (const t of part.topics ?? []) if (qWords.has(String(t).toLowerCase())) score += 2;
  for (const w of wordsOf(part.moduleTitle)) if (qWords.has(w)) score += 1;
  return score;
}

export function createModuleReader({ indexUrl = TRAINING_INDEX_URL, readText = defaultReadText } = {}) {
  let cache = null; // [{ ...descriptor, topics, parts: [{ id, heading, keywords, topics, file, loc }] }]

  async function loadIndexStorey() {
    if (cache) return cache;
    const descriptors = normalizeTrainingIndex(JSON.parse(await readText(indexUrl)));
    // Pen-test F4: every catalog resolution is contained to the CATALOG ROOT (the index's
    // own directory). Part files were built with new URL(p.file, dirUrl) and never checked,
    // so a part of ../../../…, an index dir escaping the catalog, or an absolute file://
    // part URL all read arbitrary local files into session context. The root URL ends in
    // '/', so the prefix check is a true path-segment containment, not a string sibling.
    const catalogRootUrl = new URL('.', indexUrl);
    const contained = (url, what) => {
      if (url.href !== catalogRootUrl.href && !url.href.startsWith(catalogRootUrl.href)) {
        throw new Error(`module-reader: ${what} "${url.href}" escapes the catalog root — refused`);
      }
      return url;
    };
    const modules = [];
    for (const d of descriptors) {
      const dirUrl = contained(new URL(`${d.dir}/`, indexUrl), `module dir for "${d.id}"`);
      const manifest = JSON.parse(await readText(new URL('module.json', dirUrl)));
      if (manifest.id !== d.id) throw new Error(`module-reader: manifest id "${manifest.id}" does not match index id "${d.id}"`);
      // Pen-test F5: quality is the INDEX's record, never the manifest's claim. A module
      // whose manifest self-declared canonical/100 against an index community/10 used to
      // rank first and pass a canonical floor; the manifest's quality field is ignored —
      // where it disagrees with the index, the index values govern (clamped to the index).
      const quality = d.quality;
      modules.push({
        id: d.id, title: manifest.title ?? d.title, quality, topics: manifest.topics ?? [],
        parts: (manifest.parts ?? []).map((p) => ({
          id: p.id, heading: p.heading, keywords: p.keywords ?? [], topics: manifest.topics ?? [],
          moduleId: d.id, moduleTitle: manifest.title ?? d.title, quality,
          loc: contained(new URL(p.file, dirUrl), `part file "${p.file}" of module "${d.id}"`), file: p.file,
        })),
      });
    }
    cache = modules;
    return modules;
  }

  /** Index storey only: every module + part heading/quality. Body text is NOT loaded. */
  async function listModules() {
    const modules = await loadIndexStorey();
    return modules.map((m) => ({
      id: m.id, title: m.title, quality: m.quality, topics: m.topics,
      parts: m.parts.map((p) => ({ id: p.id, heading: p.heading, keywords: p.keywords })),
    }));
  }

  /**
   * Plan a read on the index storey: score every part, apply the caller's quality floor, rank.
   * Reads NO part files. Returns { candidates, skippedForQuality } — candidates are ranked best-first,
   * each { moduleId, partId, heading, qualityTier, qualityScore, relevance, rankScore }.
   */
  async function planSelection(query, { minQualityTier = 'draft', minQualityScore = 0, qualityBoost = true } = {}) {
    const minRank = qualityRank(minQualityTier);
    if (minRank < 0) throw new Error(`module-reader: unknown minQualityTier "${minQualityTier}" (tiers: ${QUALITY_TIERS.join(', ')})`);
    const modules = await loadIndexStorey();
    const candidates = [], skippedForQuality = [];
    for (const m of modules) for (const p of m.parts) {
      const relevance = scorePart(p, query);
      if (relevance <= 0) continue;
      const row = { moduleId: m.id, partId: p.id, heading: p.heading, qualityTier: p.quality.tier, qualityScore: p.quality.score, relevance };
      if (qualityRank(p.quality.tier) < minRank || p.quality.score < minQualityScore) { skippedForQuality.push({ ...row, reason: `below quality floor (tier >= ${minQualityTier}, score >= ${minQualityScore})` }); continue; }
      row.rankScore = relevance + (qualityBoost ? (p.quality.score / 100) * 2 : 0);
      candidates.push(row);
    }
    candidates.sort((a, b) => (b.rankScore - a.rankScore) || (b.relevance - a.relevance) || (b.qualityScore - a.qualityScore));
    skippedForQuality.sort((a, b) => b.relevance - a.relevance);
    return { candidates, skippedForQuality };
  }

  /**
   * THE text-into-context channel: select the parts this session needs and return their TEXT.
   * Only the selected part files are opened (partial reading); assembly stops at maxChars so a read
   * cannot destroy the context it feeds. Returns { text, parts, stats } where stats.partFilesRead
   * names exactly which part files were opened — the partial-read receipt.
   */
  async function readForSession(query, { maxParts = 3, maxChars = 12_000, ...qualityOpts } = {}) {
    const { candidates, skippedForQuality } = await planSelection(query, qualityOpts);
    const modules = await loadIndexStorey();
    const byKey = new Map(modules.flatMap((m) => m.parts.map((p) => [`${m.id}/${p.id}`, p])));
    const parts = [], partFilesRead = [];
    let text = '', bytesLoaded = 0;
    for (const c of candidates) {
      if (parts.length >= maxParts) break;
      const part = byKey.get(`${c.moduleId}/${c.partId}`);
      const body = await readText(part.loc); // the ONLY place part body text is ever read
      partFilesRead.push(`${c.moduleId}/${part.file}`);
      bytesLoaded += body.length;
      const block = `\n## ${part.moduleTitle} — ${part.heading}\n[module ${c.moduleId} · part ${c.partId} · quality ${c.qualityTier} ${c.qualityScore}]\n\n${body.trim()}\n`;
      if (text.length + block.length > maxChars && parts.length > 0) break;
      text += block;
      parts.push({ moduleId: c.moduleId, partId: c.partId, heading: c.heading, qualityTier: c.qualityTier, qualityScore: c.qualityScore, relevance: c.relevance, chars: body.length });
    }
    const header = `[Kingmaker training modules — read for: "${String(query)}" · ${parts.length} part(s), quality floor ${qualityOpts.minQualityTier ?? 'draft'}]\n`;
    return {
      text: parts.length ? header + text : '',
      parts, skippedForQuality,
      stats: { partFilesRead, bytesLoaded, candidatesConsidered: candidates.length + skippedForQuality.length, partsLoaded: parts.length },
    };
  }

  return { listModules, planSelection, readForSession };
}

/** One-shot convenience: a fresh reader, one query, the context text. */
export async function readTrainingContext(query, opts = {}) {
  const { readerOpts, ...readOpts } = opts;
  return createModuleReader(readerOpts).readForSession(query, readOpts);
}
