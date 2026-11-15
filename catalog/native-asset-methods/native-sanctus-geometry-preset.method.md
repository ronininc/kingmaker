# Review licensed procedural geometry

Status: **reference-only capability contract, not a native Kingmaker skill**. Native technique implementations belong in catalog/native-creation-skills; these provider/import workflows remain unimplemented references.

Source: [Sanctus Lite](https://sanctusnodes.com/documentation/main/en/) (checked 2026-11-15).
Licensing gate: Exact Lite availability/license not verified. Block until version and asset grant reviewed; do not assume CC0.

## Inputs and admission

Use job.json with an explicit request, local asset manifest, intended output, resource budget and target quality. Preserve exact source, author, license, modifications, dependencies, size and checksum per asset. No website inventory is copied. This definition covers a capability family, not every item offered by the provider.

## Adapter and acceptance

Required adapter: `sanctus-geometry`.
Acceptance target: Exact Lite entitlement, graph dependencies and evaluation budget checked.

Preparation support: adapter required; no preparation or execution claimed.

No automatic installation, login, download, external upload, purchase, credential access or execution of model-authored code. Independently verify source rights; a model-filled license field is insufficient. Use bounded disk/CPU/time and preserve attribution on derivatives. Require actual files and independently checked receipts before promotion. The primitive reel test is not evidence for this method.

```kingmaker-method
{
  "id": "native-sanctus-geometry-preset",
  "version": "0.1-draft",
  "title": "Review licensed procedural geometry",
  "domain": "media",
  "kind": "native-asset-capability",
  "nativeExecution": false,
  "inputs": {
    "jobFile": "job.json"
  },
  "steps": [
    {
      "id": "read-job",
      "type": "read-json",
      "path": "{{inputs.jobFile}}",
      "into": "job"
    },
    {
      "id": "asset-admission",
      "type": "declare",
      "action": "Validate local asset manifests and obtain required approvals",
      "reason": "Explicit manifest/license/hash admission must run through film-assets; reading JSON alone is not admission."
    },
    {
      "id": "native-operation",
      "type": "declare",
      "action": "Review licensed procedural geometry",
      "reason": "Requires reviewed sanctus-geometry adapter with actual artifacts. Method text does not execute this operation."
    },
    {
      "id": "quality-review",
      "type": "declare",
      "action": "Exact Lite entitlement, graph dependencies and evaluation budget checked",
      "reason": "Requires artifact-based validation; metadata or successful planning is not completion."
    }
  ]
}
```
