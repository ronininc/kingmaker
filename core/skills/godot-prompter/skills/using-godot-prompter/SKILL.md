---
name: using-godot-prompter
description: Bootstrap skill — establishes how to find and use GodotPrompter skills, with platform-specific tool mapping
---

# Using GodotPrompter

> **Related skills:** **godot-project-setup** for scaffolding a new project, **godot-debugging** for diagnosing runtime issues, **godot-testing** for setting up a test harness.

GodotPrompter provides Godot 4.x domain-specific skills for AI coding agents. Skills cover project setup, architecture patterns, gameplay systems, UI, multiplayer, testing, and deployment — for both GDScript and C#.

## How to Access Skills

**In Claude Code:** Use the `Skill` tool with the skill name (e.g., `Skill: "godot-prompter:state-machine"`).

**In Copilot CLI:** Use the `skill` tool. Skills are auto-discovered from installed plugins.

**In Gemini CLI:** Deprecated (succeeded by Antigravity CLI).

**In Cursor:** Skills are loaded via custom instructions / rules system.

**In Codex:** Skills load natively via the AGENTS.md re-export. Follow skill instructions directly; see `references/codex-tools.md` for tool mapping.

**In OpenCode:** Skills are discovered from the installed plugin. Use the `/skills` command to browse or invoke skills directly. See `.opencode/INSTALL.md` for setup.

**In Antigravity (2.0, IDE, CLI):** Skills activate automatically when your prompt matches a skill's `description` frontmatter — no tool call needed. Install the plugin using:
```bash
agy plugin install https://github.com/jame581/GodotPrompter
```
For manual, workspace, or cross-project installations:

### Installing GodotPrompter for Antigravity

**Workspace (project-scoped) — recommended for active development:**

```bash
# Linux / macOS — from your Godot project root:
mkdir -p .agents
ln -s /path/to/GodotPrompter/skills .agents/skills

# Windows (PowerShell, Developer Mode or run as admin):
New-Item -ItemType Directory -Force .agents | Out-Null   # junction won't create the parent
New-Item -ItemType Junction -Path .agents\skills -Target D:\Godot\GodotPrompter\skills
```

> **Legacy path note:** `.agent/skills/` (singular) was the early CLI convention; `.agents/skills/` (plural) is the current standard for all Antigravity products.

**Global (cross-project):**

```bash
# Official path (Google Codelabs): ~/.gemini/config/skills/
# Symlink individual skill folders so each is a direct child (recommended):
mkdir -p ~/.gemini/config/skills/
ln -s /path/to/GodotPrompter/skills/* ~/.gemini/config/skills/
```

> `~/.gemini/skills/` is a community-verified alias but not the path the official Codelabs docs name. Prefer `~/.gemini/config/skills/` for new installs.

> **Nesting caveat:** Prefer `ln -s skills/*` over cloning the repo directly into the skills dir, so each skill is an immediate child (`<skills-dir>/<skill-name>/SKILL.md`). Confirm nested discovery works before relying on the clone approach.

See `references/antigravity-tools.md` for the full tool mapping and SKILL.md frontmatter details.

## Coexistence with Other Plugins (e.g., Superpowers)

<!-- SESSION-CARD-START -->
**GodotPrompter is active in this Godot project.**

Workflow plugins decide *how you work*; GodotPrompter decides *what you build*. Both apply.

**RULE: before implementing any Godot system, invoke the matching `godot-prompter:*` skill.**
Applies to subagents writing Godot code too.

| Building… | Start with |
|---|---|
| Input, cameras | `input-handling`, `camera-system` |
| Architecture | `state-machine`, `event-bus`, `scene-organization`, `component-system`, `resource-pattern`, `dependency-injection` |
| Persistence | `save-load` |
| UI | `godot-ui` |
| Animation, audio | `animation-system`, `audio-system` |
| Physics, 2D, 3D | `physics-system`, `2d-essentials`, `3d-essentials` |
| Game math | `math-essentials` |
| GDScript idioms | `gdscript-patterns` |
| Test, debug, profile | `godot-testing`, `godot-debugging`, `godot-optimization` |
| Setup | `godot-project-setup` |
| Teaching while building | `godot-mentor` |

Full index: invoke `godot-prompter:using-godot-prompter`.

**Red flags — you are rationalizing:**

| Thought | Reality |
|---|---|
| "I know how CharacterBody2D works" | Knowing the class ≠ knowing the pattern. Invoke. |
| "It's a two-line script" | Two-line scripts still pick node types. Invoke. |
| "The plan says what to build" | The plan says what. The skill says how. Invoke. |
| "I loaded a Godot skill already" | Different system, different skill. |
| "The user wants a quick fix" | Quick fixes set architecture. Invoke. |
<!-- SESSION-CARD-END -->

