# Scripture Armor — Release-Readiness Pass (2026-10-26)

## HEADLINE VERDICT: **NOT release-ready — 419/431. Two battery cases fail deterministically, and they are named below, first.**

The recorded claim for this tree (v1.1.1) is a 431/431 battery. Re-run in full on this tree, the battery's structure reproduces exactly — the eight suites' own tallies sum to precisely 431 checks (legacy 386 = 53+61+94+27+68+83, plus 22 v4-pq, plus 23 gemini-fix) — but **12 checks fail**, in two cases, reproducibly, in chain runs and in solo runs on an idle machine:

1. **Airlock case 4 (7 checks) — the scan gate drops a slow scan without a trace.** A critical binary crossing inward must be refused at the scan gate, sealed into quarantine, beaconed, and the session closed on first strike. Instead the session closes `peer-gone` and nothing is recorded: no crossing record, no quarantine entry, no beacon. Measured cause: the Ghidra binary scan of the case's fixture binary takes **28.0 s** on this 2-core VM (manual run of `scanBinaryFile` on the same `bad.c`, 5 findings incl. a critical — the engine itself works, and the standalone scan battery passes 83/83). The test peer's lifetime is 25 s; the scan loses that race here, and **when the session dies mid-scan, the daemon discards the in-flight scan entirely — custody bytes received are left with no verdict, no quarantine, and no testimony.** On hardware where the scan wins the race this case passes; the silent-drop behavior when it doesn't is a product gap, not just a test artifact.
2. **Cell case 11 (5 checks) — the emission→candidate promotion path records nothing.** A clean executable emitted by a program running in a cell should be captured, registered as an `activation-store` candidate, held in `candidates/`, pend for its own grant, and run after the grant. The run completes, but the candidate list is empty (`[]`) and every downstream check fails on null. The refusal side of the same case works (a critical emission is refused promotion; a listed-hash program produces no candidate; the refusal is testified) — only the promotion path is dead.

**What is NOT blocking:** the M.19 denial-of-service acceptance — the largest named open acceptance item — was run in this pass and **passes exactly** (§2). Every other suite is fully green, including the complete v1.1.1 Gemini-fix battery. The remaining register items are designed-not-built owner decisions (M.1, M.2), hardware-gated proofs (M.5 HARD cell needs a KVM host; M.7 needs two physical machines), one ops step (M.16 Headscale), and named residuals the register already accepts (§3).

**Bottom line:** do not ship on the 431/431 claim — it does not reproduce. Ship-readiness requires fixing (or explicitly owner-waiving) airlock case 4's silent scan-drop and cell case 11's dead promotion path, then re-running those two suites green.

---

## 1. Baseline battery — verified tallies (each suite's own tally line, direct runs)

| Suite | Tally | Verdict |
|---|---|---|
| test/run-tests.mjs (legacy standalone) | **53/53** | PASS |
| test/run-tests-v2-airlock.mjs | **54/61** | **FAIL — case 4, 7 checks (below)** |
| test/run-tests-v2-cell.mjs | **89/94** | **FAIL — case 11, 5 checks (below)** |
| test/run-tests-v2-estate.mjs | **27 passed, 0 failed** | PASS |
| test/run-tests-v2-phase4.mjs | **68 passed, 0 failed** | PASS |
| test/run-tests-v2-scan.mjs | **83 passed, 0 failed, 4 deferred(phase2)** | PASS |
| test/run-tests-v4-pq.mjs | **22/22** | PASS |
| test/run-tests-gemini-fix.mjs | **23/23** | PASS |
| **TOTAL** | **419/431** | |

