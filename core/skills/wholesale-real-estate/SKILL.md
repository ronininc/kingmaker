---
name: wholesale-real-estate
description: >-
  The house wholesale real-estate deal engine — same shape as our Owner.com /
  custom-lead-generator skill, but for distressed / FHA / motivated-seller deals.
  Runs the full 7-stage lifecycle: market & criteria setup, lead sourcing / list
  pull, skip tracing, outreach & marketing, acquisition (comp, offer, contract
  lock), dispositions (find the cash buyer), assignment & close. At each stage it
  replicates what the paid platforms do (PropStream, DealMachine, REsimpli,
  InvestorLift) using free / public data and browsing, and names where a paid tool
  does it faster. Use WHENEVER the task involves wholesale real estate, motivated
  sellers, distressed or off-market property, pre-foreclosure / NOD / tax-delinquent
  / probate / absentee / vacant / FHA / HUD-home lists, pulling a lead list, skip
  tracing owners, comping / ARV / MAO, writing a purchase or assignment contract,
  building a cash-buyer list, or blasting a deal to buyers — even if they never
  says "wholesale." Never fabricates owner or property facts; gaps = Unknown.
---

# Wholesale Real Estate Deal Engine

This skill is a working wholesale real-estate operation, packaged. It runs the
industry's standard 7-stage deal lifecycle and, at each stage, **does the work the
paid platforms do** — pulling lists, skip tracing, comping, drafting contracts,
building buyer lists — using free and public data sources plus browsing, and it
tells the user where a paid tool would do the same thing faster or at larger scale.

Think of it the way `custom-lead-generator` (our Owner.com engine) works for
restaurants: it *finds and qualifies*, then *produces the deliverable*, and it
never invents facts. Same doctrine here.

## Prime directives (read first, they govern everything)

1. **Never fabricate.** Owner names, phone numbers, mailing addresses, loan
   balances, sale prices, repair costs — if it isn't confirmed from a real source
   this run, mark it `Unknown` or `VERIFY`, never a plausible-looking guess. A
   made-up phone number is worse than a blank one. This is the same rule the
   lead-gen engine runs on.
2. **You are not the lawyer, broker, or closer.** Wholesaling legality, licensing,
   contract enforceability, and required disclosures vary by state and are
   changing fast. Produce the work product, then flag what a licensed
   attorney / title company / local counsel must confirm. See
   `references/compliance-and-legal.md` before any outreach or contract stage.
3. **Respect contact law.** Cold calls and texts are governed by TCPA, the DNC
   registry, and 10DLC SMS registration. The skill drafts campaigns and scripts
   and scrubs against known constraints, but the user's team is responsible for
   DNC scrubbing and carrier registration. Details in
   `references/compliance-and-legal.md`.
4. **Free-first, paid-aware.** Always attempt the public-data method. Then name the
   paid platform that does it better and say why, so the team can decide where to
   spend. The platform directory with current pricing is
   `references/platform-directory.md`.

## The 7 stages

```
1. Market & criteria setup
2. Lead sourcing (list pull)     ← distressed / FHA / motivated-seller lists
3. Skip tracing (get contact info)
4. Outreach / marketing (make contact)
5. Acquisition (comp, offer, contract lock)
6. Dispositions (find the cash buyer)
7. Assignment & close (title / TC)
```

A CRM / pipeline tracker runs across all of them — it is the spine. Start every
engagement by creating or updating it (see "The CRM spine" below).

You do not always run all seven. Match the stage(s) to the request: "pull a
pre-foreclosure list for 85015" is Stages 1–2; "what's my max offer on 123 Main"
is Stage 5; "find buyers for this contract" is Stage 6. When the user asks to run
"a deal end to end" or "onboard the team," run the whole chain and keep the CRM
updated between stages.

Each stage below is a summary. The detailed method — exact free sources, the
extraction steps, the paid fallback — lives in the matching `references/` file.
**Read the stage reference file before executing that stage**; they hold the parts
that keep the output correct.

---

### Stage 1 — Market & criteria setup
Establish the buy box before pulling anything, or the list is noise. Capture:
target county/city/ZIP(s); property type (SFR, 2–4 unit, etc.); price/ARV band;
condition appetite; which motivation lists to pull; and the exit (assign to cash
buyer, novation, etc.). If the user hasn't given these, ask for the few that
change the output, then proceed with stated assumptions if unattended. Write the
buy box into the CRM header. Full checklist: `references/stage1-setup.md`.

### Stage 2 — Lead sourcing (the "who to target" layer)
This is the distressed / FHA / motivated-seller sourcing. The list types and the
**free public source for each** (county recorder, tax collector, probate court,
code enforcement, HUDHomeStore.gov, Zillow/Redfin filters, etc.) plus the paid
one-query equivalent (PropStream, BatchLeads, PropertyRadar) are in
`references/stage2-lead-lists.md`. Method: for the buy box, work each requested
list type from its public source, extract `owner name + property address + mailing
address + distress signal + source`, dedupe across lists, and write rows to the
lead sheet (`assets/lead-sheet-template.csv`). Absentee is derived for free by
comparing the assessor's owner **mailing** address to the **property** address.
FHA angle = HUDHomeStore.gov (free FHA-foreclosure inventory) **plus** loan-type /
low-equity filtering, which realistically needs PropStream — say so.

