# Original native calibrated camera orbit

Produces pose/calibration JSON, not rendered images or a synthetic dataset. Independent pinhole mathematics; no external scripts or plugins.

```kingmaker-method
{
  "id": "create-native-camera-orbit",
  "title": "Generate calibrated camera orbit records",
  "version": "0.1",
  "domain": "media",
  "kind": "native-creation",
  "inputs": {
    "parameters": {
      "count": 8
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
        "additionalProperties": false,
        "properties": {
          "count": {
            "type": "integer",
            "minimum": 1,
            "maximum": 360
          },
          "width": {
            "type": "integer",
            "minimum": 16,
            "maximum": 8192
          },
          "height": {
            "type": "integer",
            "minimum": 16,
            "maximum": 8192
          },
          "radius": {
            "type": "number",
            "minimum": 0.01,
            "maximum": 10000
          },
          "elevation": {
            "type": "number",
            "minimum": -85,
            "maximum": 85
          },
          "fov": {
            "type": "number",
            "minimum": 5,
            "maximum": 150
          },
          "phase": {
            "type": "number",
            "minimum": -360,
            "maximum": 360
          },
          "target": {
            "type": "array",
            "minItems": 3,
            "maxItems": 3,
            "items": {
              "type": "number",
              "minimum": -10000,
              "maximum": 10000
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
      "skill": "camera-orbit",
      "parameters": "{{inputs.parameters}}",
      "into": "assets"
    }
  ]
}
```
