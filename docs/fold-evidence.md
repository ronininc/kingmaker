# Fold evidence — the reflex layer's Evidence supply

`lib/fold-evidence.mjs` wires the fold index into the Jev processing lineup at the
Evidence stage of the governed chain (Intent → Evidence → Governance → Decision →
Authorization → Audit), per `jev-bili-seat-2026-11-13/ARCHITECTURE.md`: ingest lanes
fold raw material into tiered blocks over a byte-exact store; the reflex layer's
decisions are scored over those folds, and a verdict that stands rests on the blocks'
byte-exact originals — never on their summaries.

## The seam

`createReflexLayer` gains an optional `evidence` port (duck-typed, like `router` and
`audit`):

- Before `router.decide(...)`, `evidence.gather(payload)` returns the active fold
  surface (Tier 3 first). When the decision state is an object, the surface is
  attached as `state.evidence.foldIndex` — the caller's own state rides alongside,
  untouched. Non-object states are left alone (the skip is logged).
- Routed and escalated verdicts carry the surface in their context
  (`ctx.evidenceSurface`) — advisory context for the reasoning path, which can pull
  its own receipts through the same registered tools.
- An auto-proceed verdict **stands** on the evidence, so every surfaced block's
  receipt is pulled first (`decompress`, full): the result carries
  `evidence.receipts` with the byte-exact original texts; the audit entry records
  the block ids, tiers, and each receipt's **SHA-256 fingerprint and size only** —
  receipt text is state-like content and is never written to the audit log.
- Fail-open throughout, the layer's own doctrine: a supply failure writes
  `reflex.evidence-unavailable` to the audit and the decision proceeds on the
  caller's state. No port wired = the layer behaves exactly as before.

## The engine binding

The engine (billion-context 0.1.213) is **called, never embedded**, through its own
MCP surface. `createBiliMcpTransport` spawns `bili mcp` (stdio JSON-RPC) with:

- `BILI_MCP_PROXY` — a running proxy from the **governed** install (auto-update off,
  advisory force-install off, feeds pinned dead, retention deliberate; the synthesis
  preset in `jev-bili-seat-2026-11-13/billion-context.synthesis.json`).
- `BILI_CONVERSATION_ID` — the one conversation the shim may read. An unbound shim
  refuses to guess a conversation and errors by name; that refusal is the artifact
  working as designed, and the wiring honors it by always binding explicitly.

Large restores spill to a file by design ("Content (N chars) written to: …");
`receipt()` resolves the spill through the injected read and fingerprints the text.

## Tool registration

`FOLD_EVIDENCE_TOOLS` in `lib/fold-evidence.mjs` is the registration for the brain's
tool-calling layer — name, purpose, parameter schema — for the two Kingmaker-side
tools (`fold_evidence_surface`, `fold_evidence_receipt`) over the engine's MCP tools
(`acp_status`, `decompress`, `search_context`). The streamed-tools catalog
(`catalog/tools/index.json`, schema `kingmaker.tools/1`) is deliberately **not**
used: it distributes archive payloads (zip / docker-image-tar with size+SHA-256
pins), and this engine is a separately governed runtime install, not a streamed
archive. Registering it there would require a false payload pin.

## Proof

- Gate 1 (engine lane, live): a 59-chunk real corpus folded through the governed
  proxy to Tier 3; 13/13 planted identifiers restored byte-exact via this same MCP
  decompress path; 56/56 folded chunks hash-identical to the store's originals
  (`jev-bili-wiring-2026-11-13/BUILD-REPORT.md`).
- This seam: `tests/fold-evidence.test.mjs` — parsers against the engine's real
  captured output, the port over a scripted transport, and the layer contract
  (attach, receipts, fingerprints, fail-open, no-port equivalence).
