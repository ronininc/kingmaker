# INTEGRATION NOTE — Items 9 + 10 parts, OVERLAY BASE (UNAPPLIED)

Built 2026-11-04 in this overlay work copy
(`armor-remainder-run-2026-11-04/work/item-09-10/overlay-copy/`), copied
read-only from the Item 1 agent's clone at
`work/item-01/kingmaker-450e3af8/scripture-armor/` (kingmaker main
`450e3af8`, Armor v1.2.1). That commit carries the owner's DO NOT MERGE
hold — nothing here is merged, pushed, deployed, or published. The
earlier v2-based parts (`../armor-copy/`) are superseded by this port;
the v2 wiring (scan.mjs data branch) is NOT needed here because the
overlay reader is `agnostic-review.mjs`.

## Part A — Little Brother integration (`littlebrother-integration.mjs`)

Unchanged module (tree-agnostic interface; see `../armor-copy/`
integration note Part A for the governance description). Overlay apply
steps:
1. Copy `littlebrother-integration.mjs` into the subtree root; it is
   already added to `package.json` `files` in this copy.
2. Host-side attach points in THIS tree (never inside the sandbox
   worker — the worker must stay network-free):
   - `dashboard.mjs`, where `reviewUploadedFile` results return: run
     `enrichScanRecord()` over a record-shaped view of the review
     findings (`embedded-endpoint` rules) and append enrichment
     findings to the presentation layer only.
   - `device-protection.mjs`: its `analyze(copy)` callback boundary —
     after `analyze` returns, endpoint indicators from the analysis
     may be enriched the same way. Device state already carries
     `wholeDeviceCoverageVerified: false`; enrichment changes nothing
     about coverage claims.
3. Set `SCRIPTURE_ARMOR_LB_MODULE` to the installed LB module path
   (Kingmaker payload `lib/stack-littlebrother/littlebrother.mjs`);
   unset = named `littlebrother-not-wired` refusals, by design.
4. Transport decision is the owner's/host's: LB ships no network code;
   without an injected transport, enrichment records refusals.

## Part B — $99/month labeling (overlay product surface)

Changed in this copy:
- `product.json`: added a `pricing` block { amountUsd 99, termMonths 1,
  termLabel 'month', display '$99/month', licence rule, source ruling,
  status UNAPPLIED-COPY-ONLY }. **`schema` and `product` are untouched**
  — `product-paths.mjs:7` hard-validates them (`kingmaker`|`standalone`)
  and throws otherwise; verified live in tests (ARMOR_PRODUCT still
  resolves to 'kingmaker').
- `package.json` `files`: `format-inspect.mjs`,
  `littlebrother-integration.mjs` added.
- No price text existed anywhere else in the overlay subtree (README,
  SHIP-SHEET, terms, paid-activation, entitlement-client: zero price
  mentions), so `product.json` is the product surface to label. The CRM
  funnel remains the implementation of record — do not edit it from
  here.
Apply: port `product.json` + `package.json` hunks; confirm any future
store/listing surface renders from `pricing.display` rather than
hardcoding a figure.

## Part C — Format-coverage lane (`format-inspect.mjs` + agnostic port)

Changed in this copy:
- `format-inspect.mjs` added, with an overlay adapter
  `agnosticAugment(buf, name)` translating the lane's records into the
  reader's { format, limitations[], activeContent } shape.
- `agnostic-review.mjs` patched at three branches only:
  (1) PDF branch — the reader's own limitation is retained, and the
  lane's structure/text-layer detail is merged in;
  (2) media branch — named formats (PNG/JPEG) + metadata limitations
  (incl. trailing-data) replace the signature-only line when the lane
  recognizes the file; GIF/RIFF keep the original line (lane does not
  cover them);
  (3) opaque fallthrough — TAR/GZIP get named listings, RAR/7z/OLE get
  named UNSUPPORTED limitations with reasons, WASM/unknown-binary get
  header-indicator limitations; unrecognized opaque data keeps the
  original generic line.
  The ZIP branch is deliberately NOT shadowed: the overlay reader
  already extracts and routes entry texts itself.
Proof in this copy: `test/run-tests-overlay-wiring.mjs` 14/14,
`test/run-tests-format-coverage.mjs` 41/41, and the subtree's own
`test/agnostic-review.test.mjs` 4/4 (no regression). A full subtree
suite run on the target tree remains an apply-step requirement.
