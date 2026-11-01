# INDEPENDENT-RERUN-2026-10-26 — airlock + cell suites, re-run from scratch

Independent re-verification of the two v2 readiness fixes claimed in
`FIX-REPORT-419.md`. The fix lane's report and acceptance logs were **not**
trusted: both suites were executed fresh against the working tree at
`~/workspace/scripture-armor-v2/` on 2026-10-26, first attempt each, and the
tallies below are from these runs only. No code was edited; nothing was
pushed. Logs: `~/workspace/scripture-armor-readiness/rerun-2026-10-26/`
(`airlock-attempt1.log`, `cell-attempt1.log`).

## Tallies

| Suite | Runner | Claimed (fix lane) | This re-run | Exit |
|---|---|---|---|---|
| Airlock | `node test/run-tests-v2-airlock.mjs` | 61/61 | **61/61 — ALL AIRLOCK BATTERY CHECKS PASSED** | 0 |
| Cell | `node test/run-tests-v2-cell.mjs` | 94/94 | **94/94 — ALL CELL BATTERY CHECKS PASSED** | 0 |

FAIL lines in either log: **0**. No second attempt was needed for either
suite — no fixture failure, no assertion failure.

## The previously failing cases, specifically

**Airlock case 4** (session dies mid-scan; 7 checks failed at the readiness
pass) — all 8 checks in the case PASS in this re-run, including:

```
[4] IN critical binary: refused at the scan gate, sealed into quarantine, beacon fires, session closes on first strike
  PASS  critical crossing recorded with verdict critical
  PASS  record carries the airlock-scan reason class
  PASS  custody bytes registered as QUARANTINED
  PASS  sealed package held under quarantine/
  PASS  quarantined bytes never entered inbound/
  PASS  session closed on first strike (violations-scan)
  PASS  beacon testified in the daemon log
  PASS  daemon healthy throughout
```

**Cell case 11** (clean emission never recorded as a candidate; 5 checks
failed before the fix) — all 12 checks in the case PASS in this re-run,
including every previously failing one, with the refusal side unchanged:

```
[11] emitted executables are NOT delivered — clean becomes a candidate behind scan+grant; critical is refused promotion
  PASS  spawner-clean wraps
  PASS  spawner-clean completes
  PASS  exactly one candidate artifact recorded
  PASS  candidate registered origin activation-store + candidate flag
  PASS  candidate package held in candidates/ (not delivered anywhere)
  PASS  candidate activation pends for its own grant
  PASS  candidate runs after its grant
  PASS  spawner-bad wraps (its hash is not yet listed)
  PASS  spawner-bad itself completes
  PASS  critical emission refused promotion (no candidate artifact)
  PASS  no new registry candidate from the listed-hash program
  PASS  promotion refusal testified
```

## Failures

None. There is no verbatim failing-case output to quote: `grep -c '  FAIL'`
returns 0 for both logs.

## Fixture / environment notes

- **Node:** v24.22.1 (tree requires ≥24).
- **No special env was set or needed.** Both suites ran with the plain
  environment on attempt 1, unlike the production fresh-clone check, which
  needed fixtures configured. Why it works here: this is the fix lane's own
  tree on the box the acceptance logs were produced on, so auto-detection
  resolves everything —
  - Ghidra: `scan.mjs` auto-detect found `~/workspace/tools/ghidra_12.2_PUBLIC`
    (`support/analyzeHeadless` present); no `SCRIPTURE_GHIDRA_HOME` pin used.
  - JDK: auto-detect found `~/workspace/tools/jdk25` (`bin/java` present).
  - Cell's v1 sibling: `~/workspace/scripture-armor-standalone` exists.
  - `upx` is on PATH (`/usr/bin/upx`) — relevant to the scan suite, unused
    by these two.
- **Box load (noted per instructions, runs proceeded anyway):** the machine
  was NOT idle — load average ~3.0–3.9 on 2 cores, with an unrelated Blender
  render running at ~113% CPU throughout. The fix lane's acceptance runs were
  on an otherwise idle machine. Both suites still passed first-attempt under
  load, which is the stronger result for these two fixes specifically: the
  airlock case-4 fix is a deferred-close/disposition mechanism and the cell
  case-11 fix is an egress drain — neither is a timing race, and both held
  with scan and promotion latency inflated by contention.
- **Wall time:** airlock started 14:25:03Z, ~2.2 min to process exit; cell
  started 14:27:27Z, ~4.4 min to process exit. Both harnesses linger briefly
  after printing their final summary before the process exits (event-loop
  drain); exit code 0 in both cases.
- **Cleanliness:** no vaultd/test processes left running afterward; no files
  in the tree were modified by this re-run (product files as found:
  `airlock.mjs` sha256 `7435188e…`, `vaultd.mjs` sha256 `f5457278…`).

## Scope note

Only the two mandated suites were re-run. The other six batteries in the
431 tally (v1 53, estate 27, phase4 68, scan 83/0/4-deferred, v4-pq 22,
gemini-fix 23) were not re-executed in this pass and are neither confirmed
nor contradicted here. The judgement below covers the claim's two
previously-failing subsets — which were the entire substance of the
419-vs-431 discrepancy (12 failing checks: 7 airlock case 4, 5 cell
case 11; all 12 now pass).

## Final line

**CONFIRMED** — airlock 61/61 and cell 94/94 reproduce independently on
first-attempt fresh runs; the two readiness fixes hold.
