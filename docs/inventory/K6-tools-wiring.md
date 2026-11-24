# K6 — Tools wiring inventory

Claude seat, 2026-11-24. Branch `kingmaker-joint` (cut from `main` at b44cea4). Read from the code and by running the real skill loader in a cloud Linux container; nothing was run on the Mac.

## Headline

**Nothing in `catalog/tools/index.json` and nothing in `core/skills` is registered with the brain's tool-calling layer. 0 WIRED out of 13 platform entries. 0 WIRED out of 106 skills.**

The rule applied (from the brief): a tool is WIRED only when it is registered with the tool-calling layer with a name, a purpose and a parameter schema. Booting standalone does not count.

What the tool-calling layer is in this tree: the frozen `TOOLS` list in `lib/mcp.mjs`, which is the whole answer to `tools/list` (`lib/mcp.mjs:377`, `reply({ tools: TOOLS })`). It holds 26 tools, listed at the bottom. None of them is a library tool or a core skill.

**Limit of this inventory.** The governed local brain has its own tool manifest inside the engine (`solomon/server/src/runtime/brain-tools.ts`, named in `light-runtime/ask.mjs`). The engine's source is not in this repository, so that manifest was not read. The verdicts below cover every registration this repository makes. If the engine registers any of these on its own, that is not visible from here and the backend seat should say so.

## Part 1 — `catalog/tools/index.json`: 4 tools, 13 platform entries

Why none is wired, in code terms:

1. A library tool gets a tool-call descriptor (name, description, inputSchema) only from `toolDescriptor()` in `lib/brain-library-fetch.mjs:319`, and only after it has been pulled and materialized on a node.
2. Nothing reads that descriptor. `toolDescriptor` has no caller outside its own file, and `tools/list` returns the frozen list only.
3. The MCP-hub registration inside `materializeTool` runs only when the caller passes `addConnector`. Both production callers leave it out: `lib/bench-cli.mjs:233` (`createToolStreamingProvider({ stateDir })`) and the method conductor's default provider (`lib/tool-streaming.mjs:107`).
4. So a pulled tool is run by the method conductor as a binary in a method step. That is execution by path, not a registration the brain can call.

| # | Tool | Platform | Payload | State | Reason |
|---|---|---|---|---|---|
| 1 | blender 4.5 | linux-x64 | declared-not-staged | **NOT WIRED** | Payload is declared, not staged: no hashes, no parts, every pull path refuses it. It cannot reach a node, so it cannot be registered. |
| 2 | blender 4.5 | macos-arm64 | declared-not-staged | **NOT WIRED** | Payload is declared, not staged: no hashes, no parts, every pull path refuses it. It cannot reach a node, so it cannot be registered. |
| 3 | blender 4.5 | windows-x64 | declared-not-staged | **NOT WIRED** | Payload is declared, not staged: no hashes, no parts, every pull path refuses it. It cannot reach a node, so it cannot be registered. |
| 4 | kali-bench 1.0.0 | linux-arm64 | staged | **NOT WIRED** | Payload is staged, so it can be pulled, but a pulled tool is not registered: the descriptor is built and never surfaced, and no production caller passes `addConnector`. Also: the catalog note says the release on ronininc/weights was still a draft awaiting publication. |
| 5 | langcheck 1.0.0 | linux-arm64 | declared-not-staged | **NOT WIRED** | Payload is declared, not staged: no hashes, no parts, every pull path refuses it. It cannot reach a node, so it cannot be registered. |
| 6 | langcheck 1.0.0 | linux-x64 | declared-not-staged | **NOT WIRED** | Payload is declared, not staged: no hashes, no parts, every pull path refuses it. It cannot reach a node, so it cannot be registered. |
| 7 | langcheck 1.0.0 | macos-arm64 | declared-not-staged | **NOT WIRED** | Payload is declared, not staged: no hashes, no parts, every pull path refuses it. It cannot reach a node, so it cannot be registered. |
| 8 | opencode 1.19.5 | linux-arm64 | staged | **NOT WIRED** | Payload is staged, so it can be pulled, but a pulled tool is not registered: the descriptor is built and never surfaced, and no production caller passes `addConnector`. Also: the catalog note says the payloads are staged locally and not yet uploaded to ronininc/weights. |
| 9 | opencode 1.19.5 | linux-x64 | staged | **NOT WIRED** | Payload is staged, so it can be pulled, but a pulled tool is not registered: the descriptor is built and never surfaced, and no production caller passes `addConnector`. Also: the catalog note says the payloads are staged locally and not yet uploaded to ronininc/weights. |
| 10 | opencode 1.19.5 | macos-arm64 | staged | **NOT WIRED** | Payload is staged, so it can be pulled, but a pulled tool is not registered: the descriptor is built and never surfaced, and no production caller passes `addConnector`. Also: the catalog note says the payloads are staged locally and not yet uploaded to ronininc/weights. |
| 11 | opencode 1.19.5 | macos-x64 | declared-not-staged | **NOT WIRED** | Payload is declared, not staged: no hashes, no parts, every pull path refuses it. It cannot reach a node, so it cannot be registered. |
| 12 | opencode 1.19.5 | windows-arm64 | declared-not-staged | **NOT WIRED** | Payload is declared, not staged: no hashes, no parts, every pull path refuses it. It cannot reach a node, so it cannot be registered. |
| 13 | opencode 1.19.5 | windows-x64 | staged | **NOT WIRED** | Payload is staged, so it can be pulled, but a pulled tool is not registered: the descriptor is built and never surfaced, and no production caller passes `addConnector`. Also: the catalog note says the payloads are staged locally and not yet uploaded to ronininc/weights. |

