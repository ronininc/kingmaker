# Generated product frames

## Why

A 2,000-item catalogue needs ~10,000 photographs to be fully illustrated. That is not a
task you finish before launch, and paid product-image APIs add a recurring cost the
client did not ask for. So every item gets **five swipeable frames generated in the
browser from the store\'s own export**:

1. **Product plate** — category-tinted, the item name set large, the shelf named
2. **Pack / size** — the quantity or dimension parsed out of the product name
3. **Specification** — SKU, brand, supplier, category
4. **Price & availability** — retail price and stock state
5. **Open slot** — a dashed frame that asks for the real photograph

They are SVG data-URIs built at render time: **no files, no bandwidth, no service, no
recurring cost**, and identical effort for 50 items or 5,000.

## The three rules

**1. A frame may only state a fact present in the export.** The pack parser reads
`200pz`, `8x8x1`, `190 ml`, `4.4 lb` out of the product name. When it finds nothing the
frame says so — *"Pack size not in the export — ask at the counter"* — which is true and
useful. It never guesses a pack size, and it never interpolates a price from a similar
item.

**2. Generated frames are never dressed as photographs.** They look like data cards
because they are data cards, and the site says so in plain language in the footer. The
failure this prevents is a client believing they have product photography when they do
not.

**3. Real photographs outrank generated frames.** `buildFrames()` puts anything in
`window.PRODUCT_PHOTOS[key]` first, so index 0 — the frame the card, the collection tile
and the hero all pull — becomes a real photo the moment one exists. The open-slot frame
drops off automatically once a real photo is present.

## Wiring

    <script src="product-frames.js"></script>
    <script>
      window.PRODUCT_PHOTOS = { "masa": ["assets/ref/masa-1.jpg"] };  // optional, real photos
      // per card:
      el.setAttribute("data-gal", JSON.stringify(buildFrames(item)));
    </script>

Then mount with the gallery kit from `website-build-standard`. Frame counts stay under
the 6-frame dot threshold, so cards get dots rather than a thumbnail rail — correct for a
dense grid.

Palettes are keyed by department slug in `PAL`. Add an entry per department so each
reads distinctly at a glance; the default grey is a fallback, not a design.

## Replacing generated frames with real photography

The `media-manifest.csv` from the parser is the work order — key, name, SKU, brand,
supplier, and empty photo columns. Fill it in over time and the frames retire themselves.

Sequence the work by value, not alphabetically: **items that have both stock and a price
first**, since those are what people actually buy. A store shooting its own shelves with
a phone can clear a few hundred items an afternoon, and the site improves item by item
with no rebuild and no redeploy.

Apply the photo QA gate from `website-build-standard` to every photo that lands: the pack
rather than the plated result, the product actually named, and every frame in a set the
same product.
