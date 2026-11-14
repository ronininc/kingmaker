# Scripture Armor — Addendum M REFIT: BUILD REPORT

**Built:** 2026-10-25 (build session ordered by Robbie, 2026-10-24 23:00 MST)
**Tree:** `~/workspace/scripture-armor-refit/` — a full copy of the shipped v2 tree plus the refit. The shipped tree at `~/workspace/scripture-armor-v2/` was **not mutated** (verified: zero refit references in its `vaultd.mjs`/`scan.mjs`; its only refit-named file is its own pre-existing `REFIT-SUMMARY.md` design doc).
**Status:** NOTHING published, nothing pushed. Local files only, per the build order.
**Layout contract:** identical to the v2 tree (same top-level modules, same `test/` battery layout), plus five new modules (`refit-store.mjs`, `custody.mjs`, `refit-estate.mjs`, `refit-net.mjs`, `refit-gates.mjs`) and two new test files (`test/run-tests-refit.mjs`, `test/soak-refit.mjs`). Every refit mechanism in the daemon is gated behind `policy.refit.enabled`; with the flag off (the default), daemon behavior is the shipped v2 behavior — which is what the regression gate below proves.

**Headline numbers:** refit battery **173 passed / 0 failed** · soak **300/300 cycles, 7/7 tamper probes** · all six pre-existing batteries re-run green on the final tree (details below).

---

## 1. DEVIATIONS AND OPEN LEGS — READ FIRST

No M item was silently redesigned or quietly weakened. The following are the places where the proof is narrower than the design's full ambition, named exactly:

1. **M.5 — the HARD-cell execution leg is unproven on this hardware.** This VM has no `/dev/kvm` and no `firecracker` binary, and no reachable estate host has one either; the shipped `runHardCell()` substrate is a stub that throws `hard-cell-unavailable`. What the battery proves on the built refit: SOFT cells are demoted to scan-sandbox duty; executable activation with no HARD substrate and no routed host **refuses `cell-unavailable` and never runs**; when a routed HARD host is named, the activation pends as HARD/routed, the payload ships to the host, and the host's refusal propagates back as a refused activation with **nothing executed locally and nothing downgraded to SOFT**. What remains unproven until a KVM host exists: a payload actually executing inside a real Firecracker HARD cell. The mechanism is built as designed; the hardware leg of its acceptance cannot be run here.

2. **M.7 — the physical multi-machine gate is unmet.** The design's acceptance calls for the estate running across real machines. The battery runs the estate in multi-process form on one host: separate vault daemons with separate stores and identities, real mesh sockets, a real anchor node, and a partition induced by anchor unreachability. Partition semantics pass (unanchored side fails closed; anchored side unaffected; heal reconciles by canary; forks refuse; revocation/registration propagation cost measured < 50 ms/op over 50 ops). A two-physical-machine run remains owed and is **not** claimed.

3. **M.15 — boot-wall rules are verified as generated content, not as a live cold boot.** The battery verifies the persistent default-deny rulesets for all three platforms (nftables / pf / Windows boot filters) and the browser-only quarantine lane profile (no estate routes, no estate credentials, dies when the mesh rises), and probes netns availability on this host (available). Installing persistent boot firewall state on this shared build VM and cold-booting it against a hostile-network fixture was **not** done — it would change the host's boot posture for every other workload on the machine. The live cold-boot fixture leg remains owed on a sacrificial host.

4. **M.16 — the refit builds the untrusted-transport half; the Headscale swap itself is still an ops step.** Built and proven: estate policy is a custodian-co-signed artifact (two distinct custodians; self-countersign and non-member signatures refuse), the coordination server only carries it, policy acceptance is monotonic per node with the digest anchored, and a replayed older policy freezes. Not done here (by design of the build order — local files only): standing up the actual self-hosted Headscale server and migrating the live estate, which remains the separate `SWAP-PLAN.md` operation gated on Robbie's go.

