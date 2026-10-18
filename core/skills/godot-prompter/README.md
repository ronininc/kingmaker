# GodotPrompter

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Godot 4.x](https://img.shields.io/badge/Godot-4.3+-blue.svg)](https://godotengine.org)
[![Skills: 23](https://img.shields.io/badge/Skills-23-green.svg)](#available-skills)

Agentic skills framework for Godot 4.x game development. Gives AI coding agents domain-specific expertise for GDScript and C# projects.

Inspired by and built on top of the [Superpowers](https://github.com/obra/superpowers) plugin for Claude Code — which provides the underlying skill loading, brainstorming, and workflow infrastructure that GodotPrompter extends with Godot-specific domain knowledge.

## What is this?

GodotPrompter is a plugin that provides **skills** — structured domain knowledge that AI agents load on demand. When you ask your agent to "add a state machine" or "set up an event bus", it loads the relevant GodotPrompter skill and follows Godot-specific best practices instead of relying on generic knowledge.

**23 skills** covering project setup, architecture patterns, input handling, physics, 2D/3D systems, animation, audio, cameras, UI, save/load, debugging, testing, optimization, GDScript patterns, game math, and a teaching mode. All targeting Godot 4.3+ with both GDScript and C# examples — newer features from Godot 4.5, 4.6, and 4.7 (variadic functions, abstract classes, stencil buffers, AreaLight3D, and more) are included as annotated additive sections.

The set is deliberately lean: broadly-applicable engine and architecture skills that fit almost any Godot project, without game-genre-specific or platform-specific opinions.

## Quick Start

### Claude Code (recommended)

```bash
# Add the marketplace
claude plugins marketplace add jame581/skillsmith

# Install the plugin
claude plugins install godot-prompter@skillsmith
```

Or install from a local clone:

```bash
git clone https://github.com/jame581/GodotPrompter.git
claude plugins marketplace add ./GodotPrompter
claude plugins install godot-prompter@godot-prompter
```

Then start a new session and ask:

```
"I'm starting a new Godot 4.3 project. How should I organize it?"
```

The agent loads the `godot-project-setup` skill and provides a complete directory structure, autoload setup, and .gitignore — not generic advice.

### Grok Build

```bash
grok plugin install jame581/GodotPrompter --trust
grok plugin enable godot-prompter
```

Pin to a release:

```bash
grok plugin install jame581/GodotPrompter@v1.11.0 --trust
grok plugin enable godot-prompter
```

### Antigravity CLI (`agy`)

```bash
agy plugin install https://github.com/jame581/GodotPrompter
```

### GitHub Copilot CLI

```bash
copilot plugin marketplace add jame581/skillsmith
copilot plugin install godot-prompter@skillsmith
```

### Cursor

```
/add-plugin godot-prompter
```

Or clone and place in your project — Cursor reads `.cursor-plugin/plugin.json`.

### Codex

```bash
git clone https://github.com/jame581/GodotPrompter.git ~/.codex/godot-prompter
mkdir -p ~/.agents/skills
ln -s ~/.codex/godot-prompter/skills ~/.agents/skills/godot-prompter
```

See `.codex/INSTALL.md` for Windows instructions.

### OpenCode

Add to `opencode.json`:

```json
{
  "plugin": ["godot-prompter@git+https://github.com/jame581/GodotPrompter.git"]
}
```

See `.opencode/INSTALL.md` for details.

## How It Works

### Automatic activation

GodotPrompter registers a SessionStart hook that injects its skill-routing card when it detects
a Godot project. It looks for `project.godot` up to four directories above your working
directory **and up to three below it**, so the common monorepo layout — docs and tooling at the
repo root, the engine project in `source/`, `game/`, or `godot/` — is detected when you open a
session at the root. Vendored `addons/` and dot-directories are skipped, so a plugin's bundled
demo project is never mistaken for yours. In any other repository the hook does nothing at all.

The hook reads only your project's `project.godot` and its own state file under your home
directory, makes no network requests, and writes nothing. If bash is unavailable on Windows it
exits silently and the plugin behaves exactly as it did before v1.13.0.

Verified end-to-end on Claude Code and GitHub Copilot CLI. Cursor's registration ships but is
not yet confirmed. Codex and Antigravity have no hook mechanism and continue to load the
bootstrap through `AGENTS.md` / `GEMINI.md`.

> The hook covers your session. **Subagents do not receive it** — `SessionStart` does not fire on
> subagent dispatch. When none of a Godot project's agent instructions files has a
> `## GodotPrompter` section, the agent offers once to add one, since that is what subagents read.
> `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.github/copilot-instructions.md` and the `.claude/rules/`
> and `.cursor/rules/` directories all count — whichever agent they belong to — and the offer names
> the file your repo already keeps, so an agent-agnostic project is never asked to start a
> `CLAUDE.md` it does not want. It never adds the section silently, and a refusal is remembered in
> `~/.godot-prompter/state/` so you are asked once, not at every session start. Changed your mind?
> Just ask the agent to add the section; nothing has to be un-set by hand.

### Mentor mode

Say "teach me as we go" in a Godot project and GodotPrompter switches to teaching delivery: the
Godot concept and why that node, the editor setup, annotated GDScript and C#, what to verify when
you run it, and one suggested next step. It wraps the domain skills rather than replacing them,
so the guidance stays version-checked.

Your preference is remembered per project in `~/.godot-prompter/state/` — nothing is written into
your game repository. Say "just give me the code" to turn it off.

### 1. Design Phase
Ask the agent to plan a feature — it works through clarifying questions, architectural approaches with trade-offs, scene tree design and signal maps, and an ordered task list.

### 2. Implementation Phase
For each task, the agent loads the relevant domain skill:
- Character states? → `state-machine` + `input-handling`
- Decoupling systems? → `event-bus` + `dependency-injection`
- Setting up a 3D scene? → `3d-essentials` + `physics-system`
- Reusable behaviour? → `component-system` + `resource-pattern`
- Need save/load? → `save-load`

### 3. Review Phase
Ask for a code review. The `godot-code-reviewer` agent checks node architecture, signal patterns, performance, input handling, and resource management, and `godot-testing` locks in regressions.

### Example Use Cases

- **"Set up a new Godot project"** — Loads the `godot-project-setup` skill and scaffolds a complete directory structure, autoloads, input map, and .gitignore following Godot best practices.
- **"Add an idle / run / jump / fall state machine"** — Loads `state-machine` and `input-handling`, providing enum-, node-, and resource-based FSM patterns with trade-offs in both GDScript and C#.
- **"Design the signal architecture between my systems"** — Uses the `godot-game-architect` agent to plan it with `event-bus`, `dependency-injection`, and `component-system` skills, then the `godot-game-dev` agent to implement it.
- **"Set up a 3D scene with lighting, materials, and fog"** — Loads `3d-essentials` skill with StandardMaterial3D PBR workflow, DirectionalLight3D shadow configuration, environment setup, and volumetric fog.
- **"My game stutters every few seconds"** — Uses the `godot-performance-profiler` agent with the `godot-optimization` and `godot-debugging` skills to classify the bottleneck before prescribing a fix.
- **"Review my code for Godot best practices"** — Uses the `godot-code-reviewer` agent to check node architecture, signal patterns, performance, input handling, and resource management.

### Agents

GodotPrompter includes 5 specialized agents:

| Agent | Purpose |
|-------|---------|
| **godot-game-architect** | Designs systems, plans scene trees, chooses patterns |
| **godot-game-dev** | Implements features guided by skills |
| **godot-code-reviewer** | Reviews code against Godot best practices |
| **godot-performance-profiler** | Diagnoses performance issues from profiler data |
| **godot-animator** | Designs animation graphs, blend trees, IKModifier3D, BoneConstraint3D, retargeting |

## Supported Platforms

| Platform | Status | Install |
|----------|--------|---------|
| Claude Code | Primary | `claude plugins marketplace add jame581/skillsmith` |
| Grok Build | Supported | `grok plugin install jame581/GodotPrompter --trust` |
| Antigravity CLI (`agy`) | Supported | `agy plugin install https://github.com/jame581/GodotPrompter` |
| GitHub Copilot CLI | Supported | `copilot plugin marketplace add jame581/skillsmith` |
| Cursor | Supported | `/add-plugin godot-prompter` or clone with `.cursor-plugin/` |
| Codex | Supported | Clone + symlink (see `.codex/INSTALL.md`) |
| OpenCode | Supported | Add to `opencode.json` (see `.opencode/INSTALL.md`) |
| Antigravity | Supported | Install via the Antigravity plugin marketplace |

> **Legacy marketplace:** The [`godot-prompter-marketplace`](https://github.com/jame581/godot-prompter-marketplace) repo remains online so existing installs keep receiving updates, but new users should install from [`skillsmith`](https://github.com/jame581/skillsmith).

## Available Skills

### Core / Process (6 skills)

| Skill | Description |
|-------|-------------|
| `using-godot-prompter` | Bootstrap — skill catalog, workflow guide, platform setup |
| `godot-project-setup` | Scaffold directory structure, autoloads, .gitignore, input maps |
| `godot-debugging` | Remote debugger, print techniques, signal tracing, error patterns |
| `godot-testing` | TDD with GUT and gdUnit4 — test structure, mocking, CI |
| `godot-optimization` | Profiler, draw calls, physics tuning, object pooling, bottlenecks |
| `godot-mentor` | Teaching mode — concept, editor setup, annotated code, verification, one next step |

### Architecture & Patterns (6 skills)

| Skill | Description |
|-------|-------------|
| `scene-organization` | Scene tree composition, when to split scenes, node hierarchy |
| `state-machine` | Enum-based, node-based, resource-based FSM with trade-offs |
| `event-bus` | Global EventBus autoload with typed signals, decoupled communication |
| `component-system` | Composition over inheritance, component communication, interface design |
| `resource-pattern` | Custom Resources for items, stats, config, editor integration |
| `dependency-injection` | Autoloads, service locators, @export injection, scene injection |

### Physics & 2D/3D (3 skills)

| Skill | Description |
|-------|-------------|
| `physics-system` | RigidBody, Area, raycasting, collision shapes, Jolt, ragdolls, interpolation |
| `2d-essentials` | TileMaps, parallax, 2D lights/shadows, custom drawing, canvas layers |
| `3d-essentials` | Materials, lighting, shadows, environment, GI, fog, LOD, occlusion, decals |

### Gameplay & Systems (5 skills)

| Skill | Description |
|-------|-------------|
| `input-handling` | InputEvent system, Input Map actions, controllers/gamepads, mouse/touch, action rebinding |
| `animation-system` | AnimationPlayer, AnimationTree, blend trees, state machines, sprite animation |
| `audio-system` | Audio buses, music management, SFX pooling, spatial audio, interactive music |
| `camera-system` | Smooth follow, screen shake, camera zones, transitions (2D + 3D) |
| `save-load` | ConfigFile, JSON, Resource serialization, save game architecture |

### UI (1 skill)

| Skill | Description |
|-------|-------------|
| `godot-ui` | Control nodes, themes, anchors, containers, layout patterns |

### Scripting & Math (2 skills)

| Skill | Description |
|-------|-------------|
| `gdscript-patterns` | Static typing, await/coroutines, lambdas, match, exports, common idioms |
| `math-essentials` | Vectors, transforms, interpolation, curves, paths, RNG, game math recipes |

## Validation

Quality is enforced by an automated validator that runs on every release tag. Human-readable run:

```bash
node scripts/validate-skills.mjs           # exit 1 on errors, 0 otherwise
node scripts/validate-skills.mjs --json    # machine-readable for CI
```

The validator (`scripts/validate-skills.mjs`) checks every `skills/*/SKILL.md` and `agents/*.md` against these rules:

| Rule | What it checks | Severity |
|---|---|---|
| `frontmatter-{missing,name-missing,description-missing,name-mismatch}` | YAML frontmatter is present and `name` matches folder | error |
| `cross-ref-broken` | Every skill referenced on the `**Related skills:**` line and inline `see <skill> skill` mentions resolves to an existing skill folder | error |
| `agent-skill-path-broken` | Every `skills/<name>/SKILL.md` path inside an agent definition exists | error |
| `related-skills-line-missing` | Skill has a `**Related skills:**` line between H1 and first section | warning |
| `csharp-parity-missing` / `csharp-parity-accepted` | Every section with a GDScript code block also has a C# block (skills allowlisted as GDScript-only-by-design emit `accepted` instead of `missing`) | warning |
| `checklist-missing` | Implementation checklist (`- [ ]` items) present near end of file | warning |
| `token-budget-exceeded` | `SKILL.md` < 16 KB (references under `skills/<name>/references/` are unrestricted) | error |
| `token-budget-approaching` | `SKILL.md` ≥ 15.5 KB and < 16 KB — advisory heads-up before the hard budget | warning |
| `orphan-reference` | Every `references/*.md` file is linked from its parent `SKILL.md` | warning |
| `card-marker-{missing,malformed,duplicate}` | The hook-injected card regions (`SESSION-CARD` in `using-godot-prompter`, `MENTOR-CARD` in `godot-mentor`) have both markers, in order, appearing exactly once — the hook extracts the *first* region, so a duplicate pair would silently become the injected payload | error |
| `card-empty` | The card region is non-empty — otherwise the hook would inject nothing while CI stayed green | error |
| `card-oversized` | The card region is ≤ 3 KB — it is injected on every session start *and* every compaction | error |
| `card-skill-missing` | Every skill named in `CARD_SPECS` exists, so deleting one fails CI instead of silently skipping its check | error |

Hook behaviour is covered separately by `npm run test:hooks` (22 cases), which also runs on release tags.

Token cost reporting:

```bash
node scripts/count-tokens.mjs --tokenizer --markdown
```

Produces a per-skill / per-agent table (bytes, KB, estimated tokens, Claude / GPT tokenizer counts, status) that lives between `<!-- BEGIN-TOKEN-TABLE -->` markers in [`docs/token-budget.md`](docs/token-budget.md).

CI gate: `.github/workflows/release.yml` runs both `node scripts/validate-skills.mjs` and a tag-vs-manifest version-consistency check on every `v*.*.*` push. The release is blocked if the validator returns errors or any of `package.json` / `.claude-plugin/plugin.json` / `.claude-plugin/marketplace.json` / `.cursor-plugin/plugin.json` / `plugin.json` drifts from the tag.

**Current baseline (v1.12.0):** 0 errors, 16 warnings (all `csharp-parity-accepted` for intentionally GDScript-only skills; 0 token-budget). Every `SKILL.md` is **under** the 16 KB budget — since v1.12.0 that is a validator **error**, not a warning, so an over-budget skill fails the release.

A manual agent-integration test plan covering full workflows (skill discovery, cross-reference navigation, end-to-end feature implementation) lives in [`tests/agent-integration/TEST_PLAN.md`](tests/agent-integration/TEST_PLAN.md) for spot-checks against new agent versions or platforms.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to add new skills, conventions, and testing requirements.

## Acknowledgements

The SessionStart hook's polyglot Windows wrapper, JSON escaper, and platform output branching are
adapted from [Superpowers](https://github.com/obra/superpowers) by Jesse Vincent (MIT).

## License

[MIT](LICENSE)

## Author

* **Jan Mesarč** - *Creator* - [janmesarc.online/](https://janmesarc.online/)

Do you like this project and want to support me? Great! I really appreciate it and it makes me very happy if you [Buy Me A Coffee](https://www.buymeacoffee.com/jame581).
