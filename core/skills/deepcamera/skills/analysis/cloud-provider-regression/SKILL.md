---
name: Cloud Provider Regression Test
description: Connectivity, chat, JSON & streaming regression tests for all enabled cloud LLM providers
version: 1.0.0
category: analysis
runtime: node
entry: scripts/run-regression.cjs
install: npm
requirements:
  node: ">=18"
  npm_install: false
  platforms: ["linux", "macos", "windows"]
---

# Cloud Provider Regression Test

Tests every enabled cloud provider for connectivity, chat completion, JSON output, and SSE streaming.
Reads keys from `~/.aegis-ai/llm-config.json`.

## Standalone

```bash
node scripts/run-regression.cjs                    # all providers
node scripts/run-regression.cjs --provider glm,xai # specific
node scripts/run-regression.cjs --verbose           # full responses
```

## Protocol

```jsonl
{"event":"ready","providers":8}
{"event":"test_result","suite":"GLM","test":"chat","status":"pass","timeMs":1930}
{"event":"complete","passed":14,"failed":1,"total":15,"timeMs":38000}
```

## Tests Per Provider

| Test | Verifies |
|------|----------|
| Chat | Connectivity, auth, URL construction, param compat |
| JSON | Structured output (JSON instruction following) |
| Stream | SSE streaming, chunks received |

Results saved to `~/.aegis-ai/regression-tests/`.
