# Generate original rotational mesh geometry

Construct positions,normals,UVs,indices and binary glTF from a supplied profile. Not human anatomy or rig generation.

Original Kingmaker implementation in lib/native-asset-skills.mjs. Executes built-in algorithms, not a plugin or external asset fetch. Requires the reviewed conductor native-asset-skill handler. Successful receipt means actual files were generated; it does not certify photorealistic quality or marketing readiness. Explicit high-fidelity targets fail rather than downgrade.

No model-authored Python, downloaded assets, network access, installations or license acceptance. Output rights are not reassigned. Procedural-proof quality only.

```kingmaker-method
{
  "id": "create-native-lathe-mesh",
  "version": "0.1",
  "domain": "media",
  "title": "Generate original rotational mesh geometry",
  "kind": "native-creation",
  "inputs": {
    "parameters": {
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
      }
    }
  },
  "steps": [
    {
      "id": "create",
      "type": "native-asset-skill",
      "skill": "lathe-mesh",
      "parameters": "{{inputs.parameters}}",
      "into": "assets"
    }
  ]
}
```
