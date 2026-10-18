# Parsing a POS inventory export

## Get an export, never retype the store

Every POS worth the name exports the catalogue. Ask for it by name:

| POS | where |
|---|---|
| Lightspeed / Vend | Catalog → Products → Export |
| Square | Items & Orders → Items → Actions → Export Library |
| Clover | Inventory → Items → Export |
| Shopify | Products → Export → CSV |
| Toast | Menus → bulk management export |

A spreadsheet beats transcription every time: it carries SKUs, prices, stock and
supplier that you would otherwise have to invent or omit.

## Run the parser

    python3 assets/parse-export.py export.xlsx \
        --out catalogue.json --manifest media-manifest.csv

It matches columns **by name, not position**, so vendor differences mostly vanish. If it
cannot find a product-name column it exits and prints the columns it saw — map a new
alias into `ALIASES` at the top of the script rather than reshaping the client's file.

Outputs:

- **`catalogue.json`** — `{items, tree, log}`. The site reads this directly.
- **`media-manifest.csv`** — one row per item with empty `photo_1..photo_5` columns, plus
  brand and SKU. This is the work order for sourcing real photography later.

## Read the log before you build

    parse log : {'kept': 1948, 'skipped_inactive': 204, 'category_merged': 252,
                 'category_missing': 130, 'no_price': 65, 'key_collision': 31}

Every number is a decision you are about to ship:

- **`skipped_inactive`** — inactive items are dropped. Confirm the client agrees; some
  stores mark seasonal stock inactive and still want it listed.
- **`category_merged`** — spelling variants folded together. Review the printed tree.
- **`category_missing`** — items with no category at all. They go to a visible
  `UNCATEGORISED` department. Never hide them, never guess them into a real one.
- **`no_price`** — these render "Ask in store". Never interpolate a price.
- **`key_collision`** — duplicate handles/names got a `-2` suffix. Usually genuine
  duplicates in the POS; worth telling the client, since it is often a data-entry bug
  on their side that also affects their register.

## The category fold, and its limits

Categories are typed at a register by different people over years. The parser builds a
signature per category path — accents stripped, spacing removed, plurals folded — and
merges everything sharing a signature, keeping the **most common spelling** as canonical.

That catches the three real-world cases:

- typos: `CHAROLA CRITALINA` / `CHOLA CRISTALINA` → `CHAROLA CRISTALINA`
- plural splits: `VASOS DELI` → `VASO DELI`
- accent and spacing drift

**It is a suggestion, not a fact.** The fold cannot know whether `VASO FOAM` and
`VASO FOAM ALIMENTOS` are one shelf or two — different signatures, so it leaves them
apart, which may or may not be right. Read the printed tree before building, and hand-map
anything the fold got wrong.

For a bilingual site, pass `--names names.json` mapping each raw category to an English
display name. The store\'s own Spanish stays as they wrote it; English is the translation
layer, never a replacement.

## Sanity checks before you build

1. items kept + skipped == rows in the file
2. no department holds more than ~40% of the catalogue (usually a category fold gone wrong)
3. no sub-category with a single item that should have merged
4. price coverage matches what the client expects
5. spot-check ten random items against the spreadsheet by SKU
