# Depth Estimation — Privacy Transform

Transform camera feeds into **colorized depth maps** using [Depth Anything v2](https://github.com/DepthAnything/Depth-Anything-V2), providing real-time privacy protection for security monitoring.

In **privacy mode** (`depth_only`), the scene is fully anonymized — no faces, no clothing, no identifying features — while preserving spatial layout and activity patterns for security awareness.

![Privacy Transform Flow](https://img.shields.io/badge/category-privacy-blue)
![Depth Anything v2](https://img.shields.io/badge/model-Depth%20Anything%20v2-green)

## How It Works

```
Camera Frame → Depth Anything v2 → Colorized Depth Map → Aegis Overlay
   (BGR)         (monocular)         (warm=near, cool=far)    (0.5 FPS)
```

The depth model converts each frame into a distance map where **warm colors** (red/orange) indicate nearby objects and **cool colors** (blue/purple) indicate distant ones. This preserves enough spatial information to understand activity (someone approaching, car in driveway, etc.) without revealing identity.

## Hardware Support

Auto-detected via `HardwareEnv` from `skills/lib/env_config.py`:

| Platform | Backend | Notes |
|----------|---------|-------|
| **NVIDIA** | CUDA | FP16 on GPU |
| **AMD** | ROCm | PyTorch HIP |
| **Apple Silicon** | MPS | Unified memory, leaves Neural Engine free |
| **Intel** | OpenVINO | CPU + NPU support |
| **CPU** | PyTorch | Fallback, slower |

## Models

| Model | Size | Speed | Quality |
|-------|------|-------|---------|
| `depth-anything-v2-small` | 25MB | Fast | Good (default) |
| `depth-anything-v2-base` | 98MB | Medium | Better |
| `depth-anything-v2-large` | 335MB | Slow | Best |

Weights are downloaded from HuggingFace Hub on first run and cached locally.

## Display Modes

- **`depth_only`** (default) — Full anonymization. Only the depth map is shown.
- **`overlay`** — Depth map blended on top of the original feed (adjustable opacity).
- **`side_by_side`** — Original and depth map shown next to each other.

## Setup

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

## Integration with Aegis

This skill communicates with Aegis via **JSONL over stdin/stdout**. Aegis sends frame events, the skill returns transformed frames (base64 JPEG). See [SKILL.md](SKILL.md) for the full protocol specification and the `TransformSkillBase` interface for building new privacy skills.

## Creating New Privacy Skills

Subclass `TransformSkillBase` and implement two methods:

```python
from transform_base import TransformSkillBase

class MyPrivacySkill(TransformSkillBase):
    def load_model(self, config):
        self.model = load_my_model()
        return {"model": "my-model", "device": self.device}

    def transform_frame(self, image, metadata):
        return self.model.anonymize(image)

if __name__ == "__main__":
    MyPrivacySkill().run()
```

The base class handles JSONL protocol, performance tracking, hardware detection, rate limiting, and graceful shutdown.
