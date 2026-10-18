# Hybrid file search for Kingmaker's RAG (FTS5 + vectors, fused with RRF)

Design spec. The idea is lifted from `ghostapp-ai/ghost` (MIT): keyword search and semantic
search run side by side and their rankings are merged with **Reciprocal Rank Fusion (RRF)**,
which beats either one alone and needs no score calibration between them. This adapts it to
Kingmaker's stack (Swift bar + Node `lib/` + the engine's core), reusing what we already ship.

Status: **spec only** — nothing here is built yet. It is additive and ships behind a flag; with
no vector shard, retrieval is exactly today's FTS5-only behaviour.

---

## 1. What we already have

- **Keyword layer — done.** `lib/knowledge.mjs` builds **SQLite FTS5 `.db` shards**, one per
  "field", under the index dir the core reads (`solomon-index-knowledge.mjs`, run with
  `--experimental-sqlite`, paced and disk-floor-guarded). `servedFields()` lists the shards; the
  core resolves them on every query (`knowledge-index.ts`). FTS5 already gives us BM25 ranking.
- **Embedders — shipped, unused for text RAG.** `catalog/essentials.json` lists
  `nomic-embed-text-v2-moe` (default) and `bge-m3` (multilingual, 100+ languages). They run under
  the local Ollama (`/api/embed`). The only embeddings in `lib/` today are **speaker** voiceprints
  (`lib/owner-voice.mjs`), which are unrelated.
- **Ranking lives in the core.** The retrieval/ranking path is the engine's `knowledge-index.ts`
  (TypeScript), not `lib/`. So the fusion step is an **engine change**; Kingmaker-side (`lib/`) only
  has to build the vector shard beside the FTS5 shard and expose the embedder.

**Gap to close:** a per-field **vector shard** + a **fusion step** that merges BM25 and vector
rankings with RRF.

---

## 2. Architecture

```
query ──> embed(query)            (nomic-embed / bge-m3 via Ollama /api/embed)
      │
      ├─> FTS5 BM25   over <field>.db        -> ranked list A  (doc_id, rank)
      └─> vector kNN  over <field>.vec.db    -> ranked list B  (doc_id, rank)
                                   │
                              RRF fuse(A, B)  -> final ranked list
                                   │
                              top-k chunks -> ambient context for the turn
```

Two shards per field, same `doc_id` space so the lists fuse cleanly:
- `<field>.db` — the FTS5 shard (today).
- `<field>.vec.db` — **new**: a sibling holding one row per chunk: `doc_id`, the chunk's vector,
  and the embedder tag + dim. Prefer the **`sqlite-vec`** extension (`vec0` virtual table,
  `MATCH`/`distance` kNN); if it can't load, fall back to a flat `BLOB` of Float32 vectors scanned
  in the core (fields are small per shard; brute-force cosine is fine at this scale).

Keeping vectors in a **separate** `.vec.db` means the FTS5 shards are untouched, the feature is
removable, and an old build simply ignores the sibling.

---

## 3. Reciprocal Rank Fusion

RRF scores a document by its **rank** in each list, never its raw score — so BM25 and cosine
never have to be put on the same scale:

```
RRF(d) = Σ over lists L   1 / (k + rank_L(d))
```

- `rank_L(d)` is 1-based; a document missing from a list contributes 0 for that list.
- `k` damps the top ranks' dominance. Ghost and the original paper use **k = 60**; keep that
  as the default, make it tunable.
- Optional per-list weights (`w_keyword`, `w_vector`, default 1.0 each) multiply that list's term,
  so the owner can lean keyword or semantic per field without recalibration.

Pure reference implementation (this is the whole fusion — belongs in `lib/` as a tested helper,
and is mirrored in the core):

```js
// rankedLists: Array<Array<docId>>  (each already sorted best-first)
// weights:     Array<number> aligned to rankedLists (default 1)
export function rrfFuse(rankedLists, { k = 60, weights = null, limit = 20 } = {}) {
  const score = new Map();
  rankedLists.forEach((list, i) => {
    const w = weights?.[i] ?? 1;
    list.forEach((docId, idx) => {            // idx 0 -> rank 1
      score.set(docId, (score.get(docId) ?? 0) + w / (k + idx + 1));
    });
  });
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))  // stable tie-break
    .slice(0, limit)
    .map(([docId, s]) => ({ docId, score: s }));
}
```

