---
name: graphite
description: Make 2D vector and raster art with Graphite — graphic design, digital illustration, logos, posters, and node-based procedural and real-time motion graphics (graphite.art). Use when the owner wants real editable artwork or a procedural graphics pipeline, not a one-shot generated image (for a quick picture, Kingmaker's own image lane is faster).
metadata:
  version: "1"
---

# Graphite

Graphite is a free, open-source 2D content-creation app: graphic design, digital art,
and node-based procedural and real-time motion graphics (https://graphite.art,
https://github.com/GraphiteEditor/Graphite, Apache-2.0). Unlike a one-shot generated
image, its output is a real, editable document and a node graph you can re-run and tweak.

## When to use it

- The owner wants editable vector art: a logo, a poster, an icon set, an illustration —
  something to refine, not a frozen PNG.
- A **procedural** pipeline: a node graph that takes inputs and produces artwork you can
  change by changing a parameter, or drive in real time.
- For a quick picture with no editing, prefer Kingmaker's own image lane (the "make a
  poster…" path) — it's faster and needs nothing installed.

## How Kingmaker drives it

Graphite is primarily a canvas app (desktop/web) built on a node-based procedural engine.
Kingmaker's role is to set up the document and the node graph for the kind of art asked
for, then hand the owner an editable file they can open and refine in Graphite.

1. **Install (owner-approved).** Graphite runs in the browser at https://editor.graphite.art,
   or as a desktop build from the upstream releases. Installing or opening it is an
   owner-approved step, surfaced on Kingmaker's setup screen like any tool.
2. **Set up the piece.** Decide vector vs raster, the canvas, and the node graph for the
   effect (procedural fills, repeats, distortions, real-time inputs). Build it as a
   Graphite document.
3. **Hand off.** Save the document into Kingmaker's output folder (it shows in the
   Artifacts tab) and open it in Graphite for the owner to refine. Export to SVG/PNG when
   they want a flat file.

## Boundary

Graphite is for art the owner owns or is free to make. It runs locally (or in the owner's
browser); nothing is published or sent anywhere without the owner's go, like any
Kingmaker action. The node graph and the saved document are the deliverable, so the work
stays editable and the owner keeps it.

## Output

Report: what was made (vector/raster, the node graph's shape), where the document was
saved (Artifacts), and how to open and refine it in Graphite.