5. **M.3 — enforcement scope note.** The forced legacy re-seal window is enforced on the **daemon consumption path**: legacy (v1/v2-format) frames refuse without an explicit relay flag inside the window and refuse unconditionally (`legacy-frame-dead`) after it. The owner-local CLI open in `armor.mjs` was deliberately left untouched: it is the owner's own act, on the owner's own machine, inside the owner's trust domain, and changing it would have altered shipped v1 semantics (the regression gate). Named here rather than left implicit.

6. **Three real bugs were found in the refit code during battery bring-up — all caught BY the battery, all fixed, all re-proven:**
   - **`custody.mjs` Shamir tables were built from the wrong generator.** The GF(256) exp/log tables used powers of `0x02`, which has order 51 in the 0x11b field — multiplication was silently corrupt outside that cycle and share reconstruction failed. Fixed by building the tables from the field generator `0x03`. Post-fix: 600/600 randomized split/reconstruct roundtrips (2-of-3, both pairings; 3-of-5).
   - **`refit-estate.mjs` `freshnessDecision` reported a stale estate as healthy.** The stale branch spread the time result *after* setting `ok:false`, and the spread's `ok:true` overwrote the refusal — an estate-stale node would have reported `ok:true`. Fixed (refusal fields now win). The M.20 battery case is what caught it.
   - **Anchor rounds raced.** Concurrent anchor rounds (save-triggered + timer) could write attestations backwards, overwriting a newer countersignature with an older one. Fixed: rounds are serialized, loop until the attestation covers the current chain head, and `saveAttestation` refuses to overwrite a newer attestation with an older one.

7. **The soak harness did not carry over — because it never existed as a file.** The shipped v2 tree contains no soak harness (the v2 soak was run ad hoc in its build session). `test/soak-refit.mjs` was written fresh, implementing the recorded v2 profile: 300 full wrap→present→approve→unwrap cycles against an anchored refit vault, plus tamper probes. The first full attempt scored 0/300 cycles due to **two bugs in the new soak runner, not in the armor**: the runner closed the requester connection at pend time (the daemon correctly deletes a pending when its requester disconnects — shipped v2 semantics), and it did not retry approvals through anchoring lag (the M.1 gate correctly refuses consumption until the claim save is countersigned). Runner fixed; the daemon was not touched. Final soak: **300/300 cycles, 0 failures, 7/7 probes, 147 s**, with exactly 300 absorbed anchor retries (~1 per cycle — the fail-closed anchoring lag is real and is absorbed by retry, as designed).

8. **Phase-4 S3 case is environment-sensitive (explained delta, not a refit delta).** During this session, the phase-4 battery case "a socket path in a shared directory is refused at serve time" failed 67/68 on the refit tree — and failed **identically on the pristine shipped v2 tree in the same environment** (this VM's `/tmp` is mode 700, which changes what the case's fixture can set up). On the final refit tree the phase-4 battery subsequently passed **68/68 twice consecutively**. Recorded as environment-state sensitivity observed on both trees, not a refit regression.

9. **Environment note for future runs:** `/tmp` on this VM is a 512 MB tmpfs. Early battery runs hit `ENOSPC` from this build's own temp debris (each run's M.14 section copies the ~120 MB Node binary). The harness now deletes its Node copy immediately after the pin checks, and all build temp dirs were cleaned up. No vaultd processes remain running from any harness (verified), and the temporary `savault` service user created by the M.24 drill was removed by the battery's own cleanup (verified).

---

## 2. PER-ITEM RESULTS — M.1–M.27

Design grade is from SPEC Addendum M. "Battery" counts are checks passed/failed in `test/run-tests-refit.mjs` on the final tree (**173 passed, 0 failed** overall). Daemon sections run real `vaultd` processes; module sections exercise the refit modules directly.