## Workflow: From Idea to Working Game

GodotPrompter handles the full development workflow. No other plugins required.

### 1. Design Phase
Plan the system before writing code:
- Ask clarifying questions about the game/system
- Weigh architectural approaches and their trade-offs
- Design the scene tree, signal map, and data flow
- Break the work into ordered tasks

### 2. Implementation Phase
For each task in the plan, load the relevant domain skill:
- Building movement states? Load `godot-prompter:state-machine`
- Decoupling systems? Load `godot-prompter:event-bus` or `godot-prompter:dependency-injection`
- Need save/load? Load `godot-prompter:save-load`

Each skill provides complete code examples, Godot best practices, and a checklist.

### 3. Review Phase
Load `godot-prompter:godot-debugging` and `godot-prompter:godot-testing` to verify behavior and lock in regressions.

### Agents

- **godot-game-architect** — Designs systems, plans scene trees, chooses patterns
- **godot-game-dev** — Implements features guided by skills
- **godot-code-reviewer** — Reviews code against Godot best practices
- **godot-performance-profiler** — Diagnoses performance issues from profiler data
- **godot-animator** — Designs animation graphs, blend trees, IKModifier3D, BoneConstraint3D, retargeting

### Plan Storage
Implementation plans and design docs are saved to `docs/godot-prompter/plans/` and `docs/godot-prompter/specs/` in the user's project.

## Platform Adaptation

Skills use Claude Code tool names as the canonical reference. Non-Claude platforms: see the appropriate tool mapping file in `references/` for your platform's equivalents:

- [`references/copilot-tools.md`](references/copilot-tools.md) — GitHub Copilot CLI
- [`references/codex-tools.md`](references/codex-tools.md) — Codex
- [`references/cursor-tools.md`](references/cursor-tools.md) — Cursor
- [`references/gemini-tools.md`](references/gemini-tools.md) — Legacy Gemini CLI (deprecated)
- [`references/antigravity-tools.md`](references/antigravity-tools.md) — Antigravity (2.0 desktop, IDE, CLI)

## Available Skills

### Core / Process
- `using-godot-prompter` — This skill (bootstrap)
- `godot-project-setup` — Scaffold new projects: directory structure, autoloads, `.gitignore`
- `godot-debugging` — Remote debugger, print techniques, signal tracing, error patterns
- `godot-testing` — TDD with GUT and gdUnit4
- `godot-optimization` — Profiler, draw calls, physics tuning, memory, bottlenecks
- `godot-mentor` — Teaching mode: concept, editor setup, annotated code, verification, one next step

### Architecture & Patterns
- `scene-organization` — Scene tree structure, composition vs inheritance, when to split
- `state-machine` — FSM patterns (enum, node-based, resource-based) with trade-offs
- `event-bus` — Signal-based decoupling via an autoload event hub
- `component-system` — Composition over inheritance, component communication
- `resource-pattern` — Custom Resources as data containers
- `dependency-injection` — Autoloads, service locators, `@export` injection, scene injection

### Gameplay & Systems
- `input-handling` — InputEvent system, Input Map, controllers/gamepads, mouse/touch, rebinding
- `animation-system` — AnimationPlayer, AnimationTree, blend trees, sprite animation
- `audio-system` — Audio buses, music management, SFX pooling, spatial audio
- `camera-system` — Camera follow, screen shake, zones, transitions (2D + 3D)
- `save-load` — ConfigFile, JSON, Resource serialization, save architecture

### UI
- `godot-ui` — Control nodes, themes, anchors, containers, layout patterns

### Physics & 2D/3D
- `physics-system` — RigidBody, Area, raycasting, collision shapes, Jolt, ragdolls, interpolation
- `2d-essentials` — TileMaps, parallax, 2D lights/shadows, canvas layers, custom drawing
- `3d-essentials` — Materials, lighting, shadows, environment, GI, fog, LOD, occlusion, decals

### Scripting & Math
- `gdscript-patterns` — Static typing, await/coroutines, lambdas, match, exports, idioms
- `math-essentials` — Vectors, transforms, interpolation, curves, paths, RNG

---

## Implementation Checklist

- [ ] Identified the matching domain skill via the table above before writing any system code
- [ ] Invoked the identified skill with the `Skill` tool (or platform equivalent) before implementation
- [ ] When a workflow plugin is also active (Superpowers, etc.), still invoked the relevant godot-prompter domain skill during implementation — they are complementary, not exclusive
- [ ] After implementation, ran `godot-prompter:godot-testing` and `godot-prompter:godot-debugging` to validate behavior
- [ ] Logged any newly-discovered domain gap that no current skill covers, so it can become a future skill
