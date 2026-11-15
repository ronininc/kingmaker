# Synthesize original procedural PBR texture maps

Create five PNG maps locally from bounded seeded algorithms. Not scanned assets.

Original Kingmaker implementation in lib/native-asset-skills.mjs. Executes built-in algorithms, not a plugin or external asset fetch. Requires the reviewed conductor native-asset-skill handler. Successful receipt means actual files were generated; it does not certify photorealistic quality or marketing readiness. Explicit high-fidelity targets fail rather than downgrade.

No model-authored Python, downloaded assets, network access, installations or license acceptance. Output rights are not reassigned. Procedural-proof quality only.

```kingmaker-method
{
  "id": "create-native-pbr-synthesis",
  "version": "0.1",
  "domain": "media",
  "title": "Synthesize original procedural PBR texture maps",
  "kind": "native-creation",
  "inputs": {
    "parameters": {
      "style": "brushed-metal",
      "size": 128,
      "seed": 1
    }
  },
  "inputSchema": {
    "type": "object",
    "required": [
      "parameters"
    ],
    "additionalProperties": false,
    "properties": {
      "parameters": {
        "type": "object",
        "required": [
          "style"
        ],
        "additionalProperties": false,
        "properties": {
          "style": {
            "enum": [
              "stone",
              "brushed-metal",
              "checker"
            ]
          },
          "size": {
            "type": "integer",
            "minimum": 16,
            "maximum": 512
          },
          "seed": {
            "type": "integer",
            "minimum": 0,
            "maximum": 4294967295
          },
          "tiles": {
            "type": "integer",
            "minimum": 1,
            "maximum": 32
          },
          "colors": {
            "type": "array",
            "minItems": 2,
            "maxItems": 2,
            "items": {
              "type": "array",
              "minItems": 3,
              "maxItems": 3,
              "items": {
                "type": "number",
                "minimum": 0,
                "maximum": 1
              }
            }
          }
        }
      }
    }
  },
  "steps": [
    {
      "id": "create",
      "type": "native-asset-skill",
      "skill": "pbr-synthesis",
      "parameters": "{{inputs.parameters}}",
      "into": "assets"
    }
  ]
}
```
