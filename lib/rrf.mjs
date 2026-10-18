// lib/rrf.mjs — Reciprocal Rank Fusion for Kingmaker's hybrid file search (docs/HYBRID-SEARCH.md). Keyword (FTS5 BM25)
// and semantic (vector kNN) each return a ranked list of the same doc ids; RRF merges them by RANK, never by raw score,
// so BM25 and cosine never have to be put on the same scale. The owner, 2026-10-15: "Spec the FTS5 + vector RRF hybrid
// search for Kingmaker's file RAG." This is the pure fusion step, the one tested source of truth mirrored in the engine's
// core query path. No dependencies, no I/O.
//
//   RRF(d) = Σ over lists L   w_L / (k + rank_L(d))        rank 1-based; a doc missing from a list adds nothing for it.

/** The paper's (and Ghost's) default damping constant. Larger k flattens the advantage of the very top ranks. */
export const DEFAULT_K = 60;

/**
 * Fuse ranked lists. Each list is best-first; items are doc ids (string/number) OR objects carrying one under `id`,
 * `docId` or `doc_id`. → [{ docId, score, ranks }] best-first, at most `limit`.
 *   k        damping constant (DEFAULT_K)
 *   weights  per-list multipliers, aligned to `rankedLists` (default 1 each)
 *   limit    how many fused results to return (default 20)
 * A doc's first (best) rank in a list wins if it somehow appears twice there. Ties break by doc id, so the same inputs
 * always rank the same way.
 */
export function rrfFuse(rankedLists, { k = DEFAULT_K, weights = null, limit = 20 } = {}) {
  const kk = Number.isFinite(k) && k > 0 ? k : DEFAULT_K;
  const lists = Array.isArray(rankedLists) ? rankedLists : [];
  const score = new Map(); // docId -> { score, ranks }
  lists.forEach((list, i) => {
    const w = Number.isFinite(weights?.[i]) ? weights[i] : 1;
    const seen = new Set();
    (Array.isArray(list) ? list : []).forEach((item, idx) => {
      const docId = idOf(item);
      if (docId === null || seen.has(docId)) return; // only the best rank per list counts
      seen.add(docId);
      const rank = idx + 1;
      const e = score.get(docId) ?? { score: 0, ranks: [] };
      e.score += w / (kk + rank);
      e.ranks[i] = rank;
      score.set(docId, e);
    });
  });
  const lim = Number.isInteger(limit) && limit >= 0 ? limit : 20;
  return [...score.entries()]
    .sort((a, b) => b[1].score - a[1].score || cmpId(a[0], b[0]))
    .slice(0, lim)
    .map(([docId, e]) => ({ docId, score: e.score, ranks: e.ranks }));
}

/** Convenience: sort scored hits [{ docId, score }] into a best-first ranked list of doc ids (higher score = better). */
export function toRanked(hits, { desc = true } = {}) {
  return [...(Array.isArray(hits) ? hits : [])]
    .map((h) => ({ id: idOf(h), s: Number(h?.score) }))
    .filter((h) => h.id !== null && Number.isFinite(h.s))
    .sort((a, b) => (desc ? b.s - a.s : a.s - b.s) || cmpId(a.id, b.id))
    .map((h) => h.id);
}

/** A doc id from a bare value or an object; null when there is none. */
function idOf(item) {
  if (item === null || item === undefined) return null;
  if (typeof item === 'string' || typeof item === 'number') return item;
  const v = item.docId ?? item.doc_id ?? item.id;
  return v === undefined ? null : v;
}

function cmpId(a, b) { return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0; }