Retrieve more than you fuse: take the **top ~50** from each list, fuse, then keep **top-k ≈ 20**
for context. Deterministic tie-break by `docId` so the same query always ranks the same.

---

## 4. Chunking & embedding

- **Chunk** at index time, in the extractor that already writes `extracted.jsonl`: ~512-token
  windows with ~15% overlap, split on headings/paragraphs first. `doc_id = <source>#<chunk>`,
  shared by both shards.
- **Embed** each chunk once, at index time, with the field's embedder; store the vector + the
  embedder tag. A query embeds once at query time with the **same** embedder (a shard records which
  one, so a model swap forces a rebuild rather than mixing spaces).
- **Multilingual:** default `nomic-embed-text-v2-moe`; when a field (or the query — see
  `lib/lang.mjs` `detectLanguage`) is non-English, use `bge-m3`. The embedder tag on the shard
  keeps query and shard on the same model.
- **Normalize** vectors to unit length at store time so cosine == dot product.

---

## 5. Where each piece lives

| Piece | Home | Notes |
|---|---|---|
| Build `<field>.vec.db` beside `<field>.db` | **engine** `solomon-index-knowledge.mjs` (+ `lib/knowledge.mjs` adds a vector stage to `KNOWLEDGE_STAGES`) | same pacing + disk-floor guard; `INDEX_BYTES_PER_EXTRACTED_BYTE` grows (dim × 4 bytes/chunk) |
| Embedder call (`/api/embed`) | `lib/` thin helper + core at query time | reuse the running Ollama; no new daemon |
| Vector kNN + **RRF fusion** | **engine** `knowledge-index.ts` | the query path; fuse BM25 + kNN there |
| `rrfFuse()` pure helper + unit test | `lib/` (e.g. `lib/rrf.mjs`) | mirrored in the core; one tested source of truth |
| Flag + fallback | `lib/knowledge.mjs` | no `.vec.db` -> FTS5-only, exactly today |

This spec's only hard cross-boundary dependency is the core's `knowledge-index.ts`. **Coordinate
the query-side change with the engine's session**; the Kingmaker-side index stage and the
`rrfFuse` helper can land here independently and first.

---

## 6. Resource discipline (non-negotiable, matches today)

- The vector stage runs under the same pacer (`lib/pacer.mjs`, AIMD duty cycle, nice 10) and the
  same disk floor (`diskFloorBytes`, 20 GB on an 8 GB Mac). Account the extra bytes
  (dim × 4 × chunks × 1.5) in `stageFits`/`pendingIndexBytes`.
- Crash-safe and resumable like the FTS5 build: write `<field>.vec.db` aside, rename whole.
- Query budget: embed-the-query + kNN must stay well under the turn's latency budget; cache the
  query vector for the turn. kNN over one field's shard is milliseconds at our scale.

---

## 7. Rollout

1. **Land `lib/rrf.mjs` + test** (pure, no deps) — safe anytime.
2. **Index stage** in `lib/knowledge.mjs` / the engine's indexer writes `<field>.vec.db` (behind a flag,
   off by default). Measure disk + time on an 8 GB and a 24 GB Mac.
3. **Query fusion** in `knowledge-index.ts` (engine session): BM25 + kNN -> `rrfFuse` -> top-k. Keep
   FTS5-only fallback.
4. **A/B**: same questions, FTS5-only vs hybrid, eyeball retrieval quality; tune `k` and weights.
5. Flip the flag on once it's a clear win.

## 8. Risks / honest limits

- **Index size and build time grow** (every chunk gets a float vector). The disk-floor guard
  already protects the Mac; worst case the vector stage just defers, as the FTS5 stage does.
- **Model-swap invalidates vectors.** The embedder tag forces a rebuild instead of silently mixing
  spaces — correct, but a rebuild is not free.
- **`sqlite-vec` availability.** If the extension won't load in the core's SQLite, the brute-force
  cosine fallback keeps it working (fine per-shard; revisit only if a field gets very large).
- **Benefit varies by corpus.** Hybrid helps most where wording differs from the query
  (synonyms, paraphrase); for exact-term lookups FTS5 alone was already good. RRF's floor is
  "no worse than the better single list," so it's low-risk.
