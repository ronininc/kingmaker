# Original game creation: target and measured starting point

## Robbie's North Star
Analyze reference games' concepts and quality (Mirror's Edge, Infamous, GTA 6, Watch Dogs), gather the user's desired combination through speech or UI, create an original game in the background, and notify only after the finished result is verified. Examples: parkour, first-person camera, fictional firearms, abilities and karma. The references are comparative intent, not permission to copy their worlds, art, characters, proprietary code, names or distinctive protected presentation. Robbie's existing methods remain his work; external sources retain separate rights.

## Implemented foundation
`game-brief.mjs` creates a structured requirements draft and reports missing decisions. It is wired into the same candidate voice/local text/session routing as native creation. `game plan start`, `game plan set perspective first person`, `game plan set parkour yes`, `game plan set core loop ...`, and `game plan show` are bounded commands, not general conversational understanding. Draft exists in memory for this session. It does not launch a build or schedule notifications.

Required decisions: target platform, perspective, scope, player mode, quality, parkour/firearms/abilities/karma inclusion, original premise, core loop, art direction, completion criteria, budget and deadline. Complete intake means ready for implementation review, not game-ready.

## Ordered delivery gates
1. Complete requirements and confirm an achievable original vertical slice; compare selected concepts with sourced evidence, not guessed game features.
2. Select reviewed runtime/engine and explicit local/remote compute budget. Provision only approved dependencies and isolated workspace.
3. Implement original movement/camera and chosen mechanics; test collision, input, save state and branching choices.
4. Generate or acquire individually licensed assets; source provenance, Armor scanning and actual format/import verification remain separate gates.
5. Compose scene, mechanics and UI into a playable build; run automated smoke/gameplay tests, performance measurements and human-visible visual inspection on target hardware.
6. Iterate measured failures rather than claiming a complete game from a scene or script. Confirm fidelity and acceptance criteria.
7. Package and launch the build, record test/artifact hashes; only a durable job runner may schedule a truthful completion notification. Do not report completed for a plan, partial artifact or failed build.

## Current proof and explicit gaps
The neo-outlaw bar proof combines original timber saloon geometry and cyber details with an actual source-based learned camera artifact into four real tiny Blender renders. It is a fixed trusted primitive composition harness. It is not a playable game, open world, parkour implementation, general asset-fusion intelligence or AAA-quality demonstration. No protected game assets are used.

Still unimplemented: general reference-game analysis, robust natural-language requirements dialogue, full engine/gameplay generator, persistent background job orchestration, authenticated graphical approval cards, target-device acceptance testing and actual completion notification integration. A session draft does not resolve these gaps.

## Owner quality rejection and measured constraints

Robbie explicitly rejected the primitive bar output as far below his quality bar. It is not an accepted synthesis result or visual benchmark. Stop generating more primitive scenes as substitutes for this requirement.

Code audit: current film plan supports only cube/sphere/cylinder/plane/text, max64objects per shot; no external mesh/PBR/rig import. Builder uses CPU1thread,8samples,24segment curves and uniform materials; no depth-of-field/exposure controls and only linear object motion. Resolution/sample increases alone cannot fix missing geometry, materials, art direction or animation.

Measured local machine: AppleM3,10GPU cores,8GiB unified RAM,1.8GiB free disk. Blender/Godot are installed; Unreal app not observed. This is a resource constraint, not an explanation that the rejected image is acceptable. Blender's official requirements list8GB minimum/32GB recommended: https://www.blender.org/download/requirements/ . Epic's macOS development guide recommends32GB or more: https://dev.epicgames.com/documentation/unreal-engine/macos-development-requirements-for-unreal-engine . AppleSilicon Metal support exists in Cycles, but this does not certify performance or fix absent art assets: https://docs.blender.org/manual/en/4.4/render/cycles/gpu_rendering.html .

Next meaningful quality test: one1024px hero doorway detail, properly authored beveled architecture/hardware, rights-cleared wood/metal PBR and controlled neon reflections, inspected against an explicit quality reference. Requires actual quality assets/import workflow or substantial original modeling before rendering. No production assets/HDRI/EXR located in scoped candidate/worktree inventory; that is not a claim that none exist anywhere on the user's Mac. No new downloads/render/build undertaken during this audit.
