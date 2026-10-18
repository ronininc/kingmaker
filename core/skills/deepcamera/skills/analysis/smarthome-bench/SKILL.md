---
name: SmartHome Video Anomaly Benchmark
description: VLM evaluation suite for video anomaly detection in smart home camera footage
version: 1.0.0
category: analysis
runtime: node
entry: scripts/run-benchmark.cjs
install: npm

requirements:
  node: ">=18"
  npm_install: true
  system_deps: [yt-dlp, ffmpeg]
  platforms: ["linux", "macos", "windows"]
---

# SmartHome Video Anomaly Benchmark

Benchmark suite evaluating VLM models on **video anomaly detection** across **7 smart home categories** — based on the [SmartHome-Bench](https://github.com/Xinyi-0724/SmartHome-Bench-LLM) dataset (1,203 YouTube smart home camera clips).

> **Key differentiator from HomeSec-Bench**: This benchmark requires **video understanding** (multi-frame sampling), not single-frame analysis.

## Setup

**Requires `npm install` + system dependencies.** The deployment agent should:
1. Check for `yt-dlp` and `ffmpeg` in PATH
2. Run `npm install` in the skill directory

Entry script: `scripts/run-benchmark.cjs`

### Verification

```bash
node scripts/run-benchmark.cjs --help
```

## Quick Start

### As an Aegis Skill (automatic)

When spawned by Aegis, configuration is injected via environment variables. The benchmark downloads video clips, samples frames, evaluates with VLM, and generates an HTML report.

### Standalone

```bash
# Run with local VLM (subset mode, 50 videos)
node scripts/run-benchmark.cjs --vlm http://localhost:5405

# Quick test with 10 videos
node scripts/run-benchmark.cjs --vlm http://localhost:5405 --max-videos 10

# Full benchmark (all curated clips)
node scripts/run-benchmark.cjs --vlm http://localhost:5405 --mode full

# Filter by category
node scripts/run-benchmark.cjs --vlm http://localhost:5405 --categories "Wildlife,Security"

# Skip download (re-evaluate cached videos)
node scripts/run-benchmark.cjs --vlm http://localhost:5405 --skip-download

# Skip report auto-open
node scripts/run-benchmark.cjs --vlm http://localhost:5405 --no-open
```

## Configuration

### Environment Variables (set by Aegis)

| Variable | Default | Description |
|----------|---------|-------------|
| `AEGIS_VLM_URL` | *(required)* | VLM server base URL |
| `AEGIS_VLM_MODEL` | — | Loaded VLM model ID |
| `AEGIS_SKILL_ID` | — | Skill identifier (enables skill mode) |
| `AEGIS_SKILL_PARAMS` | `{}` | JSON params from skill config |

> **Note**: This is a VLM-only benchmark. An LLM gateway is not required.

### User Configuration (config.yaml)

This skill includes a [`config.yaml`](config.yaml) that defines user-configurable parameters. Aegis parses this at install time and renders a config panel in the UI. Values are delivered via `AEGIS_SKILL_PARAMS`.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `mode` | select | `subset` | Which clips to evaluate: `subset` (~50 clips) or `full` (all ~105 curated clips) |
| `maxVideos` | number | `50` | Maximum number of videos to evaluate |
| `categories` | text | `all` | Comma-separated category filter (e.g. `Wildlife,Security`) |
| `noOpen` | boolean | `false` | Skip auto-opening the HTML report in browser |

### CLI Arguments (standalone fallback)

| Argument | Default | Description |
|----------|---------|-------------|
| `--vlm URL` | *(required)* | VLM server base URL |
| `--out DIR` | `~/.aegis-ai/smarthome-bench` | Results directory |
| `--max-videos N` | `50` | Max videos to evaluate |
| `--mode MODE` | `subset` | `subset` or `full` |
| `--categories LIST` | `all` | Comma-separated category filter |
| `--skip-download` | — | Skip video download, use cached |
| `--no-open` | — | Don't auto-open report in browser |
| `--report` | *(auto in skill mode)* | Force report generation |

## Protocol

### Aegis → Skill (env vars)
```
AEGIS_VLM_URL=http://localhost:5405
AEGIS_SKILL_ID=smarthome-bench
AEGIS_SKILL_PARAMS={}
```

### Skill → Aegis (stdout, JSON lines)
```jsonl
{"event": "ready", "model": "SmolVLM2-2.2B", "system": "Apple M3"}
{"event": "suite_start", "suite": "Wildlife"}
{"event": "test_result", "suite": "Wildlife", "test": "smartbench_0003", "status": "pass", "timeMs": 4500}
{"event": "suite_end", "suite": "Wildlife", "passed": 12, "failed": 3}
{"event": "complete", "passed": 78, "total": 105, "timeMs": 480000, "reportPath": "/path/to/report.html"}
```

Human-readable output goes to **stderr** (visible in Aegis console tab).

## Test Suites (7 Categories)

| Suite | Description | Anomaly Examples |
|-------|-------------|------------------|
| 🦊 Wildlife | Wild animals near home cameras | Bear on porch, deer in garden, coyote at night |
| 👴 Senior Care | Elderly activity monitoring | Falls, wandering, unusual inactivity |
| 👶 Baby Monitoring | Infant/child safety | Stroller rolling, child climbing, unsupervised |
| 🐾 Pet Monitoring | Pet behavior detection | Pet illness, escaped pets, unusual behavior |
| 🔒 Home Security | Intrusion & suspicious activity | Break-ins, trespassing, porch pirates |
| 📦 Package Delivery | Package arrival & theft | Stolen packages, misdelivered, weather damage |
| 🏠 General Activity | General smart home events | Unusual hours activity, appliance issues |

Each clip is evaluated for **binary anomaly detection**: the VLM predicts normal (0) or abnormal (1), compared against expert annotations.

## Metrics

Per-category and overall:
- **Accuracy** — correct predictions / total
- **Precision** — true positives / predicted positives
- **Recall** — true positives / actual positives
- **F1-Score** — harmonic mean of precision & recall
- **Confusion Matrix** — TP, FP, TN, FN breakdown

## Results

Results are saved to `~/.aegis-ai/smarthome-bench/` as JSON. An HTML report with per-category breakdown, confusion matrix, and model comparison is auto-generated.

## Requirements

- Node.js ≥ 18
- `npm install` (for `openai` SDK dependency)
- `yt-dlp` (video download from YouTube)
- `ffmpeg` (frame extraction from video clips)
- Running VLM server (must support multi-image input)

## Citation

Based on [SmartHome-Bench: A Comprehensive Benchmark for Video Anomaly Detection in Smart Homes Using Multi-Modal Foundation Models](https://arxiv.org/abs/2506.12992).