Count check: 13 platform entries, 5 staged, 8 declared-not-staged. blender and langcheck have no staged platform.

## Part 2 — `core/skills`: 1561 tracked files

1560 files sit in 106 skill folders; 1 loose file (`core/skills/.gitkeep`). 1560 + 1 = 1561.

What the loader does (`lib/core-pack.mjs`, `builtInSkills`): every top-level folder with a `SKILL.md` becomes a skill connector with a name and a description, REA reads it, and it is marked callable or disabled with a reason. I ran that loader: **106 listed, 106 callable, 0 disabled.**

Why every one is still NOT WIRED under the rule: a skill connector has a name and a purpose but **no parameter schema**, and it is not in `tools/list`. A skill is used by reading its `SKILL.md` into a turn as the system prompt (`lib/connectors.mjs:304`), picked by `/name` or by word match. The brain cannot call it as a tool. Reason code **S** in the table.

Extra reasons, where they apply:

- **D** — no purpose registered either: the loader reads an empty description from this skill's frontmatter (a multi-line YAML value the parser in `skillMeta` does not handle).
- **N** — the folder holds nested `SKILL.md` files below the top level. The loader only looks one level down, so those sub-skills are not even listed. The number is how many.

| # | Skill | Licence | REA | Files | Listed + callable | State | Reason |
|---|---|---|---|---|---|---|---|
| 1 | aaa-modeling | MIT | clean | 4 | yes | **NOT WIRED** | S |
| 2 | agent-self-scheduling | MIT | clean | 4 | yes | **NOT WIRED** | S |
| 3 | ai-search-ranking | Ronin | clean | 3 | yes | **NOT WIRED** | S |
| 4 | algo-trading | Apache-2.0 | clean | 5 | yes | **NOT WIRED** | S |
| 5 | algorithmic-art | Apache-2.0 | clean | 5 | yes | **NOT WIRED** | S |
| 6 | app-remake-belt | Ronin | clean | 6 | yes | **NOT WIRED** | S |
| 7 | axis-projection | Ronin | clean | 3 | yes | **NOT WIRED** | S |
| 8 | big-box-store | Ronin | clean | 10 | yes | **NOT WIRED** | S |
| 9 | blender-3d-asset-generation | MIT | clean | 11 | yes | **NOT WIRED** | S |
| 10 | business-name-fit | MIT | clean | 5 | yes | **NOT WIRED** | S |
| 11 | business-profile-recon | Ronin | clean | 4 | yes | **NOT WIRED** | S |
| 12 | claude-code-skillforge | MIT | sandboxed | 16 | yes | **NOT WIRED** | S, N=2 |
| 13 | cli-anything | Apache-2.0 | clean | 22 | yes | **NOT WIRED** | S |
| 14 | cli-anything-blender | Apache-2.0 | clean | 4 | yes | **NOT WIRED** | S |
| 15 | cli-anything-comfyui | Apache-2.0 | clean | 4 | yes | **NOT WIRED** | S |
| 16 | cli-anything-freecad | Apache-2.0 | clean | 4 | yes | **NOT WIRED** | S |
| 17 | cli-anything-godot | Apache-2.0 | clean | 4 | yes | **NOT WIRED** | S |
| 18 | cli-anything-hermes | Apache-2.0 | clean | 7 | yes | **NOT WIRED** | S |
| 19 | cli-hub-meta-skill | Apache-2.0 | clean | 4 | yes | **NOT WIRED** | S |
| 20 | clone | MIT | clean | 46 | yes | **NOT WIRED** | S, N=3 |
| 21 | cloudflare-ordering-worker | Ronin | clean | 9 | yes | **NOT WIRED** | S |
| 22 | clover-operations-command | Ronin | clean | 16 | yes | **NOT WIRED** | S |
| 23 | codex-handoff | Ronin | clean | 5 | yes | **NOT WIRED** | S |
| 24 | coding-gen | Ronin | clean | 5 | yes | **NOT WIRED** | S |
| 25 | comfyui | MIT | clean | 28 | yes | **NOT WIRED** | S |
| 26 | contract-and-proposal-writer | MIT | clean | 3 | yes | **NOT WIRED** | S |
| 27 | copy-editing | MIT | clean | 6 | yes | **NOT WIRED** | S |
| 28 | copywriting | MIT | clean | 6 | yes | **NOT WIRED** | S |
| 29 | create-skill-gen | Ronin | clean | 5 | yes | **NOT WIRED** | S |
| 30 | custom-tool-builder | Ronin | clean | 5 | yes | **NOT WIRED** | S |
| 31 | customer-research | MIT | clean | 5 | yes | **NOT WIRED** | S |
| 32 | dagster-expert | Apache-2.0 | clean | 177 | yes | **NOT WIRED** | S, D |
| 33 | data-visualization | Apache-2.0 | clean | 4 | yes | **NOT WIRED** | S |
| 34 | debugging-and-error-recovery | MIT | clean | 4 | yes | **NOT WIRED** | S |
| 35 | deep-research | MIT | clean | 10 | yes | **NOT WIRED** | S |
| 36 | deepcamera | MIT | sandboxed | 189 | yes | **NOT WIRED** | S, N=24 |
| 37 | docker-build-strategies | Apache-2.0 | sandboxed | 14 | yes | **NOT WIRED** | S |
| 38 | docker-compose-patterns | Apache-2.0 | clean | 13 | yes | **NOT WIRED** | S |
| 39 | docker-destructive-guardrails | Apache-2.0 | clean | 9 | yes | **NOT WIRED** | S |
| 40 | docker-project-foundations | Apache-2.0 | sandboxed | 12 | yes | **NOT WIRED** | S |
| 41 | emails | MIT | clean | 6 | yes | **NOT WIRED** | S |
| 42 | fastmcp | MIT | clean | 9 | yes | **NOT WIRED** | S |
| 43 | ffmpeg-skill | MIT | sandboxed | 88 | yes | **NOT WIRED** | S |
| 44 | founder-metric-reel | Ronin | clean | 3 | yes | **NOT WIRED** | S |
| 45 | gcode | MIT | clean | 6 | yes | **NOT WIRED** | S |
| 46 | get-available-resources | MIT | clean | 12 | yes | **NOT WIRED** | S |
| 47 | gh-fix-ci | Apache-2.0 | clean | 7 | yes | **NOT WIRED** | S |
| 48 | godot-prompter | MIT | sandboxed | 133 | yes | **NOT WIRED** | S, N=23 |
| 49 | graphite | Apache-2.0 | clean | 3 | yes | **NOT WIRED** | S |
| 50 | gsap-core | MIT | clean | 4 | yes | **NOT WIRED** | S |
| 51 | gsap-scrolltrigger | MIT | clean | 4 | yes | **NOT WIRED** | S |
| 52 | gsap-timeline | MIT | clean | 4 | yes | **NOT WIRED** | S |
| 53 | humanizer | MIT | clean | 3 | yes | **NOT WIRED** | S |
| 54 | immersive-evidence-workspace | Ronin | clean | 7 | yes | **NOT WIRED** | S |
| 55 | internal-comms | Apache-2.0 | clean | 3 | yes | **NOT WIRED** | S |
| 56 | kingmaker-cloudflare-release | Ronin | clean | 3 | yes | **NOT WIRED** | S |
| 57 | kingmaker-doc-author | Ronin | clean | 3 | yes | **NOT WIRED** | S |
| 58 | kingmaker-engine-verifier | Ronin | clean | 5 | yes | **NOT WIRED** | S |
| 59 | kingmaker-flagship-driver | Ronin | clean | 5 | yes | **NOT WIRED** | S |
| 60 | kingmaker-native-internet | Ronin | clean | 3 | yes | **NOT WIRED** | S |
| 61 | kingmaker-proof-authoring | Ronin | clean | 3 | yes | **NOT WIRED** | S |
| 62 | kingmaker-proof-runner | Ronin | clean | 4 | yes | **NOT WIRED** | S |
| 63 | kingmaker-readme-sync | Ronin | clean | 3 | yes | **NOT WIRED** | S |
| 64 | kingmaker-repo-hygiene | Ronin | clean | 3 | yes | **NOT WIRED** | S |
| 65 | kingmaker-voice-runtime | Ronin | clean | 8 | yes | **NOT WIRED** | S |
| 66 | kingmaker-voice-verification | Ronin | clean | 3 | yes | **NOT WIRED** | S |
| 67 | lead-magnets | MIT | clean | 8 | yes | **NOT WIRED** | S |
| 68 | local-seo-manager | MIT | clean | 6 | yes | **NOT WIRED** | S |
| 69 | marketing-ideas | MIT | clean | 5 | yes | **NOT WIRED** | S |
| 70 | mcp-server-builder | Apache-2.0 | clean | 14 | yes | **NOT WIRED** | S |
| 71 | movie-gen | Ronin | clean | 5 | yes | **NOT WIRED** | S |
| 72 | native-capability-extraction | Ronin | clean | 3 | yes | **NOT WIRED** | S |
| 73 | observability-and-instrumentation | MIT | clean | 4 | yes | **NOT WIRED** | S |
| 74 | offers | MIT | clean | 11 | yes | **NOT WIRED** | S |
| 75 | office | Ronin | clean | 2 | yes | **NOT WIRED** | S |
| 76 | open-harness | Ronin | clean | 3 | yes | **NOT WIRED** | S |
| 77 | paper-search-pro | Apache-2.0 | sandboxed | 223 | yes | **NOT WIRED** | S |
| 78 | parametric-cad-verify | Apache-2.0 | clean | 4 | yes | **NOT WIRED** | S |
| 79 | penetration-testing | Ronin | clean | 5 | yes | **NOT WIRED** | S |
| 80 | playwright-cli | Apache-2.0 | clean | 14 | yes | **NOT WIRED** | S |
| 81 | pricing | MIT | clean | 7 | yes | **NOT WIRED** | S |
| 82 | rea | Ronin | clean | 3 | yes | **NOT WIRED** | S |
| 83 | referrals | MIT | clean | 10 | yes | **NOT WIRED** | S |
| 84 | research | MIT | clean | 10 | yes | **NOT WIRED** | S |
| 85 | scheduler | MIT | sandboxed | 10 | yes | **NOT WIRED** | S |
| 86 | security-and-hardening | MIT | clean | 5 | yes | **NOT WIRED** | S |
| 87 | security-audit | MIT | clean | 22 | yes | **NOT WIRED** | S |
| 88 | service-business-website | Ronin | clean | 10 | yes | **NOT WIRED** | S |
| 89 | site-media-fetch | Ronin | clean | 4 | yes | **NOT WIRED** | S |
| 90 | skill-creator | Apache-2.0 | clean | 19 | yes | **NOT WIRED** | S |
| 91 | skill-kokoro-tts-tool | MIT | clean | 4 | yes | **NOT WIRED** | S |
| 92 | skill-matchmaker | Ronin | clean | 3 | yes | **NOT WIRED** | S |
| 93 | social | MIT | clean | 12 | yes | **NOT WIRED** | S |
| 94 | social-media-gen | Ronin | clean | 5 | yes | **NOT WIRED** | S |
| 95 | spanish-regional-localization | Ronin | clean | 4 | yes | **NOT WIRED** | S |
| 96 | theme-factory | Apache-2.0 | clean | 3 | yes | **NOT WIRED** | S |
| 97 | trading-agents | Ronin | clean | 3 | yes | **NOT WIRED** | S |
| 98 | universal-modder | MIT | clean | 30 | yes | **NOT WIRED** | S, N=11 |
| 99 | verify-claims | MIT | clean | 5 | yes | **NOT WIRED** | S |
| 100 | voice-operations-command | Ronin | clean | 3 | yes | **NOT WIRED** | S |
| 101 | wake-word-detection | Unlicense | clean | 6 | yes | **NOT WIRED** | S |
| 102 | web-artifacts-builder | Apache-2.0 | clean | 6 | yes | **NOT WIRED** | S |
| 103 | webapp-testing | Apache-2.0 | clean | 8 | yes | **NOT WIRED** | S |
| 104 | website-build-standard | Ronin | clean | 6 | yes | **NOT WIRED** | S |
| 105 | wholesale-real-estate | Ronin | clean | 20 | yes | **NOT WIRED** | S |
| 106 | workflows | MIT | clean | 4 | yes | **NOT WIRED** | S |

