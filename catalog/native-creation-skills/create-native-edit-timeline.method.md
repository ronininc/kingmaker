# Original native edit timeline

Creates bounded frame-exact clip/gap edit decisions in Kingmaker JSON. Does not access media, render video or claim OTIO interoperability. Clip items require assetId and sourceTotalFrames; source frame rate must match timeline rate.

```kingmaker-method
{
  "id": "create-native-edit-timeline",
  "title": "Construct frame-exact edit decisions",
  "version": "0.1",
  "domain": "media",
  "kind": "native-creation",
  "inputs": {
    "parameters": {
      "rateNumerator": 24,
      "rateDenominator": 1,
      "items": [
        {
          "type": "gap",
          "durationFrames": 24
        }
      ]
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
          "items"
        ],
        "additionalProperties": false,
        "properties": {
          "rateNumerator": {
            "type": "integer",
            "minimum": 1,
            "maximum": 120000
          },
          "rateDenominator": {
            "type": "integer",
            "minimum": 1,
            "maximum": 1001
          },
          "items": {
            "type": "array",
            "minItems": 1,
            "maxItems": 256,
            "items": {
              "type": "object",
              "required": [
                "type",
                "durationFrames"
              ],
              "additionalProperties": false,
              "properties": {
                "type": {
                  "enum": [
                    "clip",
                    "gap"
                  ]
                },
                "durationFrames": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 1000000
                },
                "assetId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                },
                "sourceStartFrame": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 1000000
                },
                "sourceTotalFrames": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 2000000
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
      "skill": "edit-timeline",
      "parameters": "{{inputs.parameters}}",
      "into": "assets"
    }
  ]
}
```
