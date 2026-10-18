---
name: deepcamera
description: >-
  SharpAI DeepCamera skill suite: local-first camera intelligence (YOLO detection incl. Coral TPU/OpenVINO, SAM2
  segmentation, depth-estimation privacy transforms, go2rtc streaming, Eufy/Reolink/Tapo camera providers, dataset
  annotation, model training, home-security VLM benchmarks). Use for Ronin Atlas (formerly God's Eye) / Osiris camera and video work when a
  DeepCamera-style building block fits. This entry is a router: read the matching sub-skill file before acting.
---

# DeepCamera (router)

Upstream skills sit unmodified under `skills/`. Read the matching `SKILL.md` before acting. The upstream repo's
root header (a depth-estimation skill) is kept as `UPSTREAM_ROOT_SKILL.md`.

**Governance:** sub-skills under `skills/channels/` (LINE, Matrix, Signal) and `skills/automation/` (webhook, MQTT,
Home Assistant trigger) send messages or act on devices with no confirmation gate in their code. Never run them
without the operator's explicit go for that specific send/actuation. Install scripts use sudo; ask first.
Model weights and driver binaries were pruned, so detection/segmentation skills need their models provisioned.

| sub-skill | when |
|---|---|
| `skills/analysis/cloud-provider-regression/SKILL.md` | Connectivity, chat, JSON & streaming regression tests for all enabled cloud LLM providers |
| `skills/analysis/home-security-benchmark/SKILL.md` | LLM & VLM evaluation suite for home security AI applications |
| `skills/analysis/homesafe-bench/SKILL.md` | VLM indoor safety hazard detection benchmark inspired by HomeSafeBench (arXiv 2509.23690) |
| `skills/analysis/smarthome-bench/SKILL.md` | VLM evaluation suite for video anomaly detection in smart home camera footage |
| `skills/annotation/dataset-annotation/SKILL.md` | AI-assisted dataset annotation with COCO export — bbox, SAM2, DINOv3 methods |
| `skills/annotation/dataset-management/SKILL.md` | Dataset annotation management — COCO labels, sequences, export, and Kaggle upload |
| `skills/automation/ha-trigger/SKILL.md` | Fire Aegis detection events in Home Assistant |
| `skills/automation/mqtt/SKILL.md` | Publish Aegis events to MQTT broker |
| `skills/automation/webhook/SKILL.md` | POST Aegis events to webhook URLs |
| `skills/camera-providers/eufy/SKILL.md` | Eufy camera integration — local RTSP streaming and event clips |
| `skills/camera-providers/reolink/SKILL.md` | Reolink camera integration — RTSP and HTTP API |
| `skills/camera-providers/tapo/SKILL.md` | TP-Link Tapo camera integration — RTSP streaming and ONVIF |
| `skills/channels/line/SKILL.md` | LINE messaging channel for Clawdbot agent |
| `skills/channels/matrix/SKILL.md` | Matrix/Element messaging channel for Clawdbot agent |
| `skills/channels/signal/SKILL.md` | Signal messaging channel for Clawdbot agent |
| `skills/detection/yolo-detection-2026/SKILL.md` | YOLO 2026 — state-of-the-art real-time object detection |
| `skills/detection/yolo-detection-2026-coral-tpu-macos/SKILL.md` | Google Coral Edge TPU — real-time object detection natively (macOS / Linux) |
| `skills/detection/yolo-detection-2026-coral-tpu-win-wsl/SKILL.md` | Google Coral Edge TPU — real-time object detection natively via Windows WSL |
| `skills/detection/yolo-detection-2026-openvino/SKILL.md` | OpenVINO — real-time object detection via Docker (NCS2, Intel GPU, CPU) |
| `skills/integrations/homeassistant-bridge/SKILL.md` | Bidirectional Home Assistant integration — HA cameras in, detection results out |
| `skills/segmentation/sam2-segmentation/SKILL.md` | Interactive click-to-segment using Segment Anything 2 — AI-assisted labeling for Annotation Studio |
| `skills/streaming/go2rtc-cameras/SKILL.md` | Multi-camera RTSP to WebRTC streaming via go2rtc |
| `skills/training/model-training/SKILL.md` | Agent-driven YOLO fine-tuning — annotate, train, export, deploy |
| `skills/transformation/depth-estimation/SKILL.md` | Real-time depth map privacy transforms using Depth Anything v2 (CoreML + PyTorch) |

Provenance, license and flags: `VENDORED.md`.