Count check: 106 skills, 1560 files. Nested sub-skills never listed by the loader: 63, in claude-code-skillforge (2), clone (3), deepcamera (24), godot-prompter (23), universal-modder (11).

Every one of the 1561 file paths, with its skill and state, is in `docs/inventory/K6-tools-wiring.json`.

## What IS registered (for contrast): the 26 tools in `lib/mcp.mjs`

`kingmaker_turn`, `kingmaker_build`, `kingmaker_research`, `kingmaker_merchant_dryrun`, `kingmaker_fabricate`, `kingmaker_twins`, `kingmaker_pending`, `kingmaker_cancel`, `kingmaker_status`, `device_capabilities`, `artcraft_status`, `artcraft_request`, `see-phone-screen`, `tap-phone`, `type-on-phone`, `press-phone-button`, `swipe-phone`, `open-phone-app`, `call-from-phone`, `send-imessage-to-contact`, `phone-bridge-status`, `ingest-browser-capture`, `ingest-site-crawl`, `ingest-youtube-transcript`, `ingest-voice-transcribe`, `voice-synthesize`

## Found on the way (backend seat's files, not touched)

- `lib/k-office.mjs` (`kingmaker_office`) and `light-runtime/ask.mjs` (`kingmaker_light_ask`) each say in their own comments that they are "registered with the MCP tool-calling layer in lib/mcp.mjs in the same pass". `lib/mcp.mjs` does not import either one, on `main` or on `candidate/kingmaker-4.5.2`. By the same rule they are defined, not wired.
- `candidate/kingmaker-4.5.2` adds one skill not on `main`: `dsh-superagent-github`. It is not in this inventory because this branch is cut from `main`.
- `core/pack.json` also describes four non-skill stacks (art, office, website, engineering). They were outside this task's scope and are not inventoried here.

## How to reproduce

```bash
node -e "import('./lib/core-pack.mjs').then(m=>{const s=m.builtInSkills(null,{log(){}});console.log(s.length,s.filter(x=>x.callable).length)})"
```

```bash
node -e "import('./lib/mcp.mjs').then(m=>console.log(m.TOOLS.length,m.TOOLS.map(t=>t.name).join(' ')))"
```

```bash
grep -rn "toolDescriptor\|createToolStreamingProvider(" lib bin light-runtime surface --include=*.mjs
```