| Item | Design grade | Built as designed? | Battery evidence |
|---|---|---|---|
| **M.1** Anchored hash-chained registry | CLOSED BY MECHANISM | Yes | Module 10/10; daemon sections: consumption verifies the anchored registry, byte-edit → `anchor-divergence` refusal, replayed older attestation refuses, restore + re-anchor recovers. Every registry save is chained; the anchor countersigns the head; consumption reads verify against a fresh live anchor and fail closed when it is unreachable. |
| **M.2** Threshold identity custody | CLOSED BY MECHANISM | Yes | 10/10. GF(256) Shamir (default 2-of-3), shares sealed per custodian, reconstruction in RAM only (reconstructed keys are zeroed; no reconstructed identity ever touches disk — the earlier on-disk draft of this function was rewritten during the build), threshold signature assembled without the key ever existing whole on one box. |
| **M.3** Forced legacy re-seal window | CLOSED BY MECHANISM | Yes | Daemon section: legacy frame without relay flag refuses inside the window; with relay it pends carrying the legacy notice and re-seals on approval; policy window moved to the past + daemon restart → `legacy-frame-dead`, relay flag or not. (Scope note: §1.5 above.) |
| **M.4** Daemon under a dedicated service account; owner acts are nonce-bound signatures | CLOSED BY REMOVING THE CONDITION | Yes | Module section (with M.13/M.23): act verification, nonce replay refused, digest swap refused. Daemon: unsigned approve refused, wrong-key and wrong-digest acts refused, genuine act approves. M.24 drill proves the daemon running under its own uid with the store unreadable/unreachable by other uids. The token-file confirm path is superseded when `refit.signed_owner_acts` is on. |
| **M.5** SOFT cells demoted; executable activation HARD-only or routed | CLOSED BY REMOVING THE CONDITION | Yes, with the §1.1 hardware caveat | Module routing matrix 4/4 + daemon section 10/10: refit-on + SOFT-only policy refuses `cell-unavailable` and never pends/runs; refit-off control pends SOFT, approves, runs (proves the demotion is the refit's doing); routed case pends HARD with routed notice and the host's refusal propagates. The Tier-1 downgrade tap is abolished in refit mode. |
| **M.6** Plaintext-in-RAM confined; swap/hibernation/core-dumps abolished | REDUCED TO A NAMED RESIDUAL | Yes — lands on the named residual (§3) | Posture section (with M.15): host posture probe vs enrollment gate consistency; non-compliant fixture postures refuse enrollment. |
| **M.7** Real multi-machine estate | CLOSED BY MECHANISM | Mechanism yes; physical gate unmet (§1.2) | 7/7 in multi-process form: partition (unanchored side fails closed), heal by canary-bound chain, fork refusal, anchor refuses to re-countersign a regressed sequence, propagation cost measured. |
| **M.8** Packet layer (Addendum K) | CLOSED BY MECHANISM | Yes | 8/8. Per-flow X25519 session sealing, AEAD counter nonces, rolling hash-chain receipts; tamper and replay kill the flow and beacon; receipt verifies against the chain; an unenrolled endpoint cannot form a flow; live socket round trip via `serveFlows`/`openFlow`. |
| **M.9** Login binding; brokered credentials | REDUCED TO A NAMED RESIDUAL | Yes — lands on the named residual (§3) | 6/6. Binding verifier matrix (right device/address/receipt accepted; wrong any-of-them refused); brokered session tokens die at TTL; estate services issue no bearer fallback in refit mode. |
| **M.10** Device-bound delivery (Addendum L) | CLOSED BY MECHANISM | Yes | 3/3. Bundle delivered sealed to the presenting device's keys; wrong device refuses and beacons; right device opens in memory; the artifact carries no readable source and no checkable relation (no plaintext hash) to the code. |
| **M.11** Scan verdict demoted to input; runtime watch | CLOSED BY REMOVING THE CONDITION | Yes | Module 4/4 + daemon section: declared-vs-observed deviation (undeclared destinations, persistence, sensors, over-cap egress) sets the entry's anomaly state and revokes its grant; an in-profile report is not a deviation. |
| **M.12** Content is data; authority chains for consequential acts | CLOSED BY REMOVING THE CONDITION | Yes | 3/3. Inbound content is wrapped as quoted data with `instruction_weight: 0`; a 12-item injection corpus authorizes nothing across all six consequential classes (send/trade/settings/money/approval/publish/delete — the corpus runs as one sweep check); only owner-signed instructions and spine-law admit consequential acts; non-consequential reads stay free. |
| **M.13** The owner himself | REDUCED TO A NAMED RESIDUAL | Yes — lands on the named residual (§3) | Module section (with M.4/M.23): approvals are signatures over the full pending digest (canary, verdict, tier, notices, registry status, provenance); single review queue; expired pendings are refusals; digest is deterministic so what was reviewed is what executes. |
| **M.14** Toolchain pinned in signed policy | CLOSED BY MECHANISM | Yes | 6/6. Node pinned and verified by digest at run time; a one-byte tamper yields `engine-digest-mismatch` and the mismatched tool **never executes**; unpinned tools refuse; whole-directory pins verify. |
| **M.15** Boot window: persistent default-deny + quarantine lane | CLOSED BY MECHANISM | Yes, with the §1.3 live-boot caveat | Posture section (with M.6): ruleset content verified for Linux nftables, macOS pf, and Windows boot filters; quarantine lane is browser-only with no estate route and no estate credentials and dies when the mesh rises; netns probe on this host: available. |
| **M.16** Control plane: untrusted transport, co-signed policy | CLOSED BY REMOVING THE CONDITION | Yes, with the §1.4 ops caveat | 7/7. Two distinct custodians required; self-countersign refused; non-member refused; tamper breaks the digest; replay of an older policy freezes (monotonic acceptance, digest anchored). |
| **M.17** Genesis cross-sign + introduction chains + bound pairing codes | CLOSED BY MECHANISM | Yes | 10/10. Genesis pair cross-signs in person; introductions chain to verified members; a forged Tier-0 descriptor fails verification; pairing codes are single-use, minutes-lived, bound to the new device's key fingerprint, and **burn on first use or first failure**. |
| **M.18** Traffic shaping | REDUCED TO A NAMED RESIDUAL | Yes — lands on the named residual (§3) | 3/3. Shaped links emit uniform 1024-byte cells on a tick, padding with sealed chaff when idle (chaff observed on the wire); payloads reassemble exactly. |
| **M.19** Armor self-DoS: cheap checks first, per-origin budgets | CLOSED BY MECHANISM | Yes | Module 4/4 (cap + epoch rollover) + daemon section: synthetic mesh registration flood — first 3 (the configured budget) answered, the 4th refused `budget-exceeded`, and nothing was inserted into the registry. Quarantine/flow-kill fire only on authenticated events. |
| **M.20** Estate time from custodian attestations | CLOSED BY MECHANISM | Yes | 4/4. Estate time is the median of custodian-signed attestations; non-member attestations are excluded; a node beyond `mesh_skew_s` goes estate-stale and refuses; ordering comes from monotonic chains, never clocks. (This section caught bug §1.6b.) |
| **M.21** Recovery: three legs, three places, threshold + co-signature | CLOSED BY REMOVING THE CONDITION | Yes | 5/5. Three legs in three places is the floor (`recoveryStatus` reports leg count against floor 3); each leg is sealed to the threshold identity (a custodian's own key alone cannot open it); a recovery act requires a custodian co-signature. |
| **M.22** Updates: threshold-signed, monotonic, canaried | CLOSED BY MECHANISM | Yes | 6/6. Update records chain to the predecessor digest; sequence must strictly increase (rollback refuses); a non-canary node accepts only with a valid canary smoke verdict naming the same artifact; a failed smoke strands the update on the canary. Artifact digest is signed via the M.2 threshold. |
| **M.23** The Kingmaker exception cannot be ridden | REDUCED TO A NAMED RESIDUAL | Yes — lands on the named residual (§3) | Module section (with M.4/M.13): verification is provenance-blind — a signer shaped exactly like Kingmaker's gets **no** passage, unconfined activation, or consequential act; approvals live on the owner terminal of record; Kingmaker surfaces are advisory mirrors. **Addendum D invariant holds: the refit introduces no mechanism that wraps, cells, or governs Kingmaker itself.** |
| **M.24** Root owns its box only | REDUCED TO A NAMED RESIDUAL | Yes — lands on the named residual (§3) | 4/4 uid drill: daemon spawned under a dedicated `savault` uid; it serves; `identity.json` is owned by that uid at 0600; uid 65534 (nobody) can neither read the store nor connect to the socket. Root's estate-wide reach is denied by M.1+M.2 (no whole key on the box; store edits diverge at the anchor). |
| **M.25** Phone tier: holds nothing, brokers everything | REDUCED TO A NAMED RESIDUAL | Yes — lands on the named residual (§3) | 3/3. Phone-store audit fails if any identity/registry/recovery/custody material or `.scripture` file is present; broker results are bound to the request nonce, so a replayed result does not match a new request. |
| **M.26** Logs are armored: append-only hash chains, sealed segments | CLOSED BY MECHANISM | Yes | Module 4/4 + daemon checks (inside the M.3 daemon section): log segments seal as packages to a dedicated log identity and the plaintext is truncated; a tampered segment is named by the verifier; serve-start seals any pre-existing log; the owner `seal-logs` act rotates a fresh segment and the chain still verifies. Log reads are owner-channel acts and are themselves chained. |
| **M.27** HERMES proof case (permanent fixture) | Proof case | Yes | 7/7. The fixture (obfuscated config string, runtime decode, staged fetch-and-eval, harvest write) scans at **warn, never pass, never convicted by static analysis**; detonated in a cell it decodes its config but the fixture C2 receives **zero connections**, no second stage is fetched, the harvest dies with the staging, and the convicted hash refuses siblings at intake. |

**Grades after build:** 13 CLOSED BY MECHANISM — battery-proven · 6 CLOSED BY REMOVING THE CONDITION — battery-proven · 7 REDUCED TO A NAMED RESIDUAL — landed exactly on the residuals in §3 · M.27 proof case — battery-proven. Carve-outs: the §1.1 (M.5 hardware leg), §1.2 (M.7 physical gate), §1.3 (M.15 live boot), and §1.4 (M.16 ops swap) legs remain owed as named, and §1.5 (M.3 scope) stands as recorded.

---

## 3. THE SEVEN NAMED RESIDUALS — VERBATIM FROM THE DESIGN (SPEC Addendum M)

These are the exact remainders the design names. The refit lands on them; it does not shrink them silently.

**M.6** — "while a program runs, its plaintext exists in the RAM of the machine running it, and an attacker who owns that machine's hardware or its root can in principle read it; no mechanism removes this, because execution on general-purpose hardware requires plaintext in memory — it is physics, already recorded at §7.1 item 1. The refit confines that plaintext to HARD-cell RAM on an owner-chosen host, for the length of the run, with every persistent copy abolished."

**M.9** — "a login on a service that refuses to verify remains a bearer <redacted> on that service, because verification is an act only the service itself can perform and no architecture can reach inside a counterparty's system (ecosystem law, the same class as platform law); the refit closes every login the estate controls and brokers every credential it can, and names the rest posture, never proof — exactly as Addendum K's participation tiers already state."

**M.13** — "an owner who reads the full record and deliberately approves a bad package anyway cannot be stopped by any mechanism, because the owner's authority over his own estate is the system's founding rule (Robbie's standing sovereignty ruling): any mechanism that could veto an informed owner would be a second sovereign, and this architecture has exactly one."

**M.18** — "an observer who can watch BOTH ends of a low-latency interactive flow can still correlate its timing statistically and link the endpoints; no mechanism removes this without store-and-forward delays that would destroy the interactive sessions the estate exists to carry. That is information theory, not an engineering gap: the refit closes content, size, boundary, and volume leakage by mechanism, and names endpoint-correlation by a global passive observer as the remainder."

**M.23** — "Kingmaker itself remains unsubjected, by Robbie's own standing ruling (Addendum D), and no mechanism inside this architecture can close that without repealing the ruling; a compromised Kingmaker can still deny service and can mislead any surface that is not the terminal of record. What the refit closes is every path by which the exception could be ridden into material effect: no provenance, including Kingmaker's, buys uninspected passage, unconfined activation, or a consequential act."

**M.24** — "a compromised root owns that one machine's local acts until revocation; no mechanism exists, because root is the platform's own definition of total local authority (platform law): the only authority above a machine's root is the machine's owner, acting from outside it — which is precisely the revocation the estate gives him."

**M.25** — "on locked stock iOS, no third-party software can remove an OS-level implant (platform law: Apple's sandbox forbids it), and purely local, offline behavior of resident code is outside any network architecture's reach (the doctrine's standing line: the mesh governs network life, not local silicon). The refit closes the value half — nothing to steal, nothing to ride — and governs every crossing; the silicon itself remains, named."

---

## 4. REGRESSION GATE — ALL PRE-EXISTING BATTERIES ON THE FINAL REFIT TREE

All runs below were executed on the final tree, after the last code change, with the refit flag **off** (default) — i.e., measuring that the refit did not move shipped behavior.

| Battery | Shipped baseline | Final refit tree | Verdict |
|---|---|---|---|
| v1 (`test/run-tests.mjs`) | 53/53 | **53/53 — ALL TESTS PASSED** | ✅ same |
| Scan / Closure 1 (`test/run-tests-v2-scan.mjs`) | 83 passed / 0 failed / 4 deferred | **83 passed / 0 failed / 4 deferred** | ✅ same |
| Cell / Closure 2 (`test/run-tests-v2-cell.mjs`) | 94/94 | **ALL CELL BATTERY CHECKS PASSED** | ✅ same |
| Airlock / Closure 3 (`test/run-tests-v2-airlock.mjs`) | 61/61 | **ALL AIRLOCK BATTERY CHECKS PASSED** | ✅ same |
| Estate / Closure 4 (`test/run-tests-v2-estate.mjs`) | 27/27 | **27 passed, 0 failed** | ✅ same |
| Phase-4 regressions (`test/run-tests-v2-phase4.mjs`) | 68/68 | **ALL PHASE-4 REGRESSION CHECKS PASSED** (68/68, twice consecutively) | ✅ same — see §1.8 for the environment-sensitive S3 history |

**Regression gate: PASS.** No shipped gate moved.

## 5. ENDURANCE — SOAK ON THE REFIT TREE

Runner: `test/soak-refit.mjs` (written fresh for this build — see §1.7). Profile: the v2 soak profile — full lifecycle cycles against an anchored, refit-enabled vault (wrap → register → present → owner approve → unwrap, content byte-compared every cycle), then tamper probes.

| Measure | Result |
|---|---|
| Cycles | **300 / 300 ok, 0 failed** |
| Anchor retries absorbed | 300 (≈1 per cycle — designed fail-closed anchoring lag, absorbed by retry) |
| Probe P1 — byte-edited registry refuses consumption (`anchor-divergence`) | ✅ true |
| Probe P1 — exact-byte restore recovers full function | ✅ true |
| Probe P2 — setup state anchors | ✅ true |
| Probe P2 — replayed older anchor attestation refuses consumption | ✅ true |
| Probe P2 — fresh save re-anchors and recovers | ✅ true |
| Probe P3 — anchor daemon down (past the live-anchor cache) → consumption refuses | ✅ true |
| Probe P3 — anchor returns → next save anchors → recovers | ✅ true |
| Duration | 147 s |
| Exit code | 0 |

## 6. UPDATED OPEN-SURFACES LEDGER — THE 26 SURFACES

Surface N is M.N. Status is per the standing rule: an item leaves the open list only on a passing battery on the built refit. (The register file itself, `OPEN-SURFACES.md`, is **not** rewritten by this build — per the design, register wording moves on Robbie's approval; this ledger is the evidence for that approval.)

| # | Surface | Status after refit build |
|---|---|---|
| 1 | Vault store editable as owner (registry resurrection) | **CLOSED** — M.1 battery (module + daemon + soak probes P1/P2/P3) |
| 2 | Identity key on one machine | **CLOSED** — M.2 battery |
| 3 | Legacy packages carry the guessable-content fingerprint | **CLOSED** — M.3 battery (daemon enforcement; scope note §1.5) |
| 4 | Owner-token theft / same-uid daemon watching | **CLOSED** — condition removed (M.4): dedicated service uid + signed nonce-bound owner acts |
| 5 | Weak cells share the kernel | **CLOSED as a condition** (M.5): SOFT demoted to scan-sandbox only; executable activation refuses or routes HARD. **Named remainder:** HARD execution itself unproven until a KVM host exists (§1.1) |
| 6 | Plaintext in RAM; swap/hibernation/dump leaks | **REDUCED TO NAMED RESIDUAL** — M.6 (§3). Persistent copies abolished by mechanism; live RAM is physics |
| 7 | Estate only ever ran on one machine | **CLOSED as a mechanism** (M.7 battery, multi-process form). **Named remainder:** the physical multi-machine run is still owed (§1.2) |
| 8 | Live network traffic unarmored | **CLOSED** — M.8 battery |
| 9 | Logins are stealable bearer <redacted> | **REDUCED TO NAMED RESIDUAL** — M.9 (§3): closed for every login the estate controls; a non-verifying counterparty is that counterparty's act |
| 10 | Shipped code readable by anyone | **CLOSED** — M.10 battery (for armored Ronin app surfaces; public-by-intent marketing content is out of scope by definition, per Addendum L) |
| 11 | The scanner can be fooled | **CLOSED as a condition** (M.11): verdict demoted to input; runtime watch + grant revocation carry the guarantee |
| 12 | Meaning is not scanned (prompt injection) | **CLOSED as a condition** (M.12): content crosses as data only; consequential acts need an owner-terminated authority chain |
| 13 | The owner himself | **REDUCED TO NAMED RESIDUAL** — M.13 (§3): informed-owner sovereignty is the founding rule |
| 14 | The armor's own supply chain | **CLOSED** — M.14 battery (digest-pinned toolchain, verified at run time) |
| 15 | The window before the armor wakes up | **CLOSED as a mechanism** (M.15): persistent default-deny boot wall + quarantine lane, verified as generated rulesets. **Named remainder:** live cold-boot hostile-network fixture not run on this shared VM (§1.3) |
| 16 | The control plane is a crown jewel | **CLOSED as a condition** (M.16): transport untrusted; policy is custodian-co-signed and anchored. **Named remainder:** the Headscale server swap itself remains the separate ops step (§1.4) |
| 17 | First contact trusted on faith | **CLOSED** — M.17 battery |
| 18 | Traffic shape visible | **REDUCED TO NAMED RESIDUAL** — M.18 (§3): shaping closes content/size/volume; global-passive endpoint correlation is information theory |
| 19 | Defenses fired at the owner (armor self-DoS) | **CLOSED** — M.19 battery (module + daemon flood) |
| 20 | Clocks can be lied to | **CLOSED** — M.20 battery |
| 21 | Recovery material is a surface | **CLOSED as a condition** (M.21): three legs, three places, threshold-sealed, co-signed recovery |
| 22 | The update path can carry the attack | **CLOSED** — M.22 battery |
| 23 | Kingmaker deliberately outside the armor | **REDUCED TO NAMED RESIDUAL** — M.23 (§3): the exception stands by Robbie's ruling; every path for *riding* it is closed; Addendum D invariant intact |
| 24 | Root/admin above every local tier | **REDUCED TO NAMED RESIDUAL** — M.24 (§3): root keeps its one box's local acts until revocation, and is denied the estate by M.1+M.2 |
| 25 | Phone tier and local silicon | **REDUCED TO NAMED RESIDUAL** — M.25 (§3): the phone holds nothing and brokers everything; locked-iOS implant removal is platform law |
| 26 | The armor's own logs are an unarmored sensitive store | **CLOSED** — M.26 battery (module + daemon rotation) |

**Ledger totals:** 13 closed by mechanism · 6 closed by removing the condition · 7 reduced to their named residuals · **0 unaddressed, 0 still open without a name.** Four legs remain owed as named follow-ups, none of them silent: the KVM-host HARD-cell execution proof (M.5), the physical multi-machine estate run (M.7), the live cold-boot fixture (M.15), and the Headscale server swap operation (M.16).

## 7. WHAT WAS BUILT — FILE MAP

- `refit-store.mjs` — M.1 hash-chained registry + anchor attestations; M.19 epoch budgets; M.26 log-segment sealing/verification.
- `custody.mjs` — M.2 GF(256) Shamir threshold custody, sealed custodian shares, RAM-only reconstruction, threshold signing; M.21 recovery legs and co-signed recovery acts.
- `refit-estate.mjs` — M.17 genesis/introduction descriptors and pairing codes; M.16 custodian-co-signed monotonic policy; M.20 custodian time attestations and estate-stale decisions; M.22 update records and canary-smoke acceptance; M.25 phone-store audit and broker request/result binding.
- `refit-net.mjs` — M.8 sealed flows (X25519 + AEAD counter nonces + rolling hash-chain receipts) with a socket server/client; M.18 fixed-size shaping with sealed chaff; M.9 login binding, binding verifier, brokered sessions.
- `refit-gates.mjs` — M.4/M.13 owner keys, nonce-bound signed acts, the digest-bound review queue; M.5 cell-routing law; M.11 runtime deviation watch; M.12 inbound-as-data wrapping and authority-chain admission; M.10 device-bound bundle delivery; M.14 toolchain pinning and pinned execution; M.6/M.15 host posture, enrollment gate, boot-wall rulesets, quarantine lane profile.
- `vaultd.mjs` — refit integration, all behind `policy.refit.enabled`: registry chaining on every save + serialized anchor rounds; M.1 consumption gate on unwrap/approve; M.3 legacy-window enforcement; M.4/M.13 signed owner acts (nonce issue via owner channel); M.5 routing law at both activation sites + routed remote activation over the mesh (`activate-remote`); M.11 `watch-report` (anomaly + estate grant revocation); M.19 mesh registration budgets; M.26 serve-start log sealing + owner `seal-logs` rotation; anchor mesh types (`anchor-head`, `anchor-status`).
- `scan.mjs` — the refit policy block (`policy.refit`: enable flag, anchor binding, legacy window, signed-acts flag, HARD host list, budgets, mesh skew) with merge support.
- `test/run-tests-refit.mjs` — the Addendum M acceptance battery: **173 checks**.
- `test/soak-refit.mjs` — the soak runner: 300 anchored lifecycle cycles + 7 tamper probes.

**Cleanup verification:** no `vaultd` processes remain from any harness run; the M.24 drill's temporary `savault` user was removed by the battery itself; build temp debris under `/tmp` was removed. The shipped v2 tree is byte-untouched by this build.
