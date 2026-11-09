# Method — Funnel Assess Fit

A method file (owner item 15): read by the conductor (`lib/method-conductor.mjs`) and executed
step by step. Adapted from the committed Little Brother funnel method
(`littlebrother/methods/funnel-assess-fit.md` v0.1): map a funnel run folder's Little Brother
scan evidence to a fit verdict — FIT, REVIEW, or NOT-FIT — for the Scripture Armor consultation
funnel, using verified evidence only and the thresholds carried in this file.

The signal table, the disqualifiers and the banding below are the method; the numbers in the
executable block's `inputs` are the dials. In the Little Brother original the dials ship
`AWAITING-OWNER` (all null) and the method then emits a signal list only — that rule is kept
here: if any dial a verdict depends on is null, the band step yields `verdict: null`,
`verdictStatus: "dials-unset"`. This library copy ships with working dial values so the method
is conductable end to end; editing a value in this file changes the conducted verdict with no
code change (the item-15 proof in `test/method-conductor.test.mjs` does exactly that).

Preconditions: the run folder (the conduction workDir) holds `00-target/target.json` with
`denylistClear: true` and `01-scan/evidence/*.json` records `{ ok, source, outlet, date, data, verified }`.
Denylist handling itself is upstream and silent; this file never names, checks or explains it
beyond the marker precondition the source method states.

## Executable block

```kingmaker-method
{
  "id": "funnel-assess-fit",
  "version": "1.0",
  "title": "Funnel Assess Fit",
  "domain": "funnel",
  "inputs": {
    "minDomainAgeDays": 365,
    "expiryWindowDays": 30,
    "minPublishedChars": 2000,
    "minVerifiedShare": 0.8,
    "bandFitMin": 3,
    "bandReviewMin": 1,
    "reportLabel": "fit-assessment-v1"
  },
  "steps": [
    { "n": 1, "id": "load-target", "type": "read-json", "path": "00-target/target.json", "into": "target" },
    { "n": 2, "id": "guard-denylist-marker", "type": "guard",
      "assert": { "var": "target", "field": "denylistClear", "equals": true },
      "else": { "status": "precondition-failed", "reason": "00-target/target.json does not carry denylistClear: true — the target never cleared sourcing; there is nothing to assess" } },
    { "n": 3, "id": "load-evidence", "type": "read-json-dir", "path": "01-scan/evidence", "into": "evidence" },
    { "n": 4, "id": "guard-has-footprint", "type": "guard",
      "assert": { "existsRecord": { "in": "evidence", "source": "webRecon", "field": "ok", "equals": true } },
      "else": { "status": "no-evidence", "reason": "no webRecon record with ok: true — no footprint to read; no verdict is issued" } },
    { "n": 5, "id": "guard-scan-not-aborted", "type": "guard",
      "assert": { "noRecordWith": { "in": "evidence", "field": "aborted", "equals": true } },
      "else": { "status": "scan-aborted", "reason": "an evidence record carries aborted: true — a partial scan earns no verdict" } },
    { "n": 6, "id": "extract-signals", "type": "evaluate-signals", "from": "evidence", "into": "signals", "scoreInto": "score",
      "rules": [
        { "signal": "established-domain", "direction": "raise", "source": "domainLookup",
          "when": [ { "field": "data.registrar", "exists": true }, { "field": "data.created", "ageDaysGte": { "input": "minDomainAgeDays" } } ] },
        { "signal": "substantive-footprint", "direction": "raise", "source": "webRecon",
          "when": [ { "field": "data.chars", "gte": { "input": "minPublishedChars" } } ] },
        { "signal": "sealable-data-business", "direction": "raise", "source": "webRecon",
          "when": [ { "field": "data.text", "containsAny": ["customer records", "payments", "client files", "health", "legal", "financial", "e-commerce"] } ] },
        { "signal": "published-contact-path", "direction": "raise", "source": "webRecon",
          "when": [ { "field": "data.contactEmail", "exists": true }, { "other": { "source": "emailFormatCheck", "field": "data.syntaxValid", "equals": true } } ] },
        { "signal": "operated-brand-presence", "direction": "raise", "source": "usernameLookup",
          "when": [ { "field": "data.profiles", "anyItem": { "itemField": "exists", "equals": true } } ] },
        { "signal": "named-infrastructure", "direction": "raise", "source": "ipLookup",
          "when": [ { "field": "data.organization", "exists": true } ] },
        { "signal": "young-domain", "direction": "lower", "source": "domainLookup",
          "when": [ { "field": "data.created", "ageDaysLt": { "input": "minDomainAgeDays" } } ] },
        { "signal": "expiry-near", "direction": "lower", "source": "domainLookup",
          "when": [ { "field": "data.expires", "withinDays": { "input": "expiryWindowDays" } } ] },
        { "signal": "thin-footprint", "direction": "lower", "source": "webRecon",
          "when": [ { "field": "data.chars", "lt": { "input": "minPublishedChars" } } ] },
        { "signal": "no-brand-presence", "direction": "lower", "source": "usernameLookup",
          "when": [ { "field": "data.profiles", "allItems": { "itemField": "exists", "equals": false } } ] },
        { "signal": "weak-verification", "direction": "lower", "source": "*",
          "when": [ { "aggregate": "verifiedShare", "lt": { "input": "minVerifiedShare" } } ] }
      ] },
    { "n": 7, "id": "band-verdict", "type": "band", "scoreFrom": "score", "into": "verdict", "statusInto": "verdictStatus",
      "requiredInputs": ["minDomainAgeDays", "expiryWindowDays", "minPublishedChars", "minVerifiedShare", "bandFitMin", "bandReviewMin"],
      "bands": [ { "minInput": "bandFitMin", "verdict": "FIT" }, { "minInput": "bandReviewMin", "verdict": "REVIEW" } ],
      "default": "NOT-FIT",
      "cap": { "unlessSignal": "published-contact-path", "max": "REVIEW" } },
    { "n": 8, "id": "write-assessment", "type": "write-json", "path": "01-scan/fit-assessment.json",
      "value": { "domain": "{{target.domain}}", "label": "{{inputs.reportLabel}}", "signals": "{{signals}}", "score": "{{score}}", "verdict": "{{verdict}}", "verdictStatus": "{{verdictStatus}}", "dialsUsed": "{{inputs}}" } },
    { "n": 9, "id": "append-ledger", "type": "append-jsonl", "path": "funnel-ledger.jsonl",
      "value": { "stage": "fit", "domain": "{{target.domain}}", "outcome": "{{verdict}}", "score": "{{score}}" } },
    { "n": 10, "id": "verify-assessment", "type": "verify",
      "assertions": [ { "file": "01-scan/fit-assessment.json", "field": "score", "equals": "{{score}}" }, { "file": "01-scan/fit-assessment.json", "field": "signals", "exists": true } ] }
  ]
}
```

