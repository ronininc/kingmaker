# Gemini Red-Team Analysis — Claim-by-Claim Verification

**Scope:** Gemini's five "implementation weaknesses" checked against the SHIPPED v4 tree
(`armor.mjs`, `vaultd.mjs`, `open-standalone.mjs`) and the internal register
(`OPEN-SURFACES.md`). Verification only — no code changed in this pass.
**Date:** 2026-10-25. **Verifier:** Muse (subagent pass for Robbie).

## Verdict table

| # | Claim (short) | Verdict | Already in OPEN-SURFACES? | Disposition |
|---|---|---|---|---|
| 1 | Outbox desynchronization → never-issued lockout | **CONFIRMED as designed behavior; impact overstated** | Not as its own item (adjacent: #1, #19) | REGISTER the residual window |
| 2 | IPC flood exhausts the event loop via the 1 MiB-capped socket | **PARTIALLY CONFIRMED** (mechanism real, attacker position already game-over) | Covered in substance by #4 + #19 | REGISTER as named residual |
| 3 | Mismatched frames burn dual-signature CPU despite the 32/origin cap | **PARTIALLY CONFIRMED — core mechanism REFUTED** (verify runs only *after* all metadata checks pass) | #19 (budgets shipped; fuzz acceptance still open) | REJECT as stated; REGISTER the registry-load amplification note |
| 4 | RESTORE-INFO sidecar can lie at approval time; mismatch "panics and crashes" | **PARTIALLY CONFIRMED** — sidecar + prompt path real; **"panic and crash" REFUTED** | Not registered | REGISTER (incl. one wrinkle Gemini missed, below) |
| 5 | Local stores unsigned — registry vandalism breaks recognition | **CONFIRMED + ALREADY-REGISTERED** | Yes — #1, #4, #24 | REGISTER — already registered; keep M.1 named-not-built |

**Nothing in Gemini's list is a confirmed-and-new security break.** Every claim either
restates a documented design decision / the local-trust boundary, is already in the
register, or misorders the code. The one genuinely new finding in this pass is a
side-effect of Claim 4's flow that Gemini did *not* name (see Claim 4, "wrinkle").

---

## Claim 1 — Outbox desynchronization

**Verdict: CONFIRMED (mechanism, by explicit design) — "permanent lockout" overstated.**

Evidence:
- The outbox exists exactly as described: `armor.mjs:640-648` (design comment),
  `armor.mjs:749-768` (`registry-outbox.jsonl`, written mode 0600), and
  `armor.mjs:945-1006` (`registerIssuances` — only an *unreachable* daemon queues;
  a daemon that answers and refuses drops the entry with a warning instead).
- The consequence Gemini predicts is the code's own stated doctrine, verbatim in the
  source comment at `armor.mjs:646-648`: *"Until an issuance syncs, the daemon will
  refuse that package as never-issued — that is the doctrine working as designed."*
- The operator is told at wrap time, not surprised later: `armor.mjs:1002-1004`
  prints `WARNING: vault daemon unreachable — … queued in registry-outbox.jsonl` and
  `Queued packages are refused as never-issued until the queue syncs`; `register`
  exits non-zero while entries remain queued (`armor.mjs:1516`).
- The daemon side behaves as claimed: an unwrap whose canary is absent from the
  registry beacons `never-issued` and never pends (`vaultd.mjs:986`; same at
  `vaultd.mjs:1099`, `1320`, `1563` for the other present paths).
- **Where Gemini overstates:** "permanently locking the user out … until a manual,
  out-of-band override." Three shipped recovery paths exist, none out-of-band:
  1. `armor register <file.scripture>…` re-derives the issuance from the package file
     itself (`armor.mjs:1501-1519`) — the outbox file is a queue, not the only copy
     of the fact.
  2. Owner-channel registration: the owner can register entries directly
     (`vaultd.mjs:739-746`, `handleRegister` on the token-gated owner socket).
  3. The issuer-side memory `issued-log.jsonl` is appended *before* any transport
     outcome (`armor.mjs:945-950` — "the outbox may clear, the memory does not"),
     and mesh sync flags divergence as `counterparty-never-issued` conflicts
     (`vaultd.mjs:2412`, `vaultd.mjs:2420`) — the desync is *detectable*, not silent.
  What must actually be lost for Gemini's scenario: the outbox file **and** the
  package files **and** the issued-log, all before the next wrap/register contact
  (any later wrap flushes the queue, `armor.mjs:949-957`).

**Severity (armor's own threat model):** low. Requires the daemon to be down at wrap
time plus local store destruction in the window before the next contact. No
confidentiality impact — a never-issued refusal is fail-closed.

**Disposition: REGISTER** one line: "Offline-queue window: issuances wrapped while
the daemon is unreachable are refused as never-issued until the outbox syncs; loss of
outbox + package files + issued-log together makes an issuance unrecoverable except
by re-wrap." No code change warranted.

---

## Claim 2 — IPC flood / event-loop exhaustion

**Verdict: PARTIALLY CONFIRMED.**

Evidence:
- The frame cap is exactly as Gemini states: `vaultd.mjs:2736`
  (`MAX_FRAME_BYTES = 1024 * 1024`), enforced at `vaultd.mjs:2770-2775` and for the
  mesh listener at `vaultd.mjs:2939` — an unterminated oversized frame is logged and
  the connection destroyed.
- The flood mechanism is real in structure: all request handling is synchronous on
  Node's single event loop (`vaultd.mjs:2766-2893`, `attachHandlers` — handlers run
  inline in the `data` callback). There is **no** connection cap, request-rate
  limit, or per-connection budget on the local sockets. Two amplifiers Gemini did
  not name: (a) `status`/`pending` handlers re-read and re-parse the *entire*
  registry from disk per request (`vaultd.mjs:2780` → `loadRegistry`,
  `vaultd.mjs:313-319`); (b) `handleUnwrap` synchronously `readFileSync`s the
  caller-named package path with no size cap (`vaultd.mjs:957-963`) before any
  check runs. The owner socket lives in the same process/event loop
  (`vaultd.mjs:2896-2907`), so requester-socket load does delay owner approvals.
- Calibration Gemini omits: reaching the socket at all requires being the owner
  user. The daemon *refuses to serve* unless the socket directory is private
  (`vaultd.mjs:235-246`), the socket file is chmod 0600 (`vaultd.mjs:2899`), the
  owner dir is 0700 with a per-daemon token (`vaultd.mjs:2747-2756`). A same-uid
  process that can flood the socket can already simply *read* `identity.json`
  (0600 = readable by every process running as the owner) and take the private
  keys outright (`armor.mjs:180`). Event-loop DoS adds nothing to an attacker who
  already holds total compromise; against other local users the door doesn't open.
  Malformed JSON specifically is the *cheap* case — parse failure returns
  `bad-json` immediately (`vaultd.mjs:2779`).

**Severity:** negligible inside the stated model (same-uid is inside the boundary —
register item #4 says exactly this); a nuisance only against a buggy-but-benign
local client looping requests.

**Disposition: REGISTER** as a named residual under the #19 umbrella — "local
socket has no rate/connection budget; load amplification via full-registry loads —
accepted because the socket is reachable only by the owner user, who already holds
the keys." Smallest optional fix if ever wanted: a per-connection line-rate shed
in `attachHandlers` — not recommended as a priority.

---

## Claim 3 — State-pool flooding / verification CPU

**Verdict: PARTIALLY CONFIRMED — and its central mechanism is REFUTED by check ordering.**

Evidence:
- The caps are real: `PENDING_CAP_PER_ORIGIN = 32` (`vaultd.mjs:264`), enforced at
  `vaultd.mjs:1119` (excess shed-and-counted, owner sees a count); registration
  budget `REGISTER_BUDGET_PER_SENDER_HOUR = 10000` (`vaultd.mjs:265`), enforced at
  `vaultd.mjs:536` — both are the shipped M.19 mechanisms.
- **The refuted part:** Gemini says pseudo-valid frames "with mismatched metadata"
  hit "public-key verification (Ed25519 + ML-DSA-65)" before being dropped. In
  `handleUnwrap` the order is the opposite — every metadata check runs *before*
  signature verification:
  1. recipient / KEM-recipient match (`vaultd.mjs:975-984`)
  2. registry presence — never-issued beacons out (`vaultd.mjs:986`)
  3. replay-consumed (`vaultd.mjs:993`), digest match (`vaultd.mjs:1004`), expiry
     match (`vaultd.mjs:1009`), sender match (`vaultd.mjs:1012`), revocation,
     scan/tier match (`vaultd.mjs:1043-1054`)
  4. **only then** `verifyFrameSignature` (`vaultd.mjs:1068`) — the dual
     Ed25519 + ML-DSA-65 verify (`armor.mjs:477-493`).
  A frame with mismatched metadata therefore costs a file read, a parse, and a
  registry load — never a signature verification. To reach the verify step at all,
  a frame must match a *live* registry entry on canary + digest + expiry + sender,
  i.e. be a bit-level replay of a genuine package with a corrupted signature.
- The registration door is likewise gated *before* cost: `handleRegisterSigned`
  verifies the registration signature first (`vaultd.mjs:758-759`) and refuses
  untrusted signers before entries are processed — flooding it requires a trusted
  peer's key, and the 10,000/hr budget then applies per that sender.
- **The true residual** (the honest kernel of the claim): per-request cost is
  dominated by full-registry `readFileSync` + `JSON.parse` (`vaultd.mjs:313-319`),
  invoked several times per unwrap — CPU per junk request grows with registry
  size. Same-uid reachability calibration from Claim 2 applies unchanged.

**Severity:** low; a CPU-tilt against a same-user process that already holds the
keys, with the expensive primitive (dual verify) correctly ordered behind cheap
refusals — the design Gemini recommends is the design that shipped.

**Disposition: REJECT as stated** (the signature-CPU vector does not exist as
described). **REGISTER** the one true sub-point: "request cost scales with
registry size due to full-store loads per operation" — an efficiency note, not a
hole. Note the register already keeps #19 open for exactly one related item: the
10,000-forged-RPC fuzz acceptance has still not been run.

---

## Claim 4 — RESTORE-INFO.json sidecar

**Verdict: PARTIALLY CONFIRMED.** Sidecar + prompt path: confirmed. Deception
impact: bounded by design. "Panics and crashes": **REFUTED.**

Evidence:
- The sidecar exists verbatim: `armor.mjs:1811-1823` — cleartext
  `RESTORE-INFO.json`, format `scripture-armor-restore-info/1`, fields
  `fileCount / partCount / totalBytes`, written mode **0644**, with the header
  comment stating it is advisory and untrusted.
- The numbers *do* reach the owner approval prompt: `cmdUnwrapRepo` reads the
  sidecar (`armor.mjs:1912-1917`) and embeds its figures in the `context` string
  of the manifest unwrap request (`armor.mjs:1919-1923`) — the context the daemon
  shows the owner at approval. Gemini is right that a tampered sidecar changes
  what the prompt says. Two mitigations are in the shipped text: the prompt
  string itself reads *"(declared by RESTORE-INFO.json; verified against the
  sealed manifest once opened)"*, and what the owner approves at that step is
  opening the **manifest only** — every part still crosses the daemon separately
  and is hash-checked against the sealed manifest (`armor.mjs:2016+`).
- The cross-check Gemini concedes exists, fires *before anything is written*:
  `armor.mjs:1957-1968` refuses with `restore scale mismatch: … — refusing`
  after the manifest opens and before directory creation / part writes
  (first restore write is the `mkdirSync` under step 2, `armor.mjs:~1999`).
  The manifest is also validated against its own entries first
  (`armor.mjs:1948-1956`).
- **"Panic and crash" is wrong.** `armor.mjs`'s `main()` wraps every command:
  errors print `error: <message>` and exit 1 (`armor.mjs:2285-2308`). A mismatch
  produces a clean non-zero exit with a precise message — a pipeline sees a
  *failed step it can log and stop on*, not a crashed process.
- **The wrinkle Gemini missed (new in this pass):** the cross-check runs *after*
  the manifest package has been unwrapped through the daemon — and unwrap is
  one-shot: the manifest's registry entry is consumed (`returned_at` set) by the
  successful open. So a tampered sidecar doesn't just abort the restore; it
  **burns the manifest's return**. Fixing the sidecar and re-running gets a
  `replay-consumed` beacon (`vaultd.mjs:993-1002`), not a second chance. Recovery
  is re-wrap (or reseal/supersede on the sender side), not edit-and-retry. This
  is an availability sharp edge in an otherwise fail-closed flow.
- Minor: sidecar mode 0644 makes a wrapped tree's file count and total size
  readable by any local user — consistent with the packages themselves (0644),
  but it is metadata the register's item #18 family (traffic shape) would call
  visible-by-design.

**Severity:** low for deception (prompt labels provenance; payload cannot apply —
Gemini concedes this); medium-low for availability in automated restore pipelines
(burned manifest return on sidecar tamper *or sidecar corruption*).

**Disposition: REGISTER** — "unwrap-repo approval scale is advisory-labeled
sidecar data; a sidecar/manifest divergence refuses cleanly (exit 1) before any
write, but after the manifest's one-shot return is consumed — recovery is re-wrap,
not retry." Optional small FIX if Robbie wants it: have `cmdUnwrapRepo` print the
sidecar's declared scale with an explicit UNTRUSTED banner *before* the manifest
unwrap is requested, so the owner's expectation is set by the CLI rather than
only inside the daemon prompt context.

---

## Claim 5 — Unsigned local identity stores

**Verdict: CONFIRMED — and ALREADY-REGISTERED (register items #1, #4, #24).**

Evidence:
- No signature/MAC/integrity block exists on any of the three stores:
  `identity.json` is parsed blind on load (`armor.mjs:124-128`) and written via
  `writeSecret` (0600) at `armor.mjs:180`; `addressbook.json` likewise
  (`armor.mjs:219-228`); `registry.json` likewise (`vaultd.mjs:311-328` —
  atomic tmp+rename, mode 0600, no integrity check in `loadRegistry`).
- The daemon does trust the registry at startup and per operation —
  `loadRegistry` is re-read on every operation (`vaultd.mjs:313-319`), so
  injected/deleted entries take effect exactly as Gemini describes, and a
  deleted entry produces `never-issued` refusals for genuine packages
  (Claim 1's path).
- What *is* integrity-protected in the shipped tree, for contrast: `vaultd.log`
  is an HMAC-sealed hash chain (M.26, shipped 2026-10-25); revocation records
  count only when their signatures verify (`vaultd.mjs:345-360`). The three
  stores Gemini names are not exceptions to a general MAC discipline — they
  are plain files by design, protected by the 0700 store directory + 0600 modes,
  and the daemon's refusal to serve from a non-private directory
  (`vaultd.mjs:235-246`).
- **Already registered, in the register's own words:** #1 — "The vault store
  can still be edited by anything running as the owner (registry resurrection —
  prevention designed in Addendum K.1, unbuilt; detection only today)"; #4 —
  "same-uid is inside the local trust boundary"; #24 — root/admin sits above
  every local tier. The countersigned store (Addendum M.1) remains
  designed-not-built, as stated to Robbie when v4 shipped.
- Calibration: the vandalism Gemini describes is *strictly weaker* than what
  the same attacker position already grants — a process running as the owner
  can read `identity.json` and take `seal_priv` / `sign_priv` / `kem_priv` /
  `mldsa_priv` outright (total confidentiality + forgery compromise), instead
  of merely deleting registry entries (availability). The claim's only
  independent content is the availability angle, and that is precisely
  register item #1.

**Severity:** as a *new* risk: none — it restates the documented local-trust
assumption. As tracked debt: item #1 stands until the countersigned store (M.1)
is built.

**Disposition: REGISTER — already registered.** No new entry needed; keep M.1 on
the named-not-built list and do not let the register's "Refit" annotations be
read as closure — per the register's own rule, an item leaves the open list
only when its acceptance battery passes on the built refit.

---

## Summary for the record

- Gemini's factual groundwork was mostly accurate (outbox, 1 MiB cap, 32/origin
  cap, sidecar, unsigned stores all exist as described) — this reads like a
  source-informed review, not a hallucinated one.
- Its *impact* claims repeatedly omit the two facts that bound them: the socket
  and stores are reachable only by the owner user (who already holds the keys),
  and the code's check ordering (metadata before signatures; cross-check before
  writes; clean exit-1 refusals instead of crashes).
- Net new items for the register: the Claim 1 residual window wording, the
  Claim 2/3 registry-load amplification note, and the Claim 4 burned-manifest-
  return wrinkle. No fixes recommended as urgent; M.19's fuzz acceptance and
  M.1's countersigned store remain the honest open items they already were.
