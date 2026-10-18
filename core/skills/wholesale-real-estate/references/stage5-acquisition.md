# Stage 5 — Acquisition (comp, offer, contract lock)

Turn an interested seller into a signed, assignable contract at a price that leaves
spread for the wholesaler AND margin for the end buyer.

## Comping (free method)
1. Pull **sold** comparables from Redfin/Zillow: same submarket, similar
   beds/baths/sqft/age, sold in the last 3–6 months, ideally within ~0.5 mi.
2. Take 3–6 solid comps; adjust for size/condition/features. Note the ARV range,
   not a false-precision single number.
3. Gold standard is **MLS** comps via a licensed partner — flag if available.
   Paid alternatives: PropStream, Propelio, PropertyRadar, Privy.

## Repair estimate (tiered)
Use `scripts/deal_calc.py` tiers (light / medium / heavy $/sqft). This is a
budgeting estimate; a real contractor walk-through governs before close. Label it
an estimate.

## The offer math (deterministic — use the script)
Run `python scripts/deal_calc.py` with ARV, sqft, repair tier, desired assignment
fee, and buyer's margin %. It returns:
- **ARV** (from your comps)
- **Estimated repairs**
- **MAO (Max Allowable Offer)** = `ARV × buyer_pct − repairs − assignment_fee`
  (default `buyer_pct = 0.70`, the standard 70% rule; adjust per market/buyer).
- **Suggested contract price** and the **assignment spread**.
Never hand a seller a number you didn't run through the math.

## Contracts (generate real documents)
- **Purchase & Sale Agreement** (seller ↔ wholesaler): fill
  `assets/purchase-and-sale-agreement.md` — include the **assignment clause** ("and/or
  assigns") and an inspection/due-diligence contingency as the exit.
- **Assignment Agreement** (wholesaler → end buyer): `assets/assignment-agreement.md`.
- Send for e-sign via DocuSign / Dotloop / PandaDoc.
- **Generate the required disclosures now** (`assets/seller-disclosures.md`): the
  lead-based-paint disclosure is federally REQUIRED whenever **year built < 1978** —
  auto-include it, plus the state condition form. The seller fills condition answers,
  not you.
- **On any distressed / pre-foreclosure / lien deal**, also generate the
  **Seller Authorization to Release Information** (`assets/seller-authorization-to-release.md`)
  so title can order the loan payoff — without the payoff you can't confirm the deal
  is solvent (payoff vs. MAO). Do this at contract, not at the closing table.
- **Always stamp:** a licensed attorney and the title company must review before
  signature; contract law and required disclosures vary by state. The skill drafts;
  it does not give legal sign-off.
