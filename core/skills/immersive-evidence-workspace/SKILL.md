---
name: immersive-evidence-workspace
description: >-
  House standard: every site's interactive centerpiece is an immersive, futuristic AR
  workspace of the product line. Products sit on a holographic table as glowing
  ring-pedestals; select one to zoom in and ENTER its space (details + sourced evidence +
  media), or walk it in 3D. Builder-editable before deploy, locked for visitors after;
  driven by one manifest and tuned to each product line's nature. Use for any
  portfolio/product/listing site, showcase, evidence or data room, or an "explore the
  system" map (e.g. the Kingmaker brain). Also use when a client uploads their own
  photos/videos into fixed slots via a guided boot-prompt and the render becomes their files
  live. Trigger on: AR workspace, make it immersive, walkthrough, enter the space, select to
  see evidence, explore the system, multiple listings across pages, let the client upload
  media, boot prompt for uploads, same way as the workspace.
---

# Immersive AR Product Workspace — house standard

Every site's interactive centerpiece is an **AR workspace of the product line**, not a flat
grid. It reads like a holographic table (a digital twin) with each product on a glowing
ring-pedestal. The visitor explores the table, then **selects a product to zoom in and enter
its space**. Spatial products (real estate, venues, builds) also offer a first-person
**walkthrough**.

## Three laws (non-negotiable)

1. **Select → enter → evidence.** Selecting zooms into the product and opens its space:
   media, specs, and an **evidence** list where every figure carries a **source** and a
   **status** — `verified` (cyan), `modeled` (blue), `pending` (gold). Never a bare number.
2. **Builder before deploy; visitors never edit after.** Add/remove/edit + media upload are
   gated to `file://`, `localhost`, or a private `#edit`/`#setup` link. On the public domain
   the tools don't exist. Edits **Export** a manifest + media named for `/assets`; drop in,
   redeploy. Editable for you before deploy, locked after.
3. **Manifest-driven, static, self-contained.** One manifest; no framework/server; deploys to
   Cloudflare Pages. Tune to the product line's nature (see below).

## Templates (pick by product nature)

- `assets/ar-workspace-template.html` — **the default.** Holographic table + ring-pedestals;
  select a product to enter its space; a `walk` URL per product enables the 3D walkthrough.
- `assets/workspace-template.html` — listings/portfolio evidence explorer (spatial cards +
  evidence drawer) when a table metaphor is overkill.
- `assets/node-map-variant.html` — the "explore the system" shape: an AR brain
  schematic; select a region to zoom in and reveal that engine's orb + evidence; governed
  Q&A that **fails closed on secrets**.

## Tune per product line

Set each product's `type`, `kpi`, `specs`, `evidence`, media slots, and a `walk` URL for
anything physically walkable. Real estate → estates/units with 3D walkthroughs. Physical
goods → a product on a pedestal you rotate/enter. A system/app → the node/brain map. The
holographic table + select-to-enter + sourced-evidence pattern stays constant; the objects
and whether "enter" launches a walkthrough or a detail space change per nature.

## Build order

1. Read `website-build-standard` first — this is the immersive layer on top of it.
2. Copy the fitting template; replace the `PRODUCTS`/`LISTINGS` manifest
   (`references/manifest-schema.md`).
3. Wire the builder media boot-prompt (built in) — it lists every media slot across every
   product, grouped, so one flow fills many across pages. Each product deep-links `#id`.
4. Link the AR workspace as the site's primary interactive entry (nav + hero).
5. Verify with headless Chromium: table renders, select zooms + opens the space, walkthrough
   link present for spatial items, builder tools absent on a simulated host + present locally,
   zero JS errors.

## Reskin

CSS variables (`--cyan/--blue/--violet`, `--verified/--modeled/--pending`). Swap for the
client palette; keep the three status colors distinct — they carry meaning.
