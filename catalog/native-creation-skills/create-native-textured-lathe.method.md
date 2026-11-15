# Compose original textured rotational asset

Compose the native mesh and material skills into a GLB with embedded texture maps; no external file references.

Original Kingmaker implementation in lib/native-asset-skills.mjs. Executes built-in algorithms, not a plugin or external asset fetch. Requires the reviewed conductor native-asset-skill handler. Successful receipt means actual files were generated; it does not certify photorealistic quality or marketing readiness. Explicit high-fidelity targets fail rather than downgrade.

No model-authored Python, downloaded assets, network access, installations or license acceptance. Output rights are not reassigned. Procedural-proof quality only.

```kingmaker-method
{
  "id": "create-native-textured-lathe",
  "version": "0.1",
  "domain": "media",
  "title": "Compose original textured rotational asset",
  "kind": "native-creation",
  "inputs": {
    "parameters": {
      "mesh": {
        "profile": [
          [
            0.4,
            0
          ],
          [
            0.2,
            1
          ]
        ],
        "segments": 32
      },
      "material": {
        "style": "brushed-metal",
        "size": 128,
        "seed": 1
      }
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
          "mesh",
          "material"
        ],
        "additionalProperties": false,
        "properties": {
          "mesh": {
            "type": "object",
            "required": [
              "profile"
            ],
            "additionalProperties": false,
            "properties": {
              "profile": {
                "type": "array",
                "minItems": 2,
                "maxItems": 64,
                "description": "[radius,height] pairs; radius0.001..100; height-100..100 strictly increasing",
                "items": {
                  "type": "array",
                  "minItems": 2,
                  "maxItems": 2,
                  "items": {
                    "type": "number"
                  }
                }
              },
              "segments": {
                "type": "integer",
                "minimum": 3,
                "maximum": 128
              }
            }
          },
          "material": {
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
      }
    }
  },
  "steps": [
    {
      "id": "create",
      "type": "native-asset-skill",
      "skill": "textured-lathe",
      "parameters": "{{inputs.parameters}}",
      "into": "assets"
    }
  ]
}
```
