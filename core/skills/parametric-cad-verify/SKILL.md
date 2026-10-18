---
name: parametric-cad-verify
description: Generate a real, dimensioned solid model (STEP/STL) for a 3D-printed part with headless FreeCAD (or CadQuery), as parametric code that checks itself. Use for enclosure panels, brackets, jigs, mounts — anything that must be re-generatable when the spec changes and must be *proven* correct, not just exported without an error.
---

# Parametric CAD generation and verification

Generate the part from a script with named constants, run it headless, and make
the script **fail loudly** when the geometry is wrong. "The script ran" is not
evidence. A reference implementation lives at `examples/mount-plate/` in this
repo — copy its shape.

## What you need

- **FreeCAD**. Any GUI install includes the headless CLI.
  - macOS: `/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd`
  - Linux: `which freecadcmd` (or `FreeCADCmd`); Flatpak:
    `flatpak run --command=freecadcmd org.freecad.FreeCAD`
- **CadQuery** is the fallback for a pure-CI pipeline: `pip install cadquery`
  into a dedicated Python 3.10–3.12 venv (its OCP dependency lags new CPython).
  Both produce STEP and STL; STEP opens in any CAD tool.

## Procedure

1. **Real dimensions first.** Datasheets beat estimates. Where you must guess,
   write `# PLACEHOLDER — verify against datasheet` next to the constant and
   repeat the flag in your summary. A guess must not look load-bearing.
2. **Named constants at the top**, no inline magic numbers. Layouts in bring-up
   move; a script that regenerates is worth more than a frozen file.
3. **Derive, don't restate.** If B is sized off A, compute B from A every run.
   A constant copied from another constant is a bug waiting for an edit.
4. **Build with `Part`**, run with `freecadcmd script.py`:
   ```python
   import FreeCAD as App, Part
   box = Part.makeBox(L, W, H)
   cyl = Part.makeCylinder(r, H + 2, App.Vector(x, y, -1))
   part = box.cut(cyl)
   part.exportStep("part.step")
   ```
   Engraved text: `Draft.make_shapestring(String=..., FontFile=<.ttf path>, Size=...)`
   — works headless but needs a font **file path**, not a name.
5. **Verify the file you wrote, not the object that wrote it.** Re-read the STEP:
   ```python
   shp = Part.Shape(); shp.read("part.step")
   len(shp.Solids) == 1;  shp.isValid()
   all(len(s.Shells) == 1 for s in shp.Solids)      # no enclosed void
   shp.BoundBox.XLength, .YLength, .ZLength          # match the spec
   shp.Volume                                        # match a HAND-computed number
   ```
6. **Assert the feature, not the operation.** "I cut a hole" is not "there is a
   hole". Measure the volume each boolean actually removed and compare it with
   the cylinder you asked for. A hole that removes 0.00 mm³ should be the
   loudest failure in the run. Probe the *finished* part (`shape.isInside`) so a
   later fuse that fills a bore back in is caught too.
7. **Check the process, not just the geometry.** Name the limits — build volume,
   nozzle width, minimum wall — and assert against them. A 0.1 mm stroke is
   valid geometry that cannot be extruded.
8. **Make the checks able to fail, then prove it.** Add a switch that
   deliberately breaks the part and confirm a non-zero exit. See next section.
9. **Commit the script and the STEP/STL together**, so a reviewer can open the
   STEP without installing a toolchain.

## Making `freecadcmd` fail honestly (verified on FreeCAD 1.0.2, macOS)

All four of these were reproduced, not recalled:

- **An uncaught exception exits 0 when you run a script *file*** (`freecadcmd
  script.py`). FreeCAD prints `Exception while processing file: … [msg]` and
  returns success. An `assert` that fails — or a syntax error — looks green to
  CI. The inline form behaves differently: `freecadcmd -c "raise …"` exits 1,
  which is why the FreeCAD MCP bridge's `execute_code_headless` (it uses `-c`)
  reports failures correctly while a build script run as a file does not.
- **A script that raises runs twice**: once with `__name__` set to the file's
  stem, then again as `__main__`. Side effects happen twice.
- **`sys.exit(n)` does propagate** (exit code `n`). So: collect failures in a
  helper that never raises, and `sys.exit(1)` at the end.
- **…but `sys.exit` does not flush Python's stdout.** With output redirected
  (CI, a pipe, a file) an unflushed failure report is lost entirely — a red
  build with no explanation. `print(..., flush=True)` everywhere.

Also:

- **`__name__` is the filename, not `"__main__"`.** The usual
  `if __name__ == "__main__":` guard silently runs nothing — no error, exit 0,
  zero files exported. Call `main()` unconditionally.
- **`freecadcmd` leaves a `__pycache__/`** beside the script. `.gitignore` it.
- A **`3DconnexionNavlib` dlopen warning** on macOS is cosmetic (no SpaceMouse
  driver). Filter it, don't chase it.
- Finding the addon directory headlessly:
  `freecadcmd -c "import os; print(os.path.join(FreeCAD.getUserAppDataDir(), 'Mod'))"`.
  Trust this over any table of paths — on a 1.0.2 install it reported the
  unversioned directory even though upstream documents a versioned one.

## Geometry gotchas (each found on a real part)

- **A fuse of two solids sharing only a coincident face can yield 2 disjoint
  solids**, with no exception. Give mating features a real 0.1–0.2 mm overlap
  and check solid count immediately after, not just at the end.
- **Dense cutouts on one face can remove a full bridge of material** and split a
  part into islands. Same silent failure, subtractive. Verify solid count after
  every multi-cutout part.
- **Reassigning `.Placement` on something already unioned/cut can fragment it.**
  Build the angled feature into the cut geometry, or use the three-argument
  `Placement(position, rotation, centre)` to rotate a tool about a pivot.
- **One solid + valid + right bounding box ≠ printable.** Check
  `len(solid.Shells)` (a sealed cavity shows as >1 shell) and compare the
  bounding box with the printer's real build volume, in the planned
  orientation, with margin. Even one shell is necessary, not sufficient: a
  cavity that reaches air through a slot too narrow to clear support out of is
  still unprintable. Design a genuinely open face instead.
- **A slicer treats one file as one rigid body with one orientation.** A flat
  panel plus protruding feet exported as one file forces supports across the
  panel's whole underside. Export features that can't share an orientation as
  separate files and assemble after printing.
- **One view is not verification.** A canted head looked right in isometric
  while being structurally wrong; only the `Right` view showed it. For any part
  defined by a profile, angle or taper, render the orthographic view it lives in.
- **Mesh once, explicitly.** A shape-level `exportStl` may ignore your tolerance
  (a 300 KB mesh came out at 12.5 MB). Use `MeshPart.meshFromShape(Shape=...,
  LinearDeflection=0.05)` and write every mesh format from that one mesh.
- `qlmanage` (macOS Quick Look) can hang on 3D files from a shell. Verify a mesh
  by parsing it, not by thumbnailing it.

## Variant: a live GUI session

Headless stays the default — reproducible, unattended, CI-runnable. Use a live
FreeCAD session (via the `drive-desktop-app` skill) only to *see* the model or
iterate with a human watching. The standard does not relax: a screenshot is not
proof. Read `Volume`, `len(Solids)`, `len(Shells)`, `isValid()` and the bounding
box, and compare against a number computed independently.
