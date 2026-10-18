---
name: godot-prompter
description: >-
  GodotPrompter suite for Godot 4.x (GDScript and C#): project setup, architecture patterns (state machine,
  event bus, components, dependency injection, resources), 2D/3D, physics, animation, audio, camera, input, UI,
  save/load, debugging, testing (GUT/gdUnit4), optimization and mentor mode, plus architect/dev/reviewer/profiler/
  animator agent briefs. Use whenever the task is Godot game or tool work, including the engine's Titan/Godot render
  lane. This entry is a router: read the matching sub-skill file below before writing any Godot code.
---

# GodotPrompter (router)

Upstream skills sit unmodified under `skills/<name>/SKILL.md`. They cross-reference each other by name;
when one says "use the X skill", Read `skills/X/SKILL.md` from this folder. Start with
`skills/using-godot-prompter/SKILL.md` if the task spans several areas.

| sub-skill | when |
|---|---|
| `skills/2d-essentials/SKILL.md` | Use when working with 2D-specific systems — TileMaps, parallax scrolling, 2D lights and shadows, canvas layers, particles 2D, custom drawing, and 2D meshes in Godot 4.3+ |
| `skills/3d-essentials/SKILL.md` | Use when working with 3D-specific systems — materials, lighting, shadows, environment, global illumination, fog, LOD, occlusion culling, and decals in Godot 4.3+ |
| `skills/animation-system/SKILL.md` | Use when implementing animations — AnimationPlayer, AnimationTree, blend trees, state machines, sprite animation, and code-driven animation |
| `skills/audio-system/SKILL.md` | Use when implementing audio — audio buses, AudioStreamPlayer, spatial audio, music management, SFX pooling, and dynamic mixing |
| `skills/camera-system/SKILL.md` | Use when implementing cameras — smooth follow, screen shake, camera zones, and transitions for 2D and 3D |
| `skills/component-system/SKILL.md` | Use when building reusable node components — composition patterns, component communication, and interface design |
| `skills/dependency-injection/SKILL.md` | Use when managing dependencies between systems — autoloads, service locators, @export injection, and scene injection patterns |
| `skills/event-bus/SKILL.md` | Use when implementing decoupled communication between nodes — global EventBus autoload with typed signals |
| `skills/gdscript-patterns/SKILL.md` | Use when writing GDScript — static typing, await/coroutines, lambdas, match patterns, export annotations, inner classes, and common idioms |
| `skills/godot-debugging/SKILL.md` | Use when debugging Godot projects — remote debugger, print techniques, signal tracing, common error patterns and fixes |
| `skills/godot-mentor/SKILL.md` | Use when the user wants to learn Godot while building — teaching mode that explains the concept, the editor setup, and what to verify, instead of just delivering code. Triggers on "teach me", "explain as we go", "I'm lea |
| `skills/godot-optimization/SKILL.md` | Use when optimizing Godot games — profiler, draw calls, physics tuning, memory management, and common bottlenecks |
| `skills/godot-project-setup/SKILL.md` | Use when creating a new Godot 4.x project — scaffolds recommended directory structure, project settings, autoloads, and .gitignore |
| `skills/godot-testing/SKILL.md` | Use when writing tests for Godot projects — TDD workflow with GUT and gdUnit4, covers both GDScript and C# |
| `skills/godot-ui/SKILL.md` | Use when building user interfaces — Control nodes, themes, anchors, containers, and layout patterns |
| `skills/input-handling/SKILL.md` | Use when implementing input — InputEvent system, Input Map actions, controllers/gamepads, mouse/touch, action rebinding, and input architecture |
| `skills/math-essentials/SKILL.md` | Use when implementing game math — vectors, transforms, interpolation, curves, random number generation, and common geometric recipes |
| `skills/physics-system/SKILL.md` | Use when working with physics bodies, collision shapes, raycasting, areas, rigid bodies, ragdolls, soft bodies, Jolt physics, and physics interpolation in Godot 4.3+ |
| `skills/resource-pattern/SKILL.md` | Use when creating data containers in Godot — custom Resources for configuration, items, stats, and editor integration |
| `skills/save-load/SKILL.md` | Use when implementing save/load systems — ConfigFile, JSON, Resource serialization, save game architecture |
| `skills/scene-organization/SKILL.md` | Use when designing scene tree structure — composition vs inheritance, when to split scenes, node hierarchy patterns |
| `skills/state-machine/SKILL.md` | Use when implementing state machines in Godot — enum-based, node-based, and resource-based FSM patterns with trade-offs |
| `skills/using-godot-prompter/SKILL.md` | Bootstrap skill — establishes how to find and use GodotPrompter skills, with platform-specific tool mapping |

## Agent briefs

Role prompts under `agents/`: `agents/godot-animator.md`, `agents/godot-code-reviewer.md`, `agents/godot-game-architect.md`, `agents/godot-game-dev.md`, `agents/godot-performance-profiler.md`.
Use them as subagent instructions only within the operator's 3-subagent cap.

Provenance, license and flags: `VENDORED.md`.
