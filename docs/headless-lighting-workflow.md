# Persistent headless lighting workflow

This is an original bounded execution primitive, not a claim of tutorial learning or photorealism.
`assets/scene/lighting_plan.py` accepts data-only camera, lens, aperture, area lights, background and render controls. It never accepts Python, URLs, plugin names or third-party files. Unknown fields, nonfinite numbers, resource excess, ambiguous units and degenerate camera/light targets fail validation.

`assets/scene/apply-lighting-project.py` accepts an explicitly approved locally authored project with its SHA256 and a validated plan. The caller must establish trust and rights: the string `approved-local-authored` is an assertion, not authorization or a sandbox. Never expose this entry point directly to an untrusted model/user upload. Run Blender with `--factory-startup --disable-autoexec`; the script additionally loads with `use_scripts=False`. It does not make Blender's binary parser safe for untrusted files.

The runner snapshots the input, preserves existing geometry and materials, hides prior lights (does not delete them), adds identifiable camera/lights, saves a new project and reloads it. Receipt contains readable scene inventory and camera/light/render values plus project and geometry-content hashes. This gives the reasoning/context layer actual persisted state rather than a narrative claim. Material content hash covers node types/names, not a full shader equivalence proof; source project hash binds the complete original bytes.

## Verified locally

Seven pure-Python validation tests pass. Blender 4.2.3 LTS actually loaded the existing approved timber-door project with packed CC0 PBR maps, applied the plan, saved and reloaded the new project. Geometry hashes, material count/node identities, packed-image count, inventory and camera/light/render values matched after reload. Evidence: sibling `kingmaker-451-fixes/lighting-project-proof-v2/receipt.json`. No new visual-quality claim: this run did not render an image.

## Boundaries / next integration

- Model/tutorial subsystem must propose this strict plan and check its outcome on held-out scenes. This module does not learn from a transcript or video by itself.
- Existing scene already contains authored geometry and licensed materials. Asset discovery/import remains separate.
- CPU, four threads, 128–1024 px, 16–256 samples, up to six area lights. The runner preserves at least a 512 MiB starting disk reserve and accepts at most a 32 MiB source. No automatic GPU claim; selecting GPU requires enumerating enabled Cycles devices and measuring a bounded actual render.
- Rendering still consumes CPU/GPU, memory and time. This project-application measurement is not a render benchmark.
- JSON receipts are inspectable context, not magical unlimited memory or proof of aesthetics.
- No compositor, HDRI, volumetrics, asset-rig editing, film export or photorealism certification introduced.

## Chat presentation integration checkpoint

The JS native-creation CLI now emits `result.presentation` (also carried by the existing `@@ghost nativeCreation` session event). It contains sequential workflow nodes/edges and local artifact links only after canonical containment and current SHA256 verification. Incomplete nodes remain incomplete. It never executes or opens a link. Native UI embedding and click handling are **not implemented**: the authoritative 4.5.1 Swift consumer source is absent from this candidate, and the available full checkout is older 4.4.2. No signed installed app was changed. This is a real JS producer contract, not a claim of a functioning video player or clickable native chart.
