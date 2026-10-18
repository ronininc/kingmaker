# Rollout intro — the standard big-box build animation

Every big-box-store site opens with the **rollout intro**: a gold-drawn brand
wordmark and a loading bar, then two curtains part to reveal the page while
content blocks fade/slide up on scroll. It is the house signature — the first
half-second that tells a shopper this store was built with care.

Use `assets/rollout-intro.html` — paste it in, don't rebuild it.

## Why it's standard

A high-SKU store can look like a spreadsheet. The rollout does the opposite: it
frames the catalogue as a destination. It costs nothing (pure CSS/SVG, no
images, no libraries), runs on first paint, and respects
`prefers-reduced-motion` (no motion, instant reveal) so it never hurts
accessibility or perceived speed.

## Wiring (from `assets/rollout-intro.html`)

1. `<style>` block into `<head>`.
2. `#rollout` markup as the **first** element in `<body>`.
3. `<script>` before `</body>`.
4. Set the brand name in the SVG `<text>` (replace `BRAND`).
5. Add `class="reveal"` to any section/block that should fade up on scroll.

The animation inherits the store palette from CSS variables (`--ink`,
`--whiskey`, `--gold`, `--gold-lite`). Set those to the store's colors and the
rollout matches automatically — no per-store restyle.

## The premium chrome that ships with it

The rollout is the opener; these are the standard companions (all palette-driven,
all in the same house build):

- **Animated mega-menu navigation.** Department → sub-category dropdowns with a
  staggered link reveal, an underline sweep on the top item, and a featured
  image tile. Drive open/close with JS (hover + a ~240ms close grace delay +
  click-to-pin + click-outside/Escape) — never pure `:hover`, which drops the
  panel before the shopper can reach it.
- **Swipeable galleries everywhere.** Hero slideshow, a full-bleed lookbook, and
  a swipeable gallery on every product card (arrows, dots, touch-swipe).
- **Reveal-on-scroll** on section blocks (the `.reveal` class above).

## Optional Spanish (i18n)

Many big-box shoppers are Spanish-first. The rollout ships bilingual:

- Set `<html lang="es">` **or** add `data-lang="es"` to `#rollout`.
- The tagline and the SVG's accessibility label switch to Spanish
  (`ROLLOUT_STRINGS.es`). Any other value stays English.
- Add more languages by extending `ROLLOUT_STRINGS`.

This only localizes the intro. For a fully bilingual storefront, carry the same
`lang`/`data-lang` convention into the nav labels and section copy.

## Don't

- Don't gate the reveal behind heavy assets — the curtains part on `window
  load`; keep above-the-fold light so that fires fast.
- Don't remove the reduced-motion fallback.
- Don't hard-code the palette into the animation — keep it on the CSS variables
  so one palette change reskins the whole opener.
