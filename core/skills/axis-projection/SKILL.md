---
name: axis-projection
description: >-
  Deterministic projection maths and drawings in pure TypeScript (server/src/runtime/projection/). Use it when the
  task is: a technical drawing or 3-view / multi-view orthographic drawing of a part (third-angle or first-angle, hidden
  lines, width/height/depth dimensions); an isometric or 2.5D scene (floor plan, room, desk, storefront); vector, axis
  or plane projection maths (scalar/vector projection, rejection); an axonometric (isometric, dimetric, trimetric),
  oblique (cavalier, cabinet), orthographic or perspective camera; projection mapping / corner-pin (fit a video or
  graphic onto a wall, building or booth with a homography or CSS matrix3d); 3D to 2D or 4D to 3D rendering (tesseract,
  hypercube); or output for holographic display tech (Pepper's ghost pyramid layout, light-field quilt such as Looking
  Glass, on-screen hologram-look preview). Same input gives byte-identical SVG/HTML; no network, no randomness.
---

# Axis projection

A projection takes points from a higher-dimensional space onto a lower one along chosen directions. This module is
the one place for that maths and for the drawings built on it. Everything is a pure function: it returns a string
(SVG or HTML) or numbers, and never touches the network or the disk.

Not routed yet: no conversation route calls it. Import it directly:

```ts
import { multiviewSvg, boxMesh /* … */ } from '<path to>/server/src/runtime/projection/index.js';
```

## Conventions (all modules)

- Right-handed, +Y up, +Z toward the viewer in the front view. Angles in radians.
- 4x4 matrices are row-major, `m[row * 4 + col]`, applied to column vectors. 3x3 homographies likewise.
- Numbers written into SVG/HTML are rounded to 3 decimals (the CSS `matrix3d` is the one exception: 12 significant
  digits, because its perspective terms are tiny).
- Bad input throws a `RangeError` with a plain message (zero-length axis, degenerate quad, unknown view, bad fill).

## Which function for which job

| Job | Use | File |
| --- | --- | --- |
| Length / component of a vector along an axis, or what is left | `scalarProjection(v, axis)`, `vectorProjection(v, axis)`, `rejection(v, axis)` | `vec.ts` |
| Flatten a vector into a plane | `projectOntoPlane(v, normal)` | `vec.ts` |
| Camera matrix | `orthographic(l,r,b,t,n,f)`, `perspective(fovY, aspect, near, far)`, `lookAt(eye, target, up)` | `camera.ts` |
| Drawing-style views | `isometric()`, `dimetric(pitch)`, `trimetric(yaw, pitch)`, `cavalier(angle?)`, `cabinet(angle?)`, `standardView('front'\|'top'\|'right'\|…)` | `camera.ts` |
| Apply a camera to a point | `projectPoint3(matrix, [x,y,z])` → `{x, y, depth}` | `camera.ts` |
| Part drawing, several views, dimensions | `multiviewSvg(mesh, { angle, views?, scale?, dimensions?, title?, units? })` | `drawing.ts` |
| Meshes for the above | `boxMesh(w,h,d)`, `prismMesh(polygon2D, depth)` or your own `{ vertices, faces }` | `drawing.ts` |
| One view's edges as data / wireframe | `projectMeshView(mesh, view)`, `projectMesh(mesh, viewMatrix)`, `meshWireframeInner(mesh, viewMatrix, {width,height})` | `drawing.ts` |
| Isometric scene from boxes | `isometricSceneSvg({ boxes, tile?, background? })` | `scene.ts` |
| Fit content onto a quadrilateral | `homographyFrom4(srcQuad, dstQuad)`, `applyHomography(H, p)`, `invertHomography(H)`, `cssMatrix3d(H)` | `homography.ts` |
| Projector page for a wall/building/booth | `projectionMapHtml({ surfaceQuad, contentWidth, contentHeight, contentHtml })` | `homography.ts` |
| Hypercube / 4D | `tesseract()`, `rotate4(plane, angle)`, `project4to3(p, mode)`, `hypercubeSvg({ rotations, … })` | `hyper.ts` |
| Pepper's ghost pyramid display | `peppersGhostLayout({ render, size })` | `holographic.ts` |
| Light-field display (quilt) | `lightFieldQuilt({ renderAt, views?, columns?, viewCone?, tileWidth?, tileHeight? })` | `holographic.ts` |
| On-screen hologram look | `hologramStyle(svgInner, { width?, height?, idPrefix? })` | `holographic.ts` |

## Examples

Vector projection: `vectorProjection([3, 4, 0], [1, 0, 0])` is `[3, 0, 0]`; `scalarProjection` is `3`; `rejection` is `[0, 4, 0]`.

