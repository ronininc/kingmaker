# FIX-REPORT-419 — the two failing cases from the independent readiness pass

Scope: local tree `~/workspace/scripture-armor-v2/` only. No GitHub pushes, no
repo writes beyond this tree, no Mac-side files touched. **No test files were
changed** — both fixes are in product code (`airlock.mjs`, `vaultd.mjs`).

## Verdict

**431/431.** The battery claim that did not reproduce at the readiness pass
(419/431, `RELEASE-READINESS.md`) now reproduces on this tree, with the two
defects fixed at the product level — not by winning a timing race and not by
touching a single check.

## Per-suite tallies — before / after

| Suite | Before (readiness pass) | After (this fix) |
|---|---|---|
| run-tests (v1) | 53/53 | 53/53 |
| run-tests-v2-airlock | **54/61** (case 4: 7 checks) | **61/61** |
| run-tests-v2-cell | **89/94** (case 11: 5 checks) | **94/94** |
| run-tests-v2-estate | 27/27 | 27/27 |
| run-tests-v2-phase4 | 68/68 | 68/68 |
| run-tests-v2-scan | 83 passed / 0 failed / 4 deferred | 83 passed / 0 failed / 4 deferred |
| run-tests-v4-pq | 22/22 | 22/22 |
| run-tests-gemini-fix | 23/23 | 23/23 |
| **Total** | **419/431** | **431/431** |

Acceptance runs (all on the fixed tree, back-to-back, otherwise idle machine;
logs in `~/workspace/scripture-armor-readiness/fix419/`):

- Airlock run 1 — `airlock-run1.log` — **61/61, ALL AIRLOCK BATTERY CHECKS PASSED**
- Airlock run 2 — `airlock-run2.log` — **61/61, ALL AIRLOCK BATTERY CHECKS PASSED**
- Cell run 1 — `cell-run1.log` — **94/94, ALL CELL BATTERY CHECKS PASSED**
- Cell run 2 — `cell-run2.log` — **94/94, ALL CELL BATTERY CHECKS PASSED**
- Full battery (remaining six suites, same tree, nothing changed between runs) —
  `battery-run-tests.log` 53/53 · `battery-run-tests-v2-estate.log` 27/27 ·
  `battery-run-tests-v2-phase4.log` 68/68 · `battery-run-tests-v2-scan.log`
  83/0/4-deferred · `battery-run-tests-v4-pq.log` 22/22 ·
  `battery-run-tests-gemini-fix.log` 23/23. Combined with airlock run 2 and
  cell run 2 above: **431/431**.

Before-fix baseline for the cell suite was re-observed directly in this fix
session (solo run: 89/94, failures exactly the 5 case-11 checks); the airlock
before-fix tally (54/61) is the readiness pass's figure.

---

## Defect 1 — Airlock case 4: custody bytes silently dropped when the session died mid-scan

**What was wrong.** A peer sends a binary; the airlock stages it in the chamber
and runs the Ghidra scan (~28 s on the 2-core test VM). The test peer's
lifetime is 25 s. When the peer socket closed, the airlock's close handler
immediately wiped the chamber and exited — the in-flight scan's verdict had
nowhere to go, the daemon never received a disposition, and the custody bytes
vanished with no verdict, no quarantine, and no beacon. Silent loss.

**The fix — `airlock.mjs` only** (the daemon side needed no change: `vaultd.mjs`
`handleAirlockEvent` already seals, records, and beacons on a
`quarantine-request`; it simply never received one):

1. **Custody bookkeeping.** Every staged item is registered in an `unsettled`
   map (staged id → sha256 + byte count) the moment its chamber copy is
   written, and removed only when its disposition lands (crossed in, dropped,
   quarantined, or scan-error).
2. **No close over unsettled custody.** `closeSession` is now a wrapper over
   `finalizeClose`: a close requested while items are unsettled is *deferred* —
   intake stops (peer server closed, peer connection destroyed) but the
   session stays alive until the last disposition settles. A disposition close
   (e.g. `violations-scan` after a quarantine) takes precedence over a
   deferred `peer-gone`.
3. **Testimony even in the pathological case.** A 10-minute failsafe bounds the
   deferral. If it ever expires — or a close somehow finalizes over unsettled
   items — `finalizeClose` first testifies every stranded item to the daemon
   as an `airlock-protocol` violation (sha256, bytes, and the fact the staged
   bytes were destroyed unsealed) *before* wiping the chamber. There is no
   code path that destroys custody bytes silently.
