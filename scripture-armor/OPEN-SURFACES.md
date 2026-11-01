# Scripture Armor — open attack-surface register (named by Muse at Robbie's order, 2026-10-24 15:05 MST)
Everything below is still exposed TODAY. "Designed" means a closure exists on paper (spec/doctrine) but is unbuilt; "proven" closures from the v2 batteries are NOT listed.

1. The vault store can still be edited by anything running as the owner (registry resurrection — prevention designed in Addendum K.1, unbuilt; detection only today).
Refit: M.1 — CLOSED BY MECHANISM
Annotation (Gemini fix pass, 2026-10-25, v1.1.1): the DETECTION half shipped — registry.json, addressbook.json, and identity.json now carry HMAC integrity tags keyed from the identity (HKDF, the M.26 pattern), verified on every load. Identity/address-book mismatch fails the load closed with a precise store-integrity error; a registry mismatch is logged loudly, surfaced on the owner status, and fails closed exactly where entries would be trusted (no presentation opens), while registration/estate-sync repair keeps running and re-tags on the next legitimate write. Stores migrate in place (fingerprints, trust, contents untouched). This does NOT close the item: prevention (the M.1 countersigned store) remains designed-not-built, and a same-uid writer who re-derives the tag from the identity file stands inside the local trust boundary (item 4).
2. The vault's identity key still sits on one machine (single-endpoint custody — threshold/hardware closure designed in K.1, unbuilt).
Refit: M.2 — CLOSED BY MECHANISM
3. Old v1/v2 packages still carry the guessable-content fingerprint (the cleartext plaintext hash) until each one is re-sealed.
Refit: M.3 — CLOSED BY MECHANISM
4. Any malware running as the owner's user can steal the owner-channel token and watch the daemon's memory (same-uid is inside the local trust boundary — the token file and process memory are readable by the same user).
Refit: M.4 — CLOSED BY REMOVING THE CONDITION
5. Weak cells still share the machine's kernel (SOFT cells on hosts without KVM — a kernel exploit from inside a cell escapes it; HARD/Firecracker form unproven on real hardware).
Refit: M.5 — CLOSED BY REMOVING THE CONDITION
6. Plaintext exists in memory while anything runs (RAM scraping, and keys/plaintext can leak to disk through swap, hibernation images, and crash/core dumps).
Refit: M.6 — REDUCED TO A NAMED RESIDUAL
7. The estate has only ever run on one machine (all mesh proofs are loopback — a malicious enrolled peer, clock games, and network partitions across real machines are untested).
Refit: M.7 — CLOSED BY MECHANISM
8. Live network traffic is unarmored today (the packet layer, Addendum K, is designed and unbuilt — the VPN-posture tunnel does not exist yet).
Refit: M.8 — CLOSED BY MECHANISM
9. Logins are still bearer instruments today (the hash-matched login binding, Addendum K, is designed and unbuilt — a stolen token still works from anywhere).
Refit: M.9 — REDUCED TO A NAMED RESIDUAL
10. Shipped code is still readable by anyone today (Addendum L is designed and unbuilt — ronininc.org, the launcher, and the CRM front ends can be inspected element by element right now).
Refit: M.10 — CLOSED BY MECHANISM
11. The scanner can be fooled (novel, packed, or environment-keyed malware; behavior that only appears later — logic bombs; formats with no rule pack; Ghidra verdicts are heuristic, not proof).
Refit: M.11 — CLOSED BY REMOVING THE CONDITION
12. Meaning is not scanned (a document can scan clean on every behavior class and still talk an agent into a bad action — prompt injection crosses as data; the armor governs crossings, not semantics).
Refit: M.12 — CLOSED BY REMOVING THE CONDITION
13. The owner himself is a surface (phishing, approval fatigue, a genuine tap on a bad package — the armor verifies devices and packets, not intentions).
Refit: M.13 — REDUCED TO A NAMED RESIDUAL
14. The armor's own supply chain (Ghidra, the JDK, the Node runtime, the build tools — none of them are themselves armored or scanned by it).
Refit: M.14 — CLOSED BY MECHANISM
15. The window before the armor wakes up (traffic between power-on and the mesh + daemon being up crosses ungoverned; hostile captive networks live in that window).
Refit: M.15 — CLOSED BY MECHANISM
16. The control plane is a crown jewel (whoever owns the Headscale server can enroll rogue devices and rewrite estate policy; until the swap, that jewel is hosted Tailscale's).
Refit: M.16 — CLOSED BY REMOVING THE CONDITION
17. First contact is trusted on faith — SHIPPED 2026-10-25: trust records introductions (introducer, time, SAS over the full classical+PQ key set, printed for out-of-band comparison) and refuses key-material changes under an existing label. Acceptance: CLI battery in test/run-tests-v4-pq.mjs + trust-flow checks. (enrollment/pairing — a spoofed enrollment or intercepted pairing code poisons every check that follows; trust-on-first-use).
Refit: M.17 — CLOSED BY MECHANISM
18. Traffic shape is still visible (even with the packet layer built: sizes, timing, and endpoints leak who talks to whom, when, and how much — no padding/shaping is designed).
Refit: M.18 — REDUCED TO A NAMED RESIDUAL
19. The defenses can be fired at the owner — PARTIALLY SHIPPED 2026-10-25: per-origin pending cap (32, shed-and-counted) + per-sender hourly registration budget (10,000) live in vaultd; the 10,000-forged-RPC fuzz acceptance remains to be run before this item leaves the open list. (forced mismatches to kill flows and quarantine peers, registration/wrap spam to bloat the store, approval flooding — denial of service against the armor itself).
Refit: M.19 — CLOSED BY MECHANISM
Annotation (Gemini fix pass, 2026-10-25, v1.1.1): narrowed further — the local sockets gained M.19-style budgets (per-channel connection caps, owner channel budgeted separately so a requester flood cannot starve it; per-connection frame cap; excess shed-and-counted and surfaced on the owner status), and the per-request full-registry reload is gone (in-memory registry, file-mtime invalidation). The 10,000-forged-RPC fuzz acceptance is STILL unrun; the item stays open.
20. Clocks can be lied to (expiry, staleness, and reseal cadence all trust the device clock — NTP attacks or manual clock changes bend them).
Refit: M.20 — CLOSED BY MECHANISM
21. Recovery material is a surface (the release .p12 and its keychain passphrase, vault backups, and the USB cold copy once it exists — stealable, and the signing backup currently has exactly one leg).
Refit: M.21 — CLOSED BY REMOVING THE CONDITION
22. The update path can carry the attack (a compromised release key or a bad update ships to the whole fleet; rolling back to an old, holed version is the same door — signing-key compromise is fleet compromise).
Refit: M.22 — CLOSED BY MECHANISM
23. Kingmaker is deliberately outside the armor (Addendum D, Robbie's ruling — anything that compromises Kingmaker rides the exception; named here because an honest register does not skip the designed gap).
Refit: M.23 — REDUCED TO A NAMED RESIDUAL
24. Root/admin on any host sits above every local tier (a compromised administrator account voids the daemon's local guarantees on that machine — standard, and outside the model).
Refit: M.24 — REDUCED TO A NAMED RESIDUAL
25. The phone tier and local silicon (locked iOS remains posture + detection against OS-level implants — removal is impossible for third-party software; and purely local, offline behavior of resident code on any device is outside mesh governance — the mesh governs network life, not silicon).
Refit: M.25 — REDUCED TO A NAMED RESIDUAL
26. The armor's own logs are a sensitive store — SHIPPED 2026-10-25 (mechanism): vaultd.log records are HMAC-sealed links in a hash chain (vaultd.mjs log-verify names the first broken line); closed logs rotate into log-segments/ sealed as v4 packages to the same identity. Named residual: the LIVE segment is chained, not sealed, while the daemon runs; beacon.log remains a plain append-only file. (audit chain and beacon records hold who, when, and what — an attacker who reads them gets the estate's map; they are data like any other and are not themselves armored).
Refit: M.26 — CLOSED BY MECHANISM

## Gemini-review pass (2026-10-25, shipped in v1.1.1)

An outside review (Gemini, pasted by the owner) made five claims against the shipped v4 code; each was verified line-by-line against the tree (GEMINI-REVIEW-VERIFICATION.md, local). The residuals that were real are closed here; the register above is annotated, never silently edited.

27. Outbox desync self-lockout (Claim 1 — confirmed as explicit design) — CLOSED BY THIS PASS. The never-issued beacon stands (a lost registration is still testified, never quietly forgotten), but it is no longer a dead end: a signature-valid package from an enrolled sender is recorded as a recovery candidate, and the owner's owner-channel approval derives the issuance from the package itself (the `armor register` derivation), registers it, and opens it in the same act. The offline outbox also stopped being invisible: queued registrations are surfaced with age on armor identity + daemon status and flushed before any new wrap proceeds when the daemon is reachable.
28. RESTORE-INFO one-shot burn (Claim 4's new wrinkle — found during verification, missed by the review) — CLOSED BY THIS PASS. The sidecar cross-check used to run only after the manifest's consuming unwrap, so a tampered or corrupted RESTORE-INFO.json burned the manifest's one-shot return permanently. unwrap-repo now opens the manifest verify-only (verify-open: every gate + owner approval, no consumption) and cross-checks the sidecar against the sealed counts BEFORE the return is spent; the approval arms the return (digest-bound, single-use, window-bound) so the restore still costs exactly one approval per package. A mismatch refuses with the manifest unburned; fixing the sidecar and re-running restores.
29. Registry-load amplification (Claims 2/3 residual — the review's verify-CPU mechanism was refuted: return-match checks precede signature verification; the residual per-request full-registry reload was real) — CLOSED BY THIS PASS. The registry lives in memory and reloads only when the file's mtime/size changes; external edits (the estate battery's own forgeries and deletions) are still seen on the next request, and every reload re-verifies the store's integrity tag (see item 1's annotation).

## Closure tracking (2026-10-24)
The refit for every item above is designed in SPEC Addendum M (`~/workspace/scripture-armor-v2-spec/SPEC.md`), closures M.1–M.26 matching this register's numbering, plus M.27 (the HERMES proof case). This register is now a closure-tracking register pending the refit build: an item leaves the open list only when its Addendum M acceptance battery passes on the built refit — on the same evidence rule as the rest of the spec, never on design alone.