## Steps (prose mirror)

1. **load-target** — Read `00-target/target.json` fresh from disk. Never assess from a caller's in-memory copy — the files are the one representation.
2. **guard-denylist-marker** — The target must carry `denylistClear: true`; otherwise the conduction halts and nothing is written.
3. **load-evidence** — Read every record in `01-scan/evidence/` fresh.
4. **guard-has-footprint** — Disqualifier: no `webRecon` record with `ok: true` (or no domain record at all) means no footprint to read — halt, no verdict.
5. **guard-scan-not-aborted** — Disqualifier: any record with `aborted: true` means the scan stopped on policy — halt, no verdict.
6. **extract-signals** — Only records with `ok: true` and `verified: true` may raise fit; unverified records contribute nothing in either direction; refused/failed records are method outcomes, not signals. Each fired signal cites the evidence file it came from. Net score = raises − lowers, one point each, no weighting.
7. **band-verdict** — Only if every dial is set: net ≥ `bandFitMin` → FIT; net ≥ `bandReviewMin` → REVIEW; otherwise NOT-FIT. Special rule from the source method: with no verified published contact path, the verdict is capped at REVIEW no matter the score.
8. **write-assessment** — Write `01-scan/fit-assessment.json`: `{ domain, label, signals, score, verdict, verdictStatus, dialsUsed }`. This file is the assessment's one representation; later stages read it, they do not recompute it.
9. **append-ledger** — Append one line to `funnel-ledger.jsonl`: `{ stage: "fit", domain, outcome, score }`.
10. **verify-assessment** — Re-read the written assessment and confirm the score and signal list on disk match the conducted values.

## Failure modes

- **Dials unset** → signal list only, `verdictStatus: "dials-unset"`. Never guess a threshold.
- **Evidence folder missing or unreadable** → the read step fails and the conduction halts; nothing is written. A missing scan is never treated as a zero score.
- **Conflicting records** → both signals may be listed with their files; the contradiction is the finding, not a problem to average away.
