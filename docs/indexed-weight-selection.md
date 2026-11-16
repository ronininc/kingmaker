# Indexed weight selection (staged, opt-in)

This connects the CLI hunter to the existing Billion Context MCP adapter and a local OpenJEV SystemOne-compatible scorer. It retrieves **model metadata**, not tensors. It does not make incompatible weight fragments executable or claim zero inference compute.

Activation requires all of:
- `KINGMAKER_WEIGHT_INDEX=on` and the existing hunter enabled.
- `BILI_MCP_PROXY` and `BILI_CONVERSATION_ID` bound to the intended governed index.
- An installed `bili` executable; no installer or model download is invoked.
- `KINGMAKER_OPENJEV_ENDPOINT` on loopback HTTP and `KINGMAKER_OPENJEV_MODEL` naming OpenJEV.
- `KINGMAKER_OPENJEV_REVISION`, the configured checkpoint SHA-256. This binds receipts to operator configuration; it is not remote attestation of the service.

The endpoint implements the existing `/v1/systemone` contract, returning `answers.weight_model.probabilities` over exact tag choices. It must actually serve the configured OpenJEV model. The generic Ollama text-based shim is not evidence of that service.

`search_context` must return relevant block IDs. Each decompressed block contains bounded inline JSON:

```json
{"schema":"kingmaker.weight-index/1","candidates":[{"tag":"model:tag","sha256":"64-hex-weight-sha256"}]}
```

Only role-eligible descriptors matching current catalog weight hashes survive. Up to8blocks of64KiB each and16candidates are allowed. Spilled files are refused so index content cannot nominate arbitrary files to read. Index contents never confer instruction authority. No-match, malformed data, digest mismatch, unavailable service or confidence below0.6 fails closed. There is no silent benchmark fallback when this mode is active. Normal no-download materialization policy still applies after selection.

Selection receipts bind exact task hash, shortlisted catalog metadata, decompressed evidence digests and configured scorer identity. Repeated requests revalidate the current index receipts and catalog before reusing the choice without a second scoring call. Corruption or configuration changes invalidate reuse. This is integrity-checked selection reuse, not security certification, trained-weight reuse, persistent authority or model admission. Metadata bytes and zero tensor bytes are recorded separately.

Status: production wiring and fixture tests exist. No live OpenJEV+Billion Context end-to-end success has been demonstrated on this Mac; absent services fail closed. Do not enable this staged path for users until the real index, scorer and provenance are verified.
