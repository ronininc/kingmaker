---
name: universal-modder
description: Mod a PC game the operator owns, from the idea to working in the real game and recorded — new items, weapons, enemies, bosses, units, mechanics, art, sound and cross-game mashups. Routes to the universal-modder skills - game recon, reverse engineering (ILSpy, Cpp2IL, Ghidra), fal-generated sprites, textures, 3D, SFX and music, the asset pipeline into engine-exact frames, driving the game to test, showcase videos, publishing to Nexus/Workshop/Thunderstore, and the shared modding knowledge base. Use when the operator wants to mod, extend, reverse engineer, port into or mash up a game, asks "can this game be modded", or wants a mod packaged or shown off. Single-player, offline or self-hosted only; never anti-cheat, DRM or cheats against other players.
---

# universal-modder (router)

Vendored from [rehan-remade/universal-modder](https://github.com/rehan-remade/universal-modder) (MIT, see
`VENDORED.md`). This file is Ronin-authored; every `skills/*/SKILL.md` under it is byte-for-byte upstream. Read the
one that fits before working, and follow it.

## Which skill

| The operator wants | Read |
|---|---|
| To mod a game, start to finish (the loop below) | `skills/mod-any-game/SKILL.md` |
| "Can <game> be modded?" — engine, version, anti-cheat, loaders, saves, route | `skills/game-recon/SKILL.md` |
| To know how the game works so a mod can hook it (decompile, file formats, live memory) | `skills/reverse-engineering/SKILL.md` |
| Art, 3D, SFX, music or voice for the mod | `skills/fal-assets/SKILL.md` |
| Generated or hand-made art turned into what the engine loads (frames, sheets, palettes, masks) | `skills/asset-pipeline/SKILL.md` |
| The mod tested in the real game (launch, screenshot, click, type) | `skills/game-automation/SKILL.md` |
| Two games at once, a port, or a total conversion | `skills/mashup-mods/SKILL.md` |
| Prior art for a game or technique on the open web | `skills/game-research-websearch/SKILL.md` |
| What other agents learned modding this game, or a field note written | `skills/share-field-notes/SKILL.md` |
| A short showcase video of the mod | `skills/showcase-video/SKILL.md` |
| The mod packaged and released | `skills/publish-mod/SKILL.md` |

Engine playbooks (Unity, Unreal, Godot, Source, Bethesda, Minecraft, .NET/XNA, native, retro decomps, AoE2 and
more) are in `skills/mod-any-game/references/engines/`. The safety rules are in
`skills/mod-any-game/references/safety.md`; read them before touching a game. Upstream's own agent guide is kept as
`UPSTREAM_AGENTS.md`.

## The loop

intake → recon → route → lab (backups first) → source of truth → vertical slice → assets → verify in the real game →
showcase → publish. Keep a `MODLOG.md` in the mod's working folder; it becomes the field note at the end.

## The `um` CLI and fal

The skills call `um` (upstream's Python CLI: `scan`, `fal`, `comfy`, `sprite`, `render3d`, `win`, `video`, `backup`,
`publish`, `kb`). It is not vendored here. Install it at the commit these skills were vetted against:

```bash
uv tool install git+https://github.com/rehan-remade/universal-modder@6c02e77d9088ecb1a7d9970572d8ca5387e7cb9e
```

- `um win` (launch, screenshot, input, record) drives Windows games, from Windows or WSL. On macOS the other groups
  work; say so plainly when a step needs a Windows host.
- fal needs `FAL_KEY` (the fal MCP server at `https://mcp.fal.ai/mcp`, or `um fal` over REST). For images without
  a key, `um comfy` uses a local ComfyUI server.

## Kingmaker's governance on top

The upstream rules stand, and these stay behind the operator's explicit go:
- **Spend:** fal generations cost money. Say what will be generated and roughly what it costs before a batch.
- **His machine:** driving his mouse and keyboard, installing loaders or proxy DLLs into a game folder, and changing
  the registry. Back up saves first (`um backup create`).
- **Publishing:** releasing a mod, posting a showcase, and `um kb pr` (it opens a public pull request upstream).
- **The bright line, never:** online clients protected by anti-cheat, cheats against other players, bypassing
  anti-cheat, DRM or ownership checks, and shipping game files, extracted assets or decompiled code.
