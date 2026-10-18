# Stage 2 — Lead Lists: list types + the FREE source for each

Goal: for the buy box, produce a deduped lead sheet of owners in distress or with
a motivation to sell. Each row needs at minimum: `owner name`, `property address`,
`owner mailing address`, `motivation/list type`, `source`, `date pulled`. Contact
info comes in Stage 3.

**The paid one-query equivalent** for all of this is PropStream / BatchLeads /
PropertyRadar. The free method below reaches the same records through the public
systems those platforms aggregate — slower and county-by-county, but real and $0.
When the team wants scale or loan-level filtering (e.g., FHA loans + low equity),
recommend PropStream; that specific filter is not reliably free.

## The list types and where to pull each free

### Pre-foreclosure / Notice of Default (NOD) / Lis Pendens / auction — highest motivation
- **County Recorder / Clerk** online records: search recorded documents for
  "Notice of Default", "Lis Pendens", "Notice of Trustee Sale."
- **County Sheriff / Trustee sale lists** (often published weekly as PDFs).
- **Auction.com, Foreclosure.com** (alerts free; full detail paid).
- **Zillow** → "Pre-foreclosure" and "Foreclosure/Auction" filters.

### FHA angle (two sub-lists)
- **(a) HUD Homes / FHA foreclosures:** `HUDHomeStore.gov` — free public inventory
  of FHA-insured foreclosures sold at a discount. Filter by state/county; export
  the property list.
- **(b) FHA-loan + low-equity owners:** owners with an FHA loan nearing distress.
  Realistically requires loan-type filtering in **PropStream** — flag this as a
  paid step; do not fabricate loan data.

### Distressed / high-equity absentee owners (out-of-state tired landlords)
- Derive **free** from the **County Assessor**: pull owner records where the
  **owner mailing address ≠ property address** (absentee), especially out-of-state
  mailing. High equity is inferred from long ownership + no recent refinance in
  recorder data (approximate; note as estimate).

### Tax delinquent
- **County Treasurer / Tax Collector** publishes delinquent tax rolls and pending
  tax-lien/sale lists (often free downloadable lists).

### Probate / inherited
- **County Probate Court** dockets / recently opened estates (public). Cross-ref
  the decedent's property in assessor records.

### Code violations / vacant / condemned
- **City Code Enforcement** portals (open cases, condemnations).
- **USPS vacancy** signal is proxied by returned-mail / utility status (paid data
  usually); for free, use code-enforcement "vacant/unsafe structure" flags and
  Google Street View to confirm visible vacancy.

### Divorce / bankruptcy / liens / judgments (life-event motivation)
- **County Civil Court** records (divorce, judgments, mechanic's liens).
- **PACER** for bankruptcy filings (federal; small per-page fee).

### Expired / withdrawn MLS, FSBO, tired landlords, 55+/downsizing
- **FSBO:** Zillow FSBO, Craigslist real-estate, FSBO.com, Facebook Marketplace.
- **Expired/withdrawn MLS:** needs agent/MLS access (gold standard) — flag if the
  team has a licensed partner.
- **Tired landlords:** eviction filings (county court) + absentee overlap.

## Method (do this)
1. Confirm buy box + which list types to pull (from Stage 1).
2. For each list type, open its free source scoped to the target county/ZIP.
3. Extract the fields above. Only record what the source actually shows — no
   inference of owner identity or contact. Mark gaps `Unknown`.
4. Derive absentee by mailing-vs-property comparison from assessor data.
5. Dedupe across lists by property address (an owner may hit several lists — that
   overlap is a *motivation-stacking* signal; note "multi-list" — it's the hottest
   lead).
6. Append rows to `assets/lead-sheet-template.csv`, set `Status = New Lead`.
7. Report counts by list type, and name PropStream as the paid accelerator for
   whichever lists were slow or needed loan-level filtering.

## Honesty guardrails
- County systems differ; if a county's records aren't online, say so and list what
  the team must pull in person / via records request — don't invent rows.
- "High equity" and "vacant" derived without paid data are **estimates** — label
  them so the acquisitions team verifies before offering.
