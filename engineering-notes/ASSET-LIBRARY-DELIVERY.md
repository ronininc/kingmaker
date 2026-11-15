# Asset library delivery candidate

`createAssetDelivery` separates remote byte delivery from renderer execution. It is an API, not an installed UI/voice integration or a populated asset library.

- Supply an immutable per-asset manifest with exact full bytes/SHA256, <=1 MiB chunks and their individual hashes, source, author, license URL, license label and modifications.
- Caller supplies explicitly approved HTTPS origins and a rights/admission callback. Approval must bind the canonical manifest digest and requested operation (`read-range` or `download`). The callback must enforce acquisition, device delivery and any redistribution restrictions for that specific asset, including dataset-specific licenses. Merely seeing a license label is not approval.
- No implicit authentication, redirects, scraping, uploads, remote execution, or asset downloads at construction. Credentialed delivery needs a separately reviewed scoped transport; never put secrets in manifests.
- `readChunk` uses exact HTTP ranges, rejects ignored ranges, changed totals, content encodings and invalid chunk hashes. Responses are bounded and time out after 30 seconds. Verified partial bytes explicitly remain non-renderable.
- `download({outputRoot,maxBytes})` requires an explicit byte budget and 256 MiB free reserve, writes an exclusive temporary directory, hashes all bytes, then finalizes the payload and records attribution metadata. Failed transfers clean up only their own directory. No resume/cache eviction policy is implemented.
- A renderer must independently validate format and dependencies and re-admit complete assets immediately before import. Current generated GLB/USDA assets are not incrementally rendered from arbitrary chunks. Large devices may retain full assets; smaller devices still require either enough space for the renderer's working set or a separate remote-render service. Neither phone execution nor remote rendering is implemented here.

Tests use tiny synthetic bytes, not downloaded assets. Existing GGUF transport likewise retrieves chunks but materializes the full model before Ollama can use it. Existing Launcher tether fetch remains a stub. No petabyte storage allocation, host quota increase, universal licensing or production rendering follows from this module.