### Stage 3 — Skip tracing (name → phone / email)
Turn owner names into contact info. Public-data method (people-search
aggregators + county records) and its accuracy ceiling, plus the bulk paid
options (BatchSkipTracing, IDI/LexisNexis) are in
`references/stage3-skip-tracing.md`. Populate contact columns in the lead sheet;
anything not confirmed stays `Unknown`. Never synthesize a phone number.

### Stage 4 — Outreach & marketing (make contact)
Produce the campaign, not just advice: ready-to-send SMS sequences, cold-call
scripts, and direct-mail letters/postcards, tuned to the motivation list. Assets
in `assets/outreach-scripts.md`; channel/compliance rules and the paid senders
(Launch Control, Smarter Contact, Mojo, BatchDialer, Carrot for inbound) in
`references/stage4-outreach.md`. If the session has Gmail/SMS/other connectors,
the skill can draft/queue real sends — but only after the compliance flags in the
reference are acknowledged.

### Stage 5 — Acquisition (comp, offer, contract lock)
Comp the property from public sold data (Redfin/Zillow), estimate repairs by tier,
and compute ARV → MAO → max allowable offer and assignment spread with
`scripts/deal_calc.py` (so the math is deterministic, not eyeballed). Method and
the 70%-rule logic: `references/stage5-acquisition.md`. Then generate the two core
documents from `assets/purchase-and-sale-agreement.md` and
`assets/assignment-agreement.md`, filled with the deal's terms, ready for e-sign
(DocuSign/Dotloop). Always stamp: attorney/title must review before signature.

### Stage 6 — Dispositions (find the cash buyer)
Build a cash-buyer list for free from public records (recent cash / absentee
purchases in the area = active investors) and produce the deal marketing package:
a one-sheet (`assets/deal-one-sheet.md`) and a buyer blast (email + SMS). Method
and the paid marketplaces (InvestorLift, Deal Run, InvestorBase, Privy) in
`references/stage6-dispositions.md`. This is where teams underinvest — treat the
buyer list as an asset that compounds; keep it in the CRM.

### Stage 7 — Assignment & close (title / TC)
Assemble the full closing packet: assignment agreement, seller
authorization-to-release (so title can order the payoff on distressed deals), the
required disclosures, the payoff-vs-MAO solvency check + trustee-sale deadline, a
closing checklist, and the title/TC handoff. A deal is not "closing-ready" until
the packet has every item in the **"closing packet MUST contain"** list in
`references/stage7-close.md`. Establish the investor-friendly title company /
closing attorney (a vendor, not a tool — flag as a per-market setup task).

---

## The CRM spine (runs across all stages)

Every deal moves through a pipeline; the tracker is the source of truth. Use
`assets/lead-sheet-template.csv` — its columns cover all seven stages (lead source,
owner, property, contact, motivation, stage/status, comp/ARV/MAO, offer, buyer,
close). Create it at Stage 1, append at Stage 2, enrich at Stage 3, log outreach
at Stage 4, and advance the `Status` field as deals move. When the user's team
graduates to a real CRM, the standards are REsimpli / InvestorFuse / FreedomSoft /
REI BlackBook / Podio — see `references/platform-directory.md`. The CSV maps
1:1 to those tools' import fields on purpose.

## How to run an engagement

1. Create/update the CRM tracker and write the buy box (Stage 1).
2. Read the reference file for each stage you're about to run.
3. Execute the free/public method; mark unverifiable data `Unknown`/`VERIFY`.
4. Produce the stage's deliverable (list, contact-enriched sheet, campaign,
   comp+contract, buyer package, closing packet) as an actual file, and hand it
   over with `SendUserFile`.
5. Name the paid platform that would do this stage faster/at scale, and why.
6. Advance the CRM `Status`. Repeat for the next stage.

## What "as close to the platforms as possible" honestly means

The skill can genuinely replicate: list-building from public records, absentee
detection, best-effort skip tracing, comp/ARV/MAO math, contract generation,
cash-buyer discovery, and campaign creation. It **cannot** replicate: proprietary
bulk-data licenses (millions of scored records in one query), guaranteed
skip-trace hit rates, one-click multi-thousand SMS blasts on registered numbers,
or a paid buyer marketplace's private network. Where it hits those ceilings it
says so plainly and points to the paid tool — never pretends the free method
equals the paid one. Overclaiming here costs the team real money and legal risk,
so accuracy about capability is part of the job.

## Reference & asset index
- `references/compliance-and-legal.md` — state legality, licensing, TCPA/DNC/10DLC, disclosures. Read before Stages 4, 5, 7.
- `references/platform-directory.md` — every platform by stage, with function and current pricing.
- `references/stage1-setup.md` … `references/stage7-close.md` — per-stage method.
- `references/stage2-lead-lists.md` — list types + free source for each (the heart of sourcing).
- `assets/lead-sheet-template.csv` — the CRM/pipeline tracker.
- `assets/outreach-scripts.md` — SMS / cold-call / direct-mail copy by motivation.
- `assets/purchase-and-sale-agreement.md`, `assets/assignment-agreement.md` — contract templates (attorney-review stamped).
- `assets/seller-authorization-to-release.md` — lets title pull the loan payoff/reinstatement (distressed/pre-foreclosure deals). Generate at contract.
- `assets/seller-disclosures.md` — lead-based-paint (auto-include if built before 1978) + state condition form.
- `assets/deal-one-sheet.md` — disposition marketing one-sheet.
- `scripts/deal_calc.py` — deterministic ARV / repair / MAO / spread calculator.
