# Original surface condition

Bounded rectangular UV-patch edge/contact/exposure heuristic produces consistent color,roughness,height and wear-mask PNGs. Height decode is (sample-1)*heightLimitMeters. Not learned physical weathering or photorealistic certification. Geometry must explicitly consume height on a subdivided mesh.

```kingmaker-method
{
  "id": "create-native-surface-condition",
  "title": "Generate correlated bounded surface-condition maps",
  "version": "0.1",
  "domain": "media",
  "kind": "native-creation",
  "inputs": {
    "parameters": {
      "size": 128,
      "wear": 0.5,
      "dirt": 0.4,
      "exposure": 0.3
    }
  },
  "inputSchema": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "parameters"
    ],
    "properties": {
      "parameters": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
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
          "widthMeters": {
            "type": "number",
            "minimum": 0.02,
            "maximum": 5
          },
          "heightMeters": {
            "type": "number",
            "minimum": 0.02,
            "maximum": 5
          },
          "edgeWidthMeters": {
            "type": "number",
            "minimum": 0.001,
            "maximum": 0.1
          },
          "contactHeightMeters": {
            "type": "number",
            "minimum": 0.001,
            "maximum": 0.5
          },
          "wear": {
            "type": "number",
            "minimum": 0,
            "maximum": 1
          },
          "dirt": {
            "type": "number",
            "minimum": 0,
            "maximum": 1
          },
          "exposure": {
            "type": "number",
            "minimum": 0,
            "maximum": 1
          },
          "heightLimitMeters": {
            "type": "number",
            "minimum": 0,
            "maximum": 0.003
          },
          "baseColor": {
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
  },
  "steps": [
    {
      "id": "create",
      "type": "native-asset-skill",
      "skill": "surface-condition",
      "parameters": "{{inputs.parameters}}",
      "into": "assets"
    }
  ]
}
```
