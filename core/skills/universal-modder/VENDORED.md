# Vendored skill: universal-modder

- Upstream: https://github.com/rehan-remade/universal-modder @ `6c02e77` (6c02e77d9088ecb1a7d9970572d8ca5387e7cb9e, 2026-10-06)
- License: MIT (license file kept in this folder)
- Fetched and vetted: 2026-10-07, on the operator's ask to make it an engine skill and a Claude skill
- `skills/` is byte-for-byte upstream: 11 skills plus `mod-any-game/references/`. `UPSTREAM_AGENTS.md` is upstream's
  `AGENTS.md`, unedited.
- The top-level `SKILL.md` here is a Ronin-authored router; the upstream skills sit unmodified underneath it.
- Not copied: the `um` Python CLI (`um/`, `bin/`), `knowledge/`, `docs/`, `examples/`, `tests/`, the per-agent plugin
  manifests, the SessionStart PATH hook, and the fal MCP config. The router gives the pinned `um` install line.

## Flags

- Vetted: the plugin hook only puts `bin/um` on PATH; the only MCP server is fal (`https://mcp.fal.ai/mcp`, bearer
  `FAL_KEY`). Neither was installed here.
- The safety stance holds Kingmaker's line: single-player, offline or self-hosted only; anti-cheat, DRM and
  ownership checks are never bypassed; no cheats against other players (`skills/mod-any-game/references/safety.md`).
- `um win` drives Windows games only (Windows or WSL). On the operator's Macs the rest of `um` works.
- Kingmaker's governance applies on top: fal spend, driving his input, installing loaders, publishing a mod or a
  showcase, and `um kb pr` (a public upstream PR) stay behind the operator's explicit go.
