# Manifest schema

The workspace renders entirely from `window.LISTINGS` (inline in the page, or set by an
external `./listings.js` that Export produces). One array; one object per item.

```js
window.LISTINGS = [
  {
    id: 'camelback',                 // unique slug — also the deep-link (#camelback) = its "page"
    name: 'Camelback Assemblage',
    strategy: 'Estates',             // primary tag (drives the filter chips)
    market: 'Arizona',               // secondary tag
    location: 'Paradise Valley · Camelback corridor',
    kpi: { v: '$48.0M', l: 'Gross value' },   // the headline number on the card
    media: {
      hero: 'assets/camelback-hero.jpg',      // image OR .mp4/.webm (auto-detected)
      gallery: ['assets/camelback-1.jpg', 'assets/camelback-2.jpg']
    },
    stats: [                          // stat tiles in the focus drawer
      { v: '12,400 sf', l: 'Improved area' },
      { v: '14.2%',     l: 'Target IRR' }
    ],
    evidence: [                       // THE POINT — every row sourced + status-tagged
      { k: 'Acquisition basis', val: '$31.6M', s: 'Recorded deed · Maricopa County', status: 'verified' },
      { k: 'Stabilized value',  val: '$48.0M', s: 'Third-party appraisal · 2026',    status: 'verified' },
      { k: 'Projected IRR',     val: '14.2%',  s: 'Underwriting model v3',           status: 'modeled'  },
      { k: 'Exit timing',       val: '2034',   s: 'Business plan · under review',    status: 'pending'  }
    ]
  }
  // …more items
];
```

## Evidence status — the rule

| status     | meaning                                             | color | use when |
|------------|-----------------------------------------------------|-------|----------|
| `verified` | A document, proof, or record backs this exact value | cyan  | deed, appraisal, executed contract, passing proof |
| `modeled`  | A projection / assumption, not yet realized         | blue  | underwriting, pro-forma, scenario output |
| `pending`  | Claimed but not yet backed                          | gold  | draft term sheet, "under review", not-yet-closed |

Never tag a value `verified` without a real source in `s`. This is the whole discipline: the
UI makes an unsourced claim *look* unsourced. A number with no evidence row should not appear.

## Media naming (what Export writes)

The boot-prompt names files `‹id›-hero.‹ext›`, `‹id›-1.‹ext›`, `‹id›-2.‹ext›` … Drop them into
`/assets` (keep names) and the exported `listings.js` already points at them. Hero videos: keep
to **10–20s and under ~15MB** so first load is instant.

## Node-map variant

For the "explore the system" shape (`node-map-variant.html`), each item is a node:

```js
{ id:'internet', name:'Native Internet', status:'hold',      // ok | hold | defer
  statusText:'Native proven · external on config-hold',
  desc:'Plain, non-secret explanation of what this part does.',
  evidence:[ { k:'Native retrieval', s:'proof: internet', st:'ok' } ],
  sealed:'What is governance-withheld here (never disclosed).' }   // optional
}
```

The Q&A responder fails closed on a secret-topic regex (weights, keys, credentials, source,
prompts, training data). To make it real, set `window.SOLOMON_ENDPOINT` and provide
`window.sendToSolomon(question) → Promise<{text, seal}>`.
