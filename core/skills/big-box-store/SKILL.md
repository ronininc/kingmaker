---
name: big-box-store
description: >-
  Build a website for a high-SKU retailer straight from its POS inventory export — grocery, market, bodega, wholesale or restaurant supply, hardware, liquor, party or dollar store. Use WHENEVER the catalogue is too big to hand-author (~200+ items) or the client hands over a product export from Lightspeed/Vend, Square, Clover, Shopify, Toast or any inventory CSV/XLSX. Trigger on "here's our inventory", "product export", "populate the site with our items", "thousands of SKUs", "build the catalogue", "dropdown categories", "make it like Amazon", or a product spreadsheet attached to a site build. Parses and normalises the export, merging the duplicate and misspelt categories a hand-typed POS accumulates; builds dropdown department → sub-category nav and catalogue-wide search; gives EVERY item a swipeable multi-frame gallery generated in-browser from the store's own data at zero cost. Extends website-build-standard. NOT for a small hand-authored product list, a restaurant menu, or a site with no inventory.
---

# Big Box Store

The house method for a store whose catalogue is **too big to hand-author**. Below a
couple of hundred items you write the manifest yourself and use the grocery template in
`website-build-standard`. Above that, the inventory export is the source of truth and
this skill turns it into the site.

Everything in `website-build-standard` still applies — this skill only replaces how the
product catalogue gets built and how product imagery is handled at scale.

The governing constraint, and the reason this skill exists:

> **A 2,000-item catalogue cannot wait on 10,000 photographs.** Ship the complete,
> correct, browsable catalogue now; let real photos land into it over time.

## The rollout intro is standard (the house build animation)

Every big-box-store site opens with the **rollout intro** — a gold-drawn brand wordmark +
loading bar, then two curtains part to reveal the page, with content blocks fading up on
scroll. It's the house signature and it is **not optional**: a high-SKU store looks like a
spreadsheet without it, and the rollout reframes the catalogue as a destination. It's pure
CSS/SVG (no images, no libraries), runs on first paint, inherits the store palette from CSS
variables, and respects `prefers-reduced-motion`.

Paste in `assets/rollout-intro.html` (don't rebuild it): `<style>` in `<head>`, the
`#rollout` markup as the first element in `<body>`, the `<script>` before `</body>`, set the
brand name in the SVG, and add `class="reveal"` to blocks that should fade up. It ships with
the standard companions — an **animated mega-menu** (JS open/close with a close-grace delay +
click-to-pin, never pure `:hover`, which drops the panel before a shopper can reach it),
**swipeable galleries** (hero, lookbook, per-product), and **reveal-on-scroll**. **Optional
Spanish:** set `<html lang="es">` or `data-lang="es"` on `#rollout` and the intro localizes.
Read `references/rollout-animation.md` for the full spec.

## Workflow

1. **Get the export, don't retype the store.** Ask for a product export from their POS —
   Lightspeed/Vend, Square, Clover, Shopify and Toast all produce one. A spreadsheet
   beats any amount of transcription, and it carries SKUs, prices and stock you would
   otherwise invent.
2. **Parse it with `assets/parse-export.py`.** It matches columns by name (not position)
   across vendors and emits `catalogue.json` plus a `media-manifest.csv`. Read the parse
   log out loud in your head before continuing — see below.
3. **Review the category tree before you build anything.** This is the step people skip
   and regret; see *Categories are always dirty*.
4. **Build the catalogue UI** from `assets/catalogue-ui.html` — dropdown department →
   sub-category nav, search, sort, availability filter, paged grid.
5. **Wire every item to a gallery** using `assets/product-frames.js` plus the
   `product-gallery-kit.html` from `website-build-standard`.
6. **Verify by rendering** — item count matches the log, every department opens, search
   returns, a gallery swipes, zero JS errors.
7. **Deliver with the honest numbers**: how many items, how many priced, how many with
   stock, how many real photographs versus generated frames.

Read `references/pos-export-parsing.md` before touching an export.
Read `references/generated-frames.md` before touching product imagery.

## Categories are always dirty

A POS category tree is typed by hand at a register, by different people, over years. It
always contains the same three problems, and shipping them makes the client's store look
disorganised in a way their physical shelves are not:

- **Spelling variants of one shelf** — `CHAROLA CRITALINA` / `CHOLA CRISTALINA` /
  `CHAROLA CRISTALINA` are one shelf with three typos.
- **Pluralisation splits** — `VASO DELI` (9 items) and `VASOS DELI` (4) are one shelf
  that now looks like two half-empty ones.
- **Uncategorised stock** — often 5–10% of the catalogue, and it cannot be silently
  dropped or silently dumped into a real department.

The parser folds accents, plurals and spacing to a signature and merges variants,
keeping the **most common spelling** as canonical. It counts every merge in the log.

**The merge is a suggestion, not a fact.** Read the resulting tree before building. The
fold is deliberately conservative, but only a human knows whether `VASO FOAM` and
`VASO FOAM ALIMENTOS` are one shelf or two. Uncategorised items go to their own visible
department — never hidden, never guessed into a real one.

## Product imagery at catalogue scale

Read `references/generated-frames.md` for the full rules. The short version:

**Every item gets 5 swipeable frames on day one**, generated as SVG in the browser from
the store's own export: product plate, pack/size, specification, price & availability,
and an open slot that asks for the real photograph. They cost nothing to host, add no
files and no bandwidth, and scale to any catalogue size.

Three rules that are not negotiable:

- **A generated frame may only state a fact present in the export.** No invented pack
  sizes, no invented prices. Where a fact is missing the frame says it is missing — "Pack
  size not in the export, ask at the counter" — which is useful and true.
- **Generated frames are never presented as photographs.** They are drawings and data
  cards, they look like data cards, and the site says so in plain language.
- **Real photos always outrank generated frames** and take index 0, so the card, the
  collection tile and the hero pull a real photograph the moment one exists.

Do **not** hotlink product images scraped from search results to fill the gap. They rot,
the rights are unclear, and — the reason that matters most — you cannot look at 10,000 of
them, which means shipping wrong pictures at scale. A generated card that is honestly a
card beats a photograph of the wrong product.

## Never invent commerce facts

The export is the store's own data and the site inherits its authority. That cuts both
ways:

- **No price in the export → "Ask in store."** Never interpolate from a similar item.
- **Stock is a snapshot, not a promise.** Show "In stock" / "Check availability", never a
  live-looking count that will be wrong within a day.
- **Inactive items stay off the site** unless the client says otherwise.
- **"New arrivals" / "this week" sections must be store-set.** Never populate a freshness
  claim by rule — newest key, first item per category, alphabetical. Ship the section with
  a `CONFIRMED` flag defaulting to false, and until the store confirms, the headline asks
  rather than announces: "Ask us what just came in", not "What's landing this week."

## Deliver with the arithmetic visible

State the real numbers in the footer and the README — items parsed, priced, in stock,
real photographs versus generated frames, and what the parse log skipped or merged. A
client who can see that 1,948 of 2,152 rows are live and 130 are uncategorised trusts the
site. A client who later discovers a silent gap does not.
