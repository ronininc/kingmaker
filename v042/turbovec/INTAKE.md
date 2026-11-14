# turbovec — Cage intake

Source reel: DZQnQSkBxnE (@agentsbywassim, 2026-06-06) — claims checked against the
upstream repo 2026-10-21; the reel understates the speed claim.

## What it is
An in-process vector index (Rust core, Python bindings) implementing Google
Research's TurboQuant (arXiv 2504.19874). Stores embeddings at 2 or 4 bits per
dimension and searches the compressed form directly with SIMD kernels. No
training step — the codebook derives from the math, not the data — so ingest is
online: add a vector and it is searchable immediately. Persistence is
incremental (`sync()` writes only the delta, crash-safe).

## Claims, verified against the upstream README (author's own benchmarks)
- 10M x 768-dim embeddings: 31 GB as float32 -> 4 GB in the index.
- Compression at equal recall vs FAISS: 7.8x at 4-bit, 15.5x at 2-bit.
- Search speed: 4.4x FAISS FastScan at 4-bit, 2.2x at 2-bit (ARM and x86).
- IdMapIndex: caller-owned uint64 ids, O(1) remove, and ALLOWLIST-filtered
  search (only ids another system approved are returned) — a natural fit for
  governed retrieval: the permission layer decides the allowlist, the index
  enforces it inside the kernel.

## Why it is a candidate here
Retrieval is the read side of the doing-more-with-less doctrine. The knowledge
library and the skill library are embedding-search problems; on the 8 GB class
the difference between a float32 index and a 2-bit one is whether the corpus
lives in memory or streams off disk. A compressed resident index makes the
read side cheap in exactly the way the doctrine wants.

## Governance / safety notes
- MIT (verified at the repo root) — clean for Kingmaker AND Solomon.
- Library, not a service: no egress, no telemetry surface of its own; the
  integration that embeds it owns any network behaviour.
- Pin discipline: version 1.1.2, git c3b043b992290ff223b903046af7f6683768241c;
  verify full wheel sha256 against PyPI metadata at install time.
- Nothing here touches the standing exclusions (no tracking, no credential
  material, no pretexting) — it indexes what the caller already lawfully holds.

## The gate before it earns a seat (Robbie's performance rule)
Author benchmarks are claims, not receipts. Bench on the 8 GB M3 profile:
1. Build a representative corpus (skill-library + knowledge-library embeddings).
2. Measure recall@k vs the incumbent approach at 2-bit and 4-bit.
3. Measure resident GB and query latency on the 8 GB profile, cold and warm.
4. It ships only if it beats the incumbent on memory AND holds recall; the
   numbers go in bench/ in the brain-library format.
Mac-side run, same sitting as the other owed benches.
