---
name: HomeSafe-Bench
description: VLM indoor safety hazard detection benchmark inspired by HomeSafeBench (arXiv 2509.23690)
version: 1.0.0
category: analysis
runtime: node
entry: scripts/run-benchmark.cjs
install: npm

requirements:
  node: ">=18"
  npm_install: true
  platforms: ["linux", "macos", "windows"]
---

# HomeSafe-Bench — Indoor Safety Hazard Detection

VLM benchmark evaluating indoor home safety hazard detection from static camera frames. Inspired by [HomeSafeBench (arXiv 2509.23690)](https://arxiv.org/abs/2509.23690), adapted for **fixed indoor security cameras** with AI-generated fixture images.

**40 tests** across **5 hazard categories**:

| Category | Tests | Example Hazards |
|----------|-------|-----------------|
| 🔥 Fire / Smoke | 8 | Stove smoke, candle near curtain, iron left face-down |
| ⚡ Electrical | 8 | Overloaded power strip, exposed wire, frayed cord |
| 🚶 Trip / Fall | 8 | Toys on staircase, wet floor, loose rug edge |
| 👶 Child Safety | 8 | Open cabinet with chemicals, uncovered outlet, blind cord |
| 📦 Falling Objects | 8 | Heavy items on high shelf, leaning bookshelf, loose ceiling fan |

## Setup

**Requires `npm install`.** This skill has a `package.json` with dependencies (e.g. `openai` SDK). The deployment agent should check for `package.json` and run `npm install` in the skill directory before launching.

Entry script: `scripts/run-benchmark.cjs`

### Verification

```bash
node scripts/run-benchmark.cjs --help
```

## Quick Start

### As an Aegis Skill (automatic)

When spawned by Aegis, all configuration is injected via environment variables. The benchmark discovers your VLM server automatically, generates an HTML report, and opens it when complete.

### Standalone

```bash
# Run all 40 tests
node scripts/run-benchmark.cjs --vlm http://localhost:5405

# Quick mode (2 tests per category = 10 total)
node scripts/run-benchmark.cjs --vlm http://localhost:5405 --mode quick

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

> **Note**: URLs should be base URLs (e.g. `http://localhost:5405`). The benchmark appends `/v1/chat/completions` automatically.

### User Configuration (config.yaml)

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `mode` | select | `full` | Which mode: `full` (40 tests) or `quick` (10 tests — 2 per category) |
| `noOpen` | boolean | `false` | Skip auto-opening the HTML report in browser |

### CLI Arguments (standalone fallback)

| Argument | Default | Description |
|----------|---------|-------------|
| `--vlm URL` | *(required)* | VLM server base URL |
| `--mode MODE` | `full` | Test mode: `full` or `quick` |
| `--out DIR` | `~/.aegis-ai/homesafe-benchmarks` | Results directory |
| `--no-open` | — | Don't auto-open report in browser |

## Protocol

### Aegis → Skill (env vars)
```
AEGIS_VLM_URL=http://localhost:5405
AEGIS_SKILL_ID=homesafe-bench
AEGIS_SKILL_PARAMS={}
```

### Skill → Aegis (stdout, JSON lines)
```jsonl
{"event": "ready", "vlm": "SmolVLM-500M", "system": "Apple M3"}
{"event": "suite_start", "suite": "🔥 Fire / Smoke"}
{"event": "test_result", "suite": "...", "test": "...", "status": "pass", "timeMs": 4500}
{"event": "suite_end", "suite": "...", "passed": 7, "failed": 1}
{"event": "complete", "passed": 36, "total": 40, "timeMs": 180000, "reportPath": "/path/to/report.html"}
```

Human-readable output goes to **stderr** (visible in Aegis console tab).

## Citation

This benchmark is inspired by:

> **HomeSafeBench: Towards Measuring the Proficiency of Home Safety for Embodied AI Agents**
> arXiv:2509.23690
>
> Unlike the academic benchmark (embodied agent + navigation in simulated 3D environments), our version uses **static indoor camera frames** — matching real-world indoor security camera deployment (fixed wall/ceiling mount). All fixture images are **AI-generated** consistent with DeepCamera's privacy-first approach.

## Requirements

- Node.js ≥ 18
- `npm install` (for `openai` SDK dependency)
- Running VLM server (llama-server with vision model, or OpenAI-compatible VLM endpoint)
