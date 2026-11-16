# Selective tensor reads: staged data interface

`lib/selective-tensor-reader.mjs` reads named tensor ranges plus explicitly declared dependencies. The caller supplies an externally pinned, bounded manifest identifying source size/hash and each tensor's offset, size, dtype, shape and digest. The reader verifies only the requested payloads against that manifest; it does not rehash the whole checkpoint. A manifest must come from a trusted preparation/publishing process. Producing it initially requires source inspection and hashing.

Local file reads use positional reads. A separate GitHub-release adapter can consume the existing `fetchModelRange` interface, but remote reads are disabled unless explicitly enabled. No remote service was accessed for verification. Read budgets are bounded, and tensor data is not retained across requests by this interface.

Measured tiny-fixture test: source256bytes, requested tensor16bytes plus dependency8bytes, total24bytes read in3chunks. No unselected payload reads and no complete-checkpoint hash pass. Another synthetic provider test selected8bytes with one provider call. These are real selective I/O tests, not model inference or model quality tests.

`tensorProviderReadiness` always returns `inferenceReady:false`: Ollama cannot consume arbitrary isolated tensor ranges, and no generic compatible model executor is connected here. Existing Kronos code separately supports bounded local per-layer reads but currently requires a complete startup integrity scan; it has not been changed by this work.

## Remaining blockers
1. Real published per-tensor manifests with provenance and explicit dependencies are absent from current library entries.
2. OpenJEV/Billion Context live index/scorer bindings are absent.
3. The index currently selects model tags, not executable tensor dependency graphs.
4. A model-specific executor must establish which tensors are necessary and consume them in the correct architecture/order. Unrelated model fragments are not interchangeable.
5. Remote range transport and real inference must be jointly measured against a baseline before claiming end-to-end streaming.

No activation, deployment, model download or heavy inference was performed.
