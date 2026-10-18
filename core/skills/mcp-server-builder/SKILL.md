---
name: mcp-server-builder
description: "Design and ship production-ready MCP (Model Context Protocol) servers from OpenAPI contracts instead of hand-written tool wrappers. Python and TypeScript support, schema validation, safe evolution. Use when exposing an existing API as an MCP server, building tool integrations for Claude or Codex or Cursor, scaffolding an MCP project from scratch, building an MCP server, turning an API into MCP, generating MCP from OpenAPI, or exposing an API to an LLM. Do NOT use for implementing the business logic of an existing MCP server."
description_zh: "基于 OpenAPI 契约设计与交付生产级 MCP 服务器，支持 Python/TypeScript、模式校验与安全演进，把现有 API 暴露给 LLM。"
license: Apache-2.0
compatibility: Pure prompt-based; may read project structure via Bash. Requires Python 3.8+ (stdlib only) to run bundled scripts.
metadata:
  version: "1.0"
  author: awesome-skillkit
  category: ai-engineering
  verified-date: "2026-09-09"
---

# MCP Server Builder

Design and deliver production-ready MCP servers from API contracts, replacing hand-written throwaway tool wrappers. Focused on fast scaffolding, schema quality, validation, and safe evolution. The workflow supports both Python and TypeScript MCP implementations, treating OpenAPI as the single source of truth.

## Input Checklist

| Input | Required | Description |
|------|------|------|
| OpenAPI spec | Yes | `--input openapi.json` (or passed via stdin); must be a valid OpenAPI document |
| Server name | Yes | `--server-name`, e.g. `billing-mcp`; determines the generated directory and tool prefix |
| Language | No | `--language python\|typescript`, default python |
| Output directory | No | `--output-dir`, default `./out` |
| Runtime config | No | Optional runtime-config path for mcp_validator to validate |

When something is missing, ask for it all at once:
"Please provide: (1) OpenAPI spec path (or paste the content via stdin); (2) server name `--server-name`; (3) language python/typescript; (4) output directory (default `./out`). I'll use defaults for everything else; once confirmed, I'll start."

## Pre-flight Checks

- Python 3.8+ is available: `python3 --version` → prints a version number ≥3.8. Otherwise prompt to install, then **STOP**.
- The two scripts are on disk: `test -f scripts/openapi_to_mcp.py && test -f scripts/mcp_validator.py` → both exist; if either is missing → **STOP** and report the filename.
- The OpenAPI spec is readable: `test -r <input>` or stdin has content. Otherwise report the error and ask the user to provide it.

## Workflow

### Step 1: Generate the MCP scaffold from OpenAPI

```bash
python3 scripts/openapi_to_mcp.py --input examples/mini-openapi.json --server-name billing-mcp --language python --output-dir out --format text   # bundled sample spec; swap in your real spec with --input openapi.json
```

stdin is also supported (shown here as a comment to avoid clashing with the runnable example above):
`cat openapi.json | python3 scripts/openapi_to_mcp.py --server-name billing-mcp --language typescript --output-dir out`

Action: read the OpenAPI, convert paths/operations into MCP tool definitions, and generate the manifest + starter server code.
Expected: generate the server scaffold and `tool_manifest.json` under `--output-dir`; exit code `0`; `--format text` prints a report.
On failure: invalid OpenAPI → the script reports a schema error; fix the spec first; an `--server-name` conflict → choose a different name or delete the old directory.

### Step 2: Validate the MCP tool definitions

```bash
python3 scripts/mcp_validator.py --input examples/sample-tool-manifest.json --strict --format text   # bundled sample manifest; your generated artifact is at out/tool_manifest.json
```

Action: validate the manifest before integration testing, checking for duplicate names, invalid schema shapes, missing descriptions, empty required fields, and naming hygiene.
Expected: print a validation report; exit code `0` when there are no errors.
On failure: errors under `--strict` → non-zero exit code; fix the manifest per the report and rerun.

### Step 3: Choose a runtime

- **Python**: preferred for fast iteration and data-intensive backends.
- **TypeScript**: unifies the JS stack and keeps front/back contracts tighter.
- Even as the transport/runtime changes, keep the tool contract stable.

### Step 4: Production hardening

Key items before release:
- Keep secrets in environment variables, never in the tool schema
- Prefer an egress host allowlist over an open proxy
- Make only incremental changes; never rename a tool in place

See references/production-hardening-guide.md for the full hardening guidance.

## Script Interfaces

- `python3 scripts/openapi_to_mcp.py --help`
  - Reads OpenAPI from stdin or `--input`
  - Produces a manifest + server scaffold
  - Outputs a JSON summary or a text report
- `python3 scripts/mcp_validator.py --help`
  - Validates the manifest and an optional runtime config
  - Returns a non-zero exit code when errors exist in strict mode

## Parameter Cheat Sheet

| Script | Parameter | Values | Description |
|------|------|------|------|
| openapi_to_mcp.py | `--input` | path | OpenAPI spec file |
| | `--server-name` | string | Server name; determines directory/prefix |
| | `--language` | `python\|typescript` | Target language |
| | `--output-dir` | path | Output directory, default `./out` |
| | `--format` | `text\|json` | Output format |
| mcp_validator.py | `--input` | path | Path to `tool_manifest.json` |
| | `--strict` | flag | Strict mode; errors cause a non-zero exit |
| | `--format` | `text\|json` | Output format |

## Failure Handling Table

| Symptom / error | Cause | Action |
|-----------|------|------|
| `python3: command not found` | Python not installed | Install 3.8+ and rerun |
| Script `FileNotFoundError` | Script missing | STOP and report the missing filename |
| OpenAPI schema error | Invalid spec | Fix the OpenAPI, then regenerate |
| mcp_validator non-zero exit | Manifest has errors | Fix duplicates/missing descriptions/empty required per the report |
| Duplicate tool name | Multiple paths share a name | Disambiguate or rename in the spec |

## Delivery Criteria

Definition of success: a runnable scaffold generated from OpenAPI, `mcp_validator.py --strict` exit code `0`, unique tool names, complete descriptions, and no empty required fields.
Artifact naming/location: the server code under `--output-dir` and `tool_manifest.json`.
Completeness verification: rerunning `mcp_validator.py --input out/tool_manifest.json --strict` returns exit code `0`.

## References

- references/production-hardening-guide.md — read before hardening/release: auth & security design, versioning strategy, common pitfalls, testing and deployment
- references/openapi-extraction-guide.md — read when extracting OpenAPI from source
- references/python-server-template.md — starter template to read when choosing Python
- references/typescript-server-template.md — starter template to read when choosing TypeScript
- references/validation-checklist.md — item-by-item checklist before release
- README.md — overview of this skill and installation instructions
