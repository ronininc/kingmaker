# Source: graphify

- Upstream: https://github.com/Graphify-Labs/graphify @ 10130e7 (2026-10-14), Apache-2.0 (also LICENSE-MIT upstream).
- Taken 2026-10-15 for Kingmaker's clone skill: graphify/skill.md (the /graphify skill) and the Claude variant's
  references/, unchanged. Not a graphics tool: it turns a codebase (or docs, PDFs, media) into a queryable knowledge
  graph — clone's "understand" stage, before a rebuild.
- The full pipeline needs graphify installed (pip/pipx) and, for querying as an agent, its MCP server; both are
  owner-approved steps. The skill itself is prompt-and-reference and ships whole.
