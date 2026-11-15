# Original native USD authoring

Creates a new ASCII USD stage from native rotational geometry, normals,UVs,units and a basic UsdPreviewSurface material. No NVIDIA/Objaverse asset imported and no external framework dependency. Does not implement MaterialX,MDL,physics,SimReady certification or AAA visual quality. Uses linear RGB material factors.

Technical reference: https://openusd.org/release/spec_usdpreviewsurface.html

```kingmaker-method
{
  "id": "create-native-usd-lathe",
  "title": "Author original USD mesh and preview material",
  "version": "0.1",
  "domain": "media",
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
        "color": [
          0.18,
          0.22,
          0.28
        ],
        "roughness": 0.4,
        "metallic": 0
      },
      "metersPerUnit": 1
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
          "mesh"
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
          "metersPerUnit": {
            "type": "number",
            "minimum": 0.0001,
            "maximum": 1000
          },
          "material": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "color": {
                "type": "array",
                "minItems": 3,
                "maxItems": 3,
                "items": {
                  "type": "number",
                  "minimum": 0,
                  "maximum": 1
                }
              },
              "roughness": {
                "type": "number",
                "minimum": 0,
                "maximum": 1
              },
              "metallic": {
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
      "skill": "usd-lathe",
      "parameters": "{{inputs.parameters}}",
      "into": "assets"
    }
  ]
}
```