Three-view drawing, third angle (top above the front view, right view to its right), with an isometric view:

```ts
const svg = multiviewSvg(prismMesh([[0,0],[80,0],[80,18],[56,40],[0,40]], 36), {
  angle: 'third', views: ['front', 'top', 'right', 'iso'], title: 'Wedge bracket', units: 'mm',
});
```

`angle: 'first'` puts the top view below the front and the right view to its left. Overall width, height and depth are
dimensioned in the mesh's own units; `scale` is pixels per unit (default: longest side 180 px).

Isometric scene (box = min corner `x,y,z` plus size `w,h,d`; `y` is up; one `tile` = one world unit on screen):

```ts
isometricSceneSvg({ tile: 28, boxes: [
  { x: 0, y: 0, z: 0, w: 16, h: 0.2, d: 12, fill: '#e8e2d4' },                 // floor
  { x: 2, y: 0.2, z: 3, w: 2, h: 0.8, d: 1, fill: '#b98b5e', label: 'Desk' },  // stands on the floor
]});
```

Boxes should not overlap in volume (a desk stands ON the floor box, not inside it). Draw order is back to front
by separating axis, falling back to `x + z`, then `y`, then input order.

Projection mapping (corner order: top-left, top-right, bottom-right, bottom-left):

```ts
const page = projectionMapHtml({
  surfaceQuad: [[210,120],[1010,60],[1080,640],[170,700]],   // where the corners land, in page pixels
  contentWidth: 1280, contentHeight: 720,
  contentHtml: '<video src="show.mp4" autoplay muted loop width="1280" height="720"></video>',
});
```

`contentHtml` is inserted as-is, so pass markup you trust. `homographyFrom4` throws if any three corners are collinear.

Four dimensions: `hypercubeSvg({ rotations: [{ plane: 'xw', angle: 0.7 }, { plane: 'zw', angle: 0.45 }] })` returns an SVG
wireframe whose stroke opacity and width follow w-depth (`depthCue: false` to turn that off; `camera: 'perspective'`
to switch from the isometric camera). Perspective 4D to 3D uses an eye at `w = -wDistance` (default 3, must exceed 2),
so larger `w` draws smaller. Include a plane that mixes `y` (`yw`, `xy`, `yz`) if you need views of different sides to differ.

Holographic output (the callbacks return SVG inner content, no `<svg>` wrapper):

```ts
// Pepper's ghost: four views around a black centre, front at the bottom, back at the top turned 180°,
// left +90°, right -90°. render(view) draws in a 400x400 box (HOLO_VIEW_SIZE).
peppersGhostLayout({ size: 1000, render: (view) => hypercubeInner({ rotations: [/* … */] }) });

// Light-field quilt: view 0 is the BOTTOM-LEFT tile, views run left to right then up, camera angle rises from
// -viewCone/2 (view 0) to +viewCone/2 (last). renderAt(angle) draws in a tileWidth x tileHeight box.
lightFieldQuilt({ views: 48, columns: 8, renderAt: (angle) => meshWireframeInner(mesh, trimetric(Math.PI/4 + angle, ISOMETRIC_PITCH), { width: 420, height: 560 }) });

// Screen preview only: cyan/magenta offset copies, glow, scanlines, on black.
hologramStyle(hypercubeInner({ rotations: [/* … */] }));
```

If two hologram-styled images share one page, give each a different `idPrefix`.

## Limits to state when you report

- **Hidden lines are exact for convex solids only.** An edge is visible if it borders a face turned toward the viewer;
  otherwise it is drawn dashed. For a non-convex part (an L or U section) an edge hidden behind another part of the
  solid can still be drawn solid. Say so when drawing a non-convex part; do not present it as a verified hidden-line view.
- The isometric view in a drawing omits hidden lines (drafting convention) and draws each axis at full length.
- Scenes are axis-aligned boxes only, one isometric camera. Not a general renderer.
- A Pepper's ghost layout and a quilt are inputs for a display; whether the physical display shows them correctly
  depends on its pyramid size and calibration, which this module does not know.

## Proof

`npm run test:projection` (`tests/projection/run.ts`) checks the maths with numbers (isometric axes equal length and
120° apart, cavalier 1 and cabinet 0.5, NDC corners at ±1, homography corners within 1e-9, tesseract degrees and edge
lengths under rotation, drawing edge counts, quilt order) and writes sample SVG/HTML files to a temp directory,
printing their paths. Set `SOLOMON_PROJECTION_DEMO_DIR` to choose the directory.