4. **Scan error is a disposition.** If the scan itself throws, the airlock
   files the `airlock-protocol` violation first (testimony), then settles the
   item — the error is that item's recorded disposition, not a drop.
5. **Supervisor death is the one immediate close.** SIGTERM/SIGINT close
   immediately even over unsettled custody — with the supervisor gone there is
   no one left to seal or testify to.

**Resulting behavior in case 4:** the peer dies at 25 s → close deferred over
one unsettled item → the scan completes → critical verdict →
`quarantine-request` → the daemon seals the bytes into `quarantine/`, writes
the crossing record (verdict critical, reason class `airlock-scan`), and logs
the beacon → `quarantined` reply → session closes `violations-scan`. Case 4's
checks now pass on their own terms, including "session closed on first strike
(violations-scan)" and "beacon testified in the daemon log". This is the
doctrine applied: sight, not strike — the conservative disposition is
quarantine with testimony, never a silent pass and never silent loss. Merely
extending the peer's lifetime or the scan timeout would not have fixed
anything; the disposition path is the fix.

Non-regression notes: a partial frame is never staged, so case 6 still closes
`peer-gone` immediately with nothing crossed; oversize frames in the case-5
ladder are dropped before staging and never enter custody; the case-10 budget
close waits at most milliseconds for data frames to settle and emits no
spurious violation or beacon.

## Defect 2 — Cell case 11: clean emission never recorded as a candidate

**What was actually wrong** (diagnosed from the daemon's own log in a before-fix
solo run, not from the symptom): the promotion code itself worked. For the
`spawner-clean` activation the log order was `activate` → `cell-log` →
**`activation-complete`** → **`promotion-candidate`**. The candidate package,
its scan report, and its registry entry (origin `activation-store`, candidate
flag set) all existed in the store — but they landed *after* the activation
record had been finalized and reported with empty `artifacts`/`emissions`, so
every case-11 check that reads the record or the post-run candidate state
failed. The mechanism: egress frames are handled fire-and-forget
(`handleEgressFrame(...).catch(...)`, never awaited), while
`launchActivation` did `await cell.done` and immediately finalized the record.
A fast-exiting cell outran its own multi-tick promotion (scan + two seals +
registry write). The refusal side of case 11 passed only because it is faster
— it was racy by the same mechanism.

**The fix — `vaultd.mjs` only. A drain, not a promotion rewrite:**

1. The activation's `run` object now carries `egressInFlight` (a Set of
   in-flight frame-handling promises) and `egressConns` (the live egress
   connections).
2. `startEgressServer` registers each connection in `egressConns` (removed on
   its `close` event) and wraps every `handleEgressFrame` call so the
   handling promise is added to `egressInFlight` and removed when it settles.
   (The pre-existing `.catch` that logs `egress-error` is preserved, so a
   tracked promise never rejects.)
3. `launchActivation` now awaits **`drainEgress(run)`** after `cell.done` and
   before `finish(...)`: an activation is not finished until every frame the
   cell sent has been fully handled and every egress connection has closed.
4. `drainEgress` requires the empty condition (no in-flight frames, no open
   connections) to hold across 3 consecutive ~25 ms polls, so socket events
   already queued land before the drain is called done. Its cap is 600 s —
   generous on purpose, since promoting a binary emission runs a full Ghidra
   scan. If the cap ever expires, it logs `egress-drain-timeout` (activation,
   canary, in-flight count, open connections) and returns: testimony instead
   of a hang, and the activation still finishes.

**Resulting behavior in case 11:** the promotion settles before the record is
finalized, so the record carries the candidate artifact, the registry entry is
in place, the package sits in `candidates/`, and the candidate pends for its
own grant and runs after it — all five previously failing checks pass, and
the refusal side (`spawner-bad` critical emission refused promotion) is
unchanged and still passes.

---

## Files changed

- `airlock.mjs` — custody bookkeeping (`unsettled`), deferred close with
  disposition precedence, 10-minute failsafe with pre-wipe testimony,
  scan-error disposition, `settleStaged`, immediate close on
  SIGTERM/SIGINT. Syntax-verified (`node --check`).
- `vaultd.mjs` — egress tracking on the activation `run` object, in-flight
  wrapping in `startEgressServer`, `drainEgress(run)` helper, and the
  `await drainEgress(run)` call between `cell.done` and `finish(...)`.
  Syntax-verified (`node --check`).

No other files changed. No test files changed. No owner design decision was
needed: both fixes sit inside the doctrine stated in the task (conservative
disposition + testimony for interrupted custody; promotion recorded before
the activation record closes).
