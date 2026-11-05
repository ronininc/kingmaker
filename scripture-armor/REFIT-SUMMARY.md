# Scripture Armor refit — Addendum M summary (2026-10-24)

One line per open surface: the closure in one simple sentence, and its honest grade. Full text: SPEC Addendum M (`~/workspace/scripture-armor-v2-spec/SPEC.md`). Nothing here is built yet — the refit is designed, and each item closes for real only when its battery passes.

1. The daemon only trusts a store that another estate machine has countersigned, so a quietly edited registry refuses instead of resurrecting anything — CLOSED BY MECHANISM.
2. The identity key exists whole only in the moment it is used, assembled from pieces held by several machines, so no single machine can be robbed of it — CLOSED BY MECHANISM.
3. Every old-format package is re-wrapped on a deadline, and after it the code that could read the old format is gone — CLOSED BY MECHANISM.
4. The daemon moves out of the owner's account into its own service account, and owner approvals become signatures instead of a stealable token — CLOSED BY REMOVING THE CONDITION.
5. Programs never run in a shared-kernel room again — every activation runs behind a hypervisor, here or on an estate machine that has one, or it doesn't run — CLOSED BY REMOVING THE CONDITION.
6. Cell machines keep no swap copy, no hibernation image, and no crash dump of anything the armor touched — REDUCED TO A NAMED RESIDUAL (plaintext still exists in the running machine's memory while a program runs; that is physics).
7. The estate's proof battery now runs on real machines with a hostile member inside it, and split-estate behavior is specified — CLOSED BY MECHANISM.
8. The armor takes its seat in the packet path — every estate flow is sealed when it opens and receipted as it runs (Addendum K, built) — CLOSED BY MECHANISM.
9. On services that will check, a login becomes a live proof re-made by the device instead of a stealable token (Addendum K binding, built) — REDUCED TO A NAMED RESIDUAL (a service that refuses to verify keeps its bearer logins; verification is an act only that service can perform).
10. Ronin's app code ships as the meaningless layer and unwraps only on the device it was bound to, so Inspect Element shows nothing (Addendum L, built) — CLOSED BY MECHANISM.
11. The armor stops needing the scanner to be right — anything that runs, runs in a disposable room with no network, no persistence, and no keys, and is watched while it runs — CLOSED BY REMOVING THE CONDITION.
12. Anything crossing inward arrives as data on a channel that cannot command, and consequential actions must trace their authority to the owner, not to a document — CLOSED BY REMOVING THE CONDITION.
13. Every approval becomes a signature over the exact thing approved, shown with its full record, and pendings expire instead of approving themselves — REDUCED TO A NAMED RESIDUAL (an owner who reads the full record and deliberately approves a bad package cannot be vetoed; his authority over his own estate is the founding rule).
14. The armor's own tools are pinned, scanned, and verified at the moment they run, and update only the way packages move — never silently — CLOSED BY MECHANISM.
15. The machine wakes up already refusing — from power-on, only the control plane's handshake may cross until the mesh is up — CLOSED BY MECHANISM.
16. The control plane is demoted to plumbing: it can carry packets but can no longer create trust, enroll anyone, or change policy — CLOSED BY REMOVING THE CONDITION.
17. Every device can show who introduced it, back to one in-person moment, and pairing codes are bound to the new device's own key — CLOSED BY MECHANISM.
18. Estate links run as a constant-rate, fixed-size stream that looks the same carrying a burst, a trickle, or nothing — REDUCED TO A NAMED RESIDUAL (an observer watching both ends of an interactive flow can still correlate its timing; removing that needs delays that would kill the sessions).
19. The armor's defenses can only be triggered by evidence — forged noise is refused cheaply and changes nothing, and abuse burns only the abuser's own budget — CLOSED BY MECHANISM.
20. No decision trusts any single clock: order comes from the chains, and time is the estate agreeing with itself — CLOSED BY MECHANISM.
21. Recovery has three legs in three places under the split identity, so no single stolen artifact or passphrase can recover anything — or prevent recovery — CLOSED BY REMOVING THE CONDITION.
22. An update becomes an ordinary package that no single key can sign, that can only move forward, and that must prove itself on one machine before the estate takes it — CLOSED BY MECHANISM.
23. Kingmaker stays exactly where it was put, and every door its material reaches checks the material instead of the sender, while approvals move to the owner terminal of record — REDUCED TO A NAMED RESIDUAL (Kingmaker itself stays unsubjected by Robbie's standing ruling, Addendum D; what closes is every path for riding the exception).
24. Root keeps the one machine it owns and loses the estate — no whole keys, no forgeable store, everything attributable, and revocation ends its estate life — REDUCED TO A NAMED RESIDUAL (root is the platform's own definition of total local authority; only the owner, acting from outside, outranks it).
25. The phone holds nothing worth stealing and everything it sends crosses the governed mesh where an implant's lifelines are visible and cuttable — REDUCED TO A NAMED RESIDUAL (no third-party software can remove an OS-level implant from a locked iPhone — platform law — and purely local offline behavior is outside any network's reach).
26. The armor's logs are written as chained, sealed records — ciphertext to a thief, and self-confessing under tampering — CLOSED BY MECHANISM.

**M.27 — The HERMES case (proof case, from the reel Robbie flagged):** a working tool with a hidden decoded-at-runtime fetcher is defeated at every stage — scanned and confidence-capped at intake, decoded inside a hypervisor cell with no network, its second-stage fetch and control channel refused at the governed exit, its harvest absent and dying with the cell, and its whole family refused on sight across the estate once one sample's hash is convicted; it stands in the battery permanently (exercises items 11, 12, and 14).

**Tally:** 13 CLOSED BY MECHANISM · 6 CLOSED BY REMOVING THE CONDITION · 7 REDUCED TO A NAMED RESIDUAL · 0 unaddressed.
