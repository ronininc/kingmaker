# Prepare ambientCG PBR materials

Status: **reference-only capability contract, not a native Kingmaker skill**. Native technique implementations belong in catalog/native-creation-skills; these provider/import workflows remain unimplemented references.

Source: [ambientCG](https://docs.ambientcg.com/license/) (checked 2026-11-15).
Licensing gate: Assets CC0; retain asset record.

## Inputs and admission

Use job.json with an explicit request, local asset manifest, intended output, resource budget and target quality. Preserve exact source, author, license, modifications, dependencies, size and checksum per asset. No website inventory is copied. This definition covers a capability family, not every item offered by the provider.

## Adapter and acceptance

Required adapter: `pbr-material`.
Acceptance target: UV scale and normal orientation checked on actual material.

Preparation support: available through prepareNativeAssetMethod, but does not execute native tooling.

No automatic installation, login, download, external upload, purchase, credential access or execution of model-authored code. Independently verify source rights; a model-filled license field is insufficient. Use bounded disk/CPU/time and preserve attribution on derivatives. Require actual files and independently checked receipts before promotion. The primitive reel test is not evidence for this method.

```kingmaker-method
{
  "id": "native-ambientcg-pbr-material",
  "version": "0.1-draft",
  "title": "Prepare ambientCG PBR materials",
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
      "action": "Prepare ambientCG PBR materials",
      "reason": "Requires reviewed pbr-material adapter with actual artifacts. Method text does not execute this operation."
    },
    {
      "id": "quality-review",
      "type": "declare",
      "action": "UV scale and normal orientation checked on actual material",
      "reason": "Requires artifact-based validation; metadata or successful planning is not completion."
    }
  ]
}
```
