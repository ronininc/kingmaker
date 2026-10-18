# Logos / Brand Marks

Build brand crests as **scalable SVG** by default — crisp at any size (favicon to
jumbotron), tiny file (a few KB), and animatable (e.g. glowing/flickering accents via
SMIL, which plays even when the SVG is used in an `<img>`). Use a raster only if the client
supplies one.

## Method that works
1. **Match the client's reference geometry first.** If they share a reference mark, copy its
   *angles and composition* (helmet-in-ring, crossed weapons, wordmark lockup, etc.) before
   coloring. Get the silhouette right, then recolor.
2. **Build reusable pieces with `<defs>` + `<use>`.** Define a shape once (e.g. a helmet
   path, a spear group) and place it multiple times. For a two-tone / half-and-half split,
   render the same path twice with two `clipPath` halves and different fills.
3. **Render and LOOK before shipping.** An ugly logo is a failed logo. Render the SVG to PNG
   with headless Chromium (inline the SVG into a page, screenshot it), view it, and iterate
   2–3 times. Fix what reads wrong: hidden weapons behind the mark, floating/disconnected
   crests, muddy detail at small size.
4. **Test at real size.** It usually lives small (nav ~40–48px). Confirm it still reads
   there, not just at 512px.

## Placement & swappability
- Place per client instruction (a common one: top-left corner only — then do NOT also put
  it in the footer/hero).
- Wrap the nav logo in `<span class="logo-slot"><img class="crest" src="./assets/logo.svg"></span>`
  so the media-editor kit registers it as swappable (drop a new `logo.svg`/PNG to replace).

## Color
- Prefer the team/brand palette. A hard half-and-half split (left color / right color with a
  center seam) reads as strong team identity. Metallic gold reads as a premium league badge.
- Gradients (`linearGradient`) add depth; `radialGradient` + a blur `filter` makes glowing
  eyes/accents. Keep accent animation subtle (a 2–3s opacity flicker loop).

## What NOT to do
- Don't fabricate a photoreal render — you can't generate raster art in this environment.
  If the client wants photoreal 3D, say so plainly and offer the clean SVG (or let a designer
  paint from it).
- Don't leave a raster dependency the client can't edit; SVG source is theirs to tweak.
