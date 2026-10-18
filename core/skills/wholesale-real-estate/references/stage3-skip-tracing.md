# Stage 3 — Skip Tracing (name → phone / email)

Turn each owner into reachable contact info. This is where the free method has a
real accuracy ceiling — be honest about it.

## Free / public method (best-effort)
1. From the lead row, take `owner name` + `property/mailing address`.
2. Cross-reference public people-search aggregators and public records to find a
   likely phone / email / current mailing address.
3. Corroborate with a second source when possible (two sources agreeing = higher
   confidence). Record the source and a confidence tag: `Confirmed` (2+ sources),
   `Likely` (1 source), `Unknown`.
4. Write into the lead sheet's contact columns. **Never** synthesize or "complete"
   a partial number. A blank beats a wrong number that gets the team a TCPA
   complaint or a wrong-party call.

## Accuracy ceiling (say this to the team)
Free lookups typically return partial or stale numbers and lower hit rates than
paid skip tracing, which licenses bulk consumer data. For any real volume, the
standards are **BatchSkipTracing, Skip Genie, or IDI/LexisNexis**, and skip
tracing is bundled into **PropStream, BatchLeads, DealMachine, Propelio, Deal
Run**. Recommend paid the moment the list is more than a few dozen rows.

## Compliance
- Numbers must be scrubbed against the **DNC registry** before calling, and SMS
  requires **10DLC** carrier registration. The skill flags this; the team owns the
  scrub and registration. See `references/compliance-and-legal.md`.
- Do not skip trace for any purpose other than legitimate real-estate outreach.
