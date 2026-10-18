---
name: model-training
description: "Agent-driven YOLO fine-tuning — annotate, train, export, deploy"
version: 1.0.0

parameters:
  - name: base_model
    label: "Base Model"
    type: select
    options: ["yolo26n", "yolo26s", "yolo26m", "yolo26l"]
    default: "yolo26n"
    description: "Pre-trained model to fine-tune"
    group: Training

  - name: dataset_dir
    label: "Dataset Directory"
    type: string
    default: "~/datasets"
    description: "Path to COCO-format dataset (from dataset-annotation skill)"
    group: Training

  - name: epochs
    label: "Training Epochs"
    type: number
    default: 50
    group: Training

  - name: batch_size
    label: "Batch Size"
    type: number
    default: 16
    description: "Adjust based on GPU VRAM"
    group: Training

  - name: auto_export
    label: "Auto-Export to Optimal Format"
    type: boolean
    default: true
    description: "Automatically convert to TensorRT/CoreML/OpenVINO after training"
    group: Deployment

  - name: deploy_as_skill
    label: "Deploy as Detection Skill"
    type: boolean
    default: false
    description: "Replace the active YOLO detection model with the fine-tuned version"
    group: Deployment

capabilities:
  training:
    script: scripts/train.py
    description: "Fine-tune YOLO models on custom annotated datasets"
---

# Model Training

Agent-driven custom model training powered by Aegis's Training Agent. Closes the annotation-to-deployment loop: take a COCO dataset from `dataset-annotation`, fine-tune a YOLO model, auto-export to the optimal format for your hardware, and optionally deploy it as your active detection skill.

## What You Get

- **Fine-tune YOLO26** — start from nano/small/medium/large pre-trained weights
- **COCO dataset input** — uses standard format from `dataset-annotation` skill
- **Hardware-aware training** — auto-detects CUDA, MPS, ROCm, or CPU
- **Auto-export** — converts trained model to TensorRT / CoreML / OpenVINO / ONNX via `env_config.py`
- **One-click deploy** — replace the active detection model with your fine-tuned version
- **Training telemetry** — real-time loss, mAP, and epoch progress streamed to Aegis UI

## Training Loop (Aegis Training Agent)

```
dataset-annotation          model-training              yolo-detection-2026
┌─────────────┐        ┌──────────────────┐        ┌──────────────────┐
│ Annotate    │───────▶│ Fine-tune YOLO   │───────▶│ Deploy custom    │
│ Review      │  COCO  │ Auto-export      │ .pt    │ model as active  │
│ Export      │  JSON  │ Validate mAP     │ .engine│ detection skill  │
└─────────────┘        └──────────────────┘        └──────────────────┘
       ▲                                                    │
       └────────────────────────────────────────────────────┘
                    Feedback loop: better detection → better annotation
```

## Protocol

### Aegis → Skill (stdin)
```jsonl
{"event": "train", "dataset_path": "~/datasets/front_door_people/", "base_model": "yolo26n", "epochs": 50, "batch_size": 16}
{"event": "export", "model_path": "runs/train/best.pt", "formats": ["coreml", "tensorrt"]}
{"event": "validate", "model_path": "runs/train/best.pt", "dataset_path": "~/datasets/front_door_people/"}
```

### Skill → Aegis (stdout)
```jsonl
{"event": "ready", "gpu": "mps", "base_models": ["yolo26n", "yolo26s", "yolo26m", "yolo26l"]}
{"event": "progress", "epoch": 12, "total_epochs": 50, "loss": 0.043, "mAP50": 0.87, "mAP50_95": 0.72}
{"event": "training_complete", "model_path": "runs/train/best.pt", "metrics": {"mAP50": 0.91, "mAP50_95": 0.78, "params": "2.6M"}}
{"event": "export_complete", "format": "coreml", "path": "runs/train/best.mlpackage", "speedup": "2.1x vs PyTorch"}
{"event": "validation", "mAP50": 0.91, "per_class": [{"class": "person", "ap": 0.95}, {"class": "car", "ap": 0.88}]}
```

## Setup

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```
