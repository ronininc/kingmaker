# Import an approved CC0 scan

Status: **reference-only capability contract, not a native Kingmaker skill**. Native technique implementations belong in catalog/native-creation-skills; these provider/import workflows remain unimplemented references.

Source: [Smithsonian 3D](https://3d.si.edu/collections/openaccesshighlights) (checked 2026-11-15).
Licensing gate: Only items explicitly marked CC0 admitted automatically; other rights may remain.

## Inputs and admission

Use job.json with an explicit request, local asset manifest, intended output, resource budget and target quality. Preserve exact source, author, license, modifications, dependencies, size and checksum per asset. No website inventory is copied. This definition covers a capability family, not every item offered by the provider.

## Adapter and acceptance

Required adapter: `scan-import`.
Acceptance target: Scale, scan density and texture dependencies inspected.

Preparation support: adapter required; no preparation or execution claimed.

No automatic installation, login, download, external upload, purchase, credential access or execution of model-authored code. Independently verify source rights; a model-filled license field is insufficient. Use bounded disk/CPU/time and preserve attribution on derivatives. Require actual files and independently checked receipts before promotion. The primitive reel test is not evidence for this method.

```kingmaker-method
{
  "id": "native-smithsonian-scan-import",
  "version": "0.1-draft",
  "title": "Import an approved CC0 scan",
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
      "action": "Import an approved CC0 scan",
      "reason": "Requires reviewed scan-import adapter with actual artifacts. Method text does not execute this operation."
    },
    {
      "id": "quality-review",
      "type": "declare",
      "action": "Scale, scan density and texture dependencies inspected",
      "reason": "Requires artifact-based validation; metadata or successful planning is not completion."
    }
  ]
}
```
