# Source: CLI-Anything

- Upstream: https://github.com/HKUDS/CLI-Anything @ `34f5195` (2026-09-22), Apache-2.0 (LICENSE in this folder).
- Taken 2026-10-15 for Kingmaker's core pack, laid out the way the skill's own resource map expects: `SKILL.md` from
  `codex-skill/`; `references/HARNESS.md`, `references/commands/`, `references/guides/` from `cli-anything-plugin/`;
  `references/docs/PREVIEW_PROTOCOL.md` from `docs/`; `scripts/*.py` and `scripts/templates/` from `cli-anything-plugin/`.
  Files are unchanged, except SKILL.md: Kingmaker's frontmatter and its "In Kingmaker" section were added on
  2026-10-16, when CLI-Anything became a core skill of its own (it is also referenced from `clone`). Not taken: installers, tests, demos, media.
- With every resource here, the skill works offline: its "clone or download" fallback is never needed.
- Kingmaker also ships Ronin's copy of CLI-Anything's hub (vendor/kingmaker-cli-hub, MIT) to install ready-made CLIs.