Failing checks, verbatim:
- Airlock [4] "IN critical binary": *critical crossing recorded with verdict critical* (got null) · *record carries the airlock-scan reason class* · *custody bytes registered as QUARANTINED* (null) · *sealed package held under quarantine/* · *quarantined bytes never entered inbound/* · *session closed on first strike (violations-scan)* (actual close reason: `peer-gone`) · *beacon testified in the daemon log*. (Daemon stayed healthy; text-scan cases in the same suite — e.g. the warn-verdict A3 case — pass; only the Ghidra binary lane races.)
- Cell [11] "emitted executables are NOT delivered": *exactly one candidate artifact recorded* (got `[]`) · *candidate registered origin activation-store + candidate flag* (null) · *candidate package held in candidates/* · *candidate activation pends for its own grant* · *candidate runs after its grant*.

Notes on method and on two things that did **not** survive scrutiny:
- The chain (sequential) run of this battery was corrupted by this VM's execution layer — two false "completion" deliveries, five suite logs zeroed, an intermittent EPERM write-refusal fault (waves lasting minutes; it also crashed the cell suite mid-chain on a fixture copy and wedged it on orphaned daemons until killed). **Every tally above is from a direct solo run observed end-to-end**; the airlock failure reproduced identically in chain and solo, the cell failure is from the solo run (in the chain, the suite's Ghidra-dependent tier-2 checks failed under contention and the suite then crashed before case 11 — solo, the tier-2 cluster passes and case 11 is the failure).
- An external re-run report claimed two gemini-fix store-tamper checks (4.5a/4.5b) failed. **Not reproduced:** my direct run of that suite passes 23/23, including tampered identity.json and addressbook.json failing closed with the precise `store-integrity: … (HMAC mismatch)` errors printed in the log. The counted verdict is the observed run.
- Environment limits on what could be proven here: no `/dev/kvm` and no firecracker binary on this VM, so the HARD cell substrate refuses (fail-closed, as designed) and cannot be exercised; all estate proof is multi-daemon loopback on one machine.

## 2. M.19 acceptance — the 10,000-forged-RPC fuzz (register item 19's named remaining acceptance)

Harness: `~/workspace/scripture-armor-readiness/fuzz-m19.mjs` (results: `fuzz-results-arm1.json`, `fuzz-results-arm2.json`, `fuzz-results-arm3.json` in the same folder). Three arms, each against its own fresh local test daemon with test identities; localhost unix sockets only; no production/owner store touched.

**Arm 1 — 10,000 forged RPCs on the requester channel (the acceptance as named):**
- Forged sent: **10,000** · Refused: **10,000** · **Accepted: 0** · Timeouts: **0** · Other errors: **0**
- Refusal mix (9 forgery shapes): nonexistent package path 1,112 (unparseable ENOENT) · non-package file 1,111 (missing SCRIPTURE-ARMOR header) · wrong-recipient + tampered-signature packages 2,222 (recipient-mismatch) · unsigned requester-channel registrations 2,222 (register-unauthenticated) · forged owner acts on the requester channel 1,111 (owner-channel-required) · unknown commands 1,111 · malformed JSON 1,111
- Owner channel probed mid-flood: status `ok:true` in **7 ms** at ~7,500 requests sent, and again after — the owner is never starved.
- After: daemon alive, final status ok, registry issued **0** (forged registrations recorded nothing), pending **0**.
- Arm 1b (connection budget): 80 concurrent requester connections against the 64 cap → **16 shed, counted on owner status** (`socket_shed.requester = 16`, owner channel shed 0).

**Arm 2 — per-origin pending cap (32):** 40 fully valid packages from one enrolled origin presented simultaneously, no approvals: **exactly 32 pended, exactly 8 shed**, each shed answered with `pending budget for this origin is exhausted — the owner sees a count, not a flood (M.19)`. Owner status showed `pending: 32` while held; vaultd.log carried exactly **8** `pending-shed-budget` records, `shed_total` reaching **8**. During the held flood a legitimate owner approval succeeded and its unwrap landed byte-processed normally; on release, pendings returned to 0; daemon alive.

**Arm 3 — per-sender registration budget (10,000/hour):** 10,000 well-formed registrations from one sender: **10,000 accepted, 0 refused**. Entry **#10,001 refused** with the exact text `register-budget-exceeded: per-sender registration budget for this epoch is exhausted (M.19)`; a further 10 all refused identically. Owner status: `registry_issued: 10000`; daemon alive. (Observation, not a failure: the fill took ~76 s — the budget count scans the registry per entry, so cost grows with registry size.)

**Item 19 verdict: the acceptance is run and PASSED — its budgets fire exactly at their shipped values, are shed-and-counted, are visible to the owner, and the daemon stays alive and owner-responsive throughout.**

Harness notes (honesty): the first flood attempt exposed a harness bug — a naive client exceeding the daemon's 512-frame per-connection budget gets its connection shed (the budget working as designed; connections were recycled under the cap for the counted run). Arm 3's first attempts were refused 10,000× because the harness sent an undefined recipient fingerprint (raw identity JSON carries no computed fingerprint field) — the daemon's malformed-entry refusal was correct; fixed harness-side by computing fingerprints as the armor does. Fuzz daemon state lived under /tmp because this VM was refusing workspace writes in waves during the run; all results were written to `~/workspace/scripture-armor-readiness/`.

## 3. OPEN-SURFACES register — re-score against this tree (29 items)

Grades use the register's own rule: an item is closed only on battery evidence in this tree, never on design alone. "Closed" below cites the evidence from §1/§2.

| # | Item (short name) | Grade | Evidence |
|---|---|---|---|
| 1 | Same-uid store edit / registry resurrection | **STILL OPEN** (detection closed; prevention = M.1, owner decision) | v1.1.1 HMAC store tags verified in my run (gemini-fix fix5/fix6: tampered identity/addressbook fail closed on load; tampered registry refuses presentations; in-place migration preserves fingerprints). The tree's own comments state the limit: "tamper-EVIDENCE, not the M.1 countersigned store (designed, …)" — vaultd.mjs:385; armor.mjs:130 |
| 2 | Single-machine identity custody | **STILL OPEN** (M.2 threshold identity, owner decision) | No threshold/Shamir/split-key code anywhere in the tree |
| 3 | Legacy packages carry guessable fingerprint | **STILL OPEN** (partially superseded) | v4 is the default format and identities auto-migrate (v4-pq suite), but legacy formats remain readable by design — v4-pq: "legacy v3 package still opens byte-for-byte" passes; no re-seal deadline or legacy-code removal exists in this tree |
| 4 | Same-uid token theft / daemon memory | **STILL OPEN** (hardened; named residual) | Shipped hardening proven: owner acts moved to a separate owner socket in a 0700 dir with a per-daemon token; the daemon fails closed on a non-private socket dir (it refused this pass's own 0770 test dir). The M.4 closure (daemon in its own service account, approvals as signatures) is not built — the daemon runs as the invoking user |
| 5 | SOFT cells share the kernel; HARD unproven | **STILL OPEN** (HARD half) | cell.mjs probes /dev/kvm + a firecracker binary and the HARD dispatcher refuses where the substrate is absent — both are absent on this VM, so HARD has never run here; SOFT cell battery passes except case 11 (unrelated path) |
| 6 | Plaintext in memory / swap / dumps | **STILL OPEN** (accepted named residual) | The register's own grade; nothing in this tree changes the physics |
| 7 | Estate has only run on one machine | **STILL OPEN** (physical half) | Estate battery 27/27 proves multi-daemon behavior incl. a hostile member, revocation distribution, mid-stream enrollment — all loopback on one machine. Two physical machines across a real network remain unrun |
| 8 | Live traffic unarmored (packet layer) | **STILL OPEN** | No packet-layer/tunnel implementation exists in this tree; what ships and is proven is governed, signed mesh RPC (estate + phase4 batteries), not a traffic tunnel |
| 9 | Logins are bearer instruments | **STILL OPEN** (named residual) | The hash-matched login binding (Addendum K) is not a component of this tree; closure also depends on verifying services |
| 10 | Shipped code readable by anyone | **SUPERSEDED** (for the armor itself) | The owner open-sourced the armor (Apache-2.0, public repo) on 2026-10-25; the protective capability the item wanted (sealed, device-bound delivery) is the wrap/unwrap system proven across the whole battery. Ronin app surfaces are outside this tree |
| 11 | The scanner can be fooled | **CLOSED** (by condition removal, battery-corroborated) | The design never depends on the scanner being right: scan battery 83/83 (verdict discipline, tier gates, report-tamper/transplant refusal) and execution containment lives in cells + tiers (cell battery). Scanner fallibility remains a named property of heuristics, not a defect. **Caveat:** airlock case 4 (§1) shows a scan that never lands is dropped silently at the airlock — that failure is scored there, not hidden here |
| 12 | Meaning is not scanned (prompt injection as data) | **CLOSED** (by condition removal) | Consequential acts require owner approval bound to content across every suite; inward crossings arrive as data on non-commanding channels (airlock battery). The semantic risk class itself is inherent |
| 13 | The owner himself is a surface | **STILL OPEN** (accepted residual, mitigations proven) | Approvals are digest-bound, single-use, window-bound; dual-approval tiers exist (legacy + gemini-fix batteries). Approval fatigue/phishing cannot be engineered away without removing owner authority |
| 14 | The armor's own supply chain | **STILL OPEN** (partial) | Tools are resolved locally and the scan battery runs on them, but the M.14 closure (tools pinned, scanned, verified at the moment they run; updates only as packages) is not implemented as such in this tree |
| 15 | The window before the armor wakes | **STILL OPEN** | No boot-wall mechanism exists in this tree; the live cold-boot fixture has never been run |
| 16 | Control plane is a crown jewel | **STILL OPEN** (ops step, owner-gated) | The estate code demotes the mesh to transport and refuses stale/revoked members (estate battery), but the hosted-Tailscale → self-hosted Headscale swap is an operations act, not code in this tree, and has not been executed |
| 17 | First contact trusted on faith (TOFU) | **CLOSED by v1.1.1** | Introductions shipped: trust records introducer, time, and a SAS over the full classical+PQ key set; key-material change under an existing label is refused (armor.mjs:277, armor.mjs:1344); v4-pq + trust-flow checks pass |
| 18 | Traffic shape is visible | **STILL OPEN** (accepted named residual) | No padding/shaping is designed; the register's own grade stands |
| 19 | Defenses can be fired at the owner (DoS) | **CLOSED by this pass** | Budgets shipped in v1.1.1 (pending cap 32, registration 10k/sender/hour, per-channel socket budgets) and the named remaining acceptance — the 10,000-forged-RPC fuzz — is now run and passed exactly (§2). The socket-layer half was already proven by gemini-fix fix2 |
| 20 | Clocks can be lied to | **STILL OPEN** (partially mitigated, proven where built) | Mesh freshness windows + nonce discipline (phase4: stale and re-signed-stale refused `mesh-stale`, 68/68) and revocation staleness bounds (estate[8], [X3]) are proven; the full M.20 estate-agreed-time design is not built |
| 21 | Recovery material is a surface | **STILL OPEN** (rides M.2) | Single-identity backup→wipe→restore is proven byte-identical in the battery; the three-leg split recovery depends on M.2 (unbuilt). The single-leg release .p12 fact lives on the owner's Mac, outside this tree |
| 22 | The update path can carry the attack | **STILL OPEN** | This tree contains no self-update mechanism at all — no update door to compromise, and the M.22 forward-only countersigned update is unbuilt. Distribution is the public repo under the owner's process |
| 23 | Kingmaker deliberately outside the armor | **SUPERSEDED** (standing owner doctrine) | Addendum D is the owner's ruling (Kingmaker is native, never wrapped); the item remains on the register by design as a named exception, not a defect |
| 24 | Root/admin above every local tier | **STILL OPEN** (accepted named residual) | Platform law; the register's own grade stands |
| 25 | Phone tier / local silicon | **STILL OPEN** (accepted named residual) | Platform law for locked iOS; the register's own grade stands |
| 26 | The armor's own logs are a sensitive store | **CLOSED by mechanism** (register's two residuals stand) | vaultd.log is an HMAC-sealed hash chain (`log-verify` names the first broken line — vaultd.mjs:126–148); closed segments rotate into `log-segments/` sealed as v4 packages (vaultd.mjs:344–358). Named residuals from the register itself: the live segment is chained, not sealed, while the daemon runs; beacon.log remains plain append-only |
| 27 | Outbox desync self-lockout | **CLOSED by v1.1.1** | gemini-fix fix1 checks pass in my run: never-issued testimony unchanged, signature-valid packages from enrolled senders recorded as recovery candidates, owner approval derives issuance and opens, outbox surfaced with age |
| 28 | RESTORE-INFO one-shot burn | **CLOSED by v1.1.1** | gemini-fix fix4 checks pass: verify-open cross-checks the sidecar before the return is spent; tamper refuses with the manifest unburned; fixed sidecar restores byte-for-byte |
| 29 | Registry-load amplification | **CLOSED by v1.1.1** | gemini-fix fix3 checks pass: in-memory registry with mtime/size invalidation; external edits seen on next request; every reload re-verifies the store integrity tag |

**Register tally: 8 closed (11, 12, 17, 19, 26, 27, 28, 29) · 2 superseded (10, 23) · 19 still open** — of the open: 2 are owner decisions with designs ready (1→M.1, 2→M.2), 5 are accepted named residuals (6, 13, 18, 24, 25), 2 are hardware/ops-gated (5-HARD, 16; 7's physical run makes 3), and the rest are partial mitigations or unbuilt designs (3, 4, 8, 9, 14, 15, 20, 21, 22).

## 4. Owner-decision items — NOT built in this pass (by instruction)

- **M.1 — Countersigned store** (closes register item 1's prevention half; also underpins item 21's recovery legs and item 22's update signing). Designed in Addendum M. What it would take: a second estate machine (or an offline countersigning key) that countersigns registry/store states; the daemon refuses a store whose countersignature doesn't verify. Needs at minimum a second enrolled endpoint or an owner-held offline key ceremony, plus a vaultd change to verify countersignatures at load and the migration path for existing stores. **Owner decision: whether the estate gets a second machine for this, or the countersigner is an offline key.**
- **M.2 — Threshold identity** (closes register item 2; enables item 21's split recovery). Designed in Addendum M. What it would take: split the identity key into threshold shares held by several machines (Shamir/threshold signing), assemble only at use, re-issue every existing identity under the scheme, and re-prove the battery against threshold-backed identities. No threshold code exists in the tree today. **Owner decision: how many shares, held where, what threshold — and accepting a re-issuance of the estate's identities.**

## 5. What "release-ready" still requires

1. Fix airlock case 4's silent scan-drop (a scan that outlives its session must still land: verdict recorded, custody bytes quarantined or explicitly dispositioned, beacon testified) — or the owner explicitly waives it for hardware where the scan wins the race. Re-run the airlock suite green.
2. Fix cell case 11's emission→candidate promotion (the clean-emission path records nothing). Re-run the cell suite green.
3. Owner decisions on M.1 / M.2 (§4) — they do not block shipping the armor as it stands, but items 1 and 2 stay on the open register until decided and built.
4. Proofs that cannot run on this VM, scheduled where they belong: M.5 HARD cell on a KVM host, M.7 two-physical-machine estate run, M.15 cold-boot fixture, M.16 Headscale swap (ops).

*Evidence locations: suite logs in `~/workspace/scripture-armor-readiness/` (battery driver + `solo-*.log`), fuzz harness + results in the same folder. All tallies are the suites' own printed counts from direct runs on 2026-10-26; all fuzz counts are from the harness's recorded daemon responses and the test daemons' own logs/status.*
