# Gemini-review fix pass — report (2026-10-25, shipped as v1.1.1)

Order (Robbie, verbatim): "fix them in the scripture armor repo i made public immediately."
Verdicts this pass implements: `GEMINI-REVIEW-VERIFICATION.md` (local). Register updates:
`OPEN-SURFACES.md` items 1 + 19 annotated, new entries 27–29 (local only, not pushed).

**Published:** `ronininc/scripture-armor` main, commit
`683db5b2e99e830e7d91a956b6c308aa9c1ebdde` (parent `bff9668f`), package version **1.1.1**.
Pushed paths: `armor.mjs`, `vaultd.mjs`, `README.md`, `package.json`,
`test/run-tests-gemini-fix.mjs`, `test/run-tests-v2-phase4.mjs` (see item 7 for why the
sixth path rides). Read-back proof: every pushed file's remote blob SHA equals its local
blob SHA — armor.mjs `515c146b…`, vaultd.mjs `bbdf715a…`, README.md `4f32aeb9…`,
package.json `2237aa03…` (content shows `"version": "1.1.1"`), gemini-fix suite
`3546eaf7…`, phase4 suite `7461d6fc…`. Sync record advanced (4 entries, head `683db5b2…`).

**Battery: 431 checks, all green** — main 53/53, scan 83 passed / 0 failed / 4 deferred,
cell 94/94, airlock 61/61, estate 27/27, phase 4 68/68, v4-pq 22/22, gemini-fix 23/23
(new). One honesty note on method: the airlock suite's case 4 (binary scan crossing)
races its test peer's 25 s lifetime when the machine is loaded — it failed twice in
back-to-back sweep chains run immediately after the cell suite, and passed solo on an
idle machine three times (pristine tree included). Its solo verdict is the one counted.

## Two pre-existing defects found during this pass (not Gemini claims)

The brief's stated baseline (408/408) did not survive contact: two checks failed on
the *unmodified public tree* before any fix work touched them. Both are disclosed
here rather than silently absorbed, because the README now prints an exact total.

6. **`armor verify` coverage accounting was broken for every v4 tree** (scan suite:
   "verify passes on the accounted tree", "planted unlisted package FAILs verify,
   named"). `cmdVerify` opened the sealed manifest with `unsealFileKey(me.sealPriv, …)`
   — a bare X25519 key — which v4 frames refuse by design ("downgrade is a refusal,
   not a fallback"), so the accounting always threw and verify always failed when
   `--identity-dir` was passed. Proven pre-existing: a pristine clone of public HEAD
   fails the same two checks solo (76 passed / 5 failed, the other 3 being v1-fixture
   paths that don't resolve outside the workspace tree). **Fix (product code, one
   line):** pass the identity — `unsealFileKey(me, …)`. Scan suite now 83/0.
7. **Phase-4 S4 asserted a v3 frame against code that only seals v4** ("the frame is
   v3 and carries no sha256 field"). `sealPlaintext` has sealed `v: PACKAGE_V4`
   unconditionally since the v4 ship; the check is unsatisfiable at public HEAD
   (68/68 was last true in the v2-era commit `893575c` message, before the v4 seal
   landed in `3a1fa72`). The guarded *property* — no offline plaintext-hash oracle —
   holds in v4 and is asserted by the same check plus its neighbors (keyed `commit`
   present, `sha256` absent, brute force over 10,000 PINs confirms nothing, two wraps
   unlinkable). **Fix (test only):** the format literal updated v3 → v4 (check name,
   assertion, section header); no product behavior changed. This is why
   `test/run-tests-v2-phase4.mjs` rides the push: leaving the public copy stale would
   leave the public battery red against the total the README states.

## The five fixes

### 1. Outbox desync — recovery registration + loud outbox (Claim 1)
- **Daemon (`vaultd.mjs`):** the never-issued **beacon stands unchanged** — the
  battery pins it (main-suite A2) and it is the loop's testimony. What changed is
  that it is no longer a dead end: when a presented package's frame signature
  verifies, its sender is this copy or an enrolled peer, the frame is unexpired and
  unrevoked, and the registry's integrity stands, the daemon records a **recovery
  candidate** (bounded map, pruned, dropped the moment the canary registers through
  any ordinary path). Only the owner's explicit owner-channel approval
  (`vaultd.mjs recovery` to list, `vaultd.mjs approve --id <candidate>`) executes
  recovery: the package is re-read and re-verified as it stands *now*, the issuance
  is derived from the package itself (the same derivation `armor register`
  performs), registered with `registered_via: 'owner-recovery'`, and the package is
  opened in the same act. A presentation alone never registers anything; an
  unenrolled sender or a bad signature earns no candidate (estate[12]'s Tier-0
  refusal is untouched).
- **Armor (`armor.mjs`):** the offline queue is loud — `armor identity` and the
  daemon's owner status report unsynced count + oldest age, and `cmdWrap` flushes
  the outbox *before* sealing whenever it is non-empty and the daemon is reachable.
- **New tests (gemini-fix 1–8):** wrap with daemon down → queue lost → beacon
  never-issued preserved → candidate recorded → owner approval registers
  (`owner-recovery`) + opens byte-identical → registry shows the return consumed;
  tampered twin earns no candidate.
- Register #27 annotated closed-by-this-pass.

### 2. IPC flood + registry reloads (Claims 2 + 3 residuals)
Claim 3's core stood refuted (return-match checks precede signature verification —
untouched, not reordered). The real residuals closed:
- **Socket budgets (`vaultd.mjs`):** per-channel admission caps (requester 64 live
  connections, owner 16 — separate budgets so a requester flood cannot starve the
  owner channel) and a 512-frame per-connection cap; excess is shed-and-counted
  (M.19 style, logged at 1 and every 100th) and surfaced on owner status as
  `socket_shed`. The mesh listener is untouched (already signed + frame-capped).
- **Registry cache (`vaultd.mjs`):** the registry lives in memory and reloads only
  when the file's mtime/size changes; callers get isolated clones (semantics
  identical to the old fresh-parse-per-request). External edits are still seen on
  the next request — the estate battery's mid-run forgeries and deletions behave
  exactly as pinned (conflicts surface, losses beacon, sync repairs).
- **New tests:** 70-connection requester flood → owner status still answers, shed
  counted; 600-frame single-connection flood → shed counted; external registry
  deletion picked up via mtime without restart; re-registration restores the count
  and heals integrity.

### 3. RESTORE-INFO one-shot burn (Claim 4's wrinkle — the real find)
- **Daemon:** new requester command `verify-open` — the unwrap's full gate sequence
  and owner approval, plaintext handed back, registry entry **not** consumed. An
  approved verify-open arms a **verify grant** (digest-bound, single-use,
  window-bound): the consuming unwrap that follows re-runs every gate and executes
  under the same owner decision — so a restore still costs exactly one approval per
  package (the battery pins those counts: 9 for 9 packages, 1 for the flood tree).
- **Armor:** `unwrap-repo` verify-opens the manifest first and cross-checks the
  sidecar against the sealed counts *before* the return is spent; a mismatch refuses
  with the precise `restore scale mismatch` error and the manifest unburned; the
  original post-open cross-check remains as defense-in-depth.
- **New tests:** tampered sidecar → refusal → manifest `returned_at` still null →
  sidecar fixed → retry succeeds, tree restored byte-for-byte.
- Register #28 annotated closed-by-this-pass.

### 4. Unsigned stores — HMAC integrity tags (Claim 5, register #1)
- **Mechanism (`armor.mjs` + `vaultd.mjs`):** `identity.json`, `addressbook.json`,
  and `registry.json` carry HMAC-SHA256 tags keyed from the identity via HKDF
  (salt `scripture-armor/store`, info `scripture-armor/store/v1` — the M.26
  pattern), verified on every load. The address book's tag covers key material +
  introduction records per label; routing fields (`daemon_socket`, `mesh`) sit
  outside it by design — the estate tooling edits routing in place, and no trust
  decision rests on it. The identity tag is verified before any key is trusted;
  the book tag before any peer is used; both fail the load closed with a precise
  `store-integrity: …` error.
- **Registry scoping (deliberate):** a registry tag mismatch is logged loudly,
  surfaced on owner status (`registry_integrity`), and fails closed exactly where
  entries would be *trusted* — no presentation opens — while registration and the
  estate sync/repair machinery keep running, and the next legitimate write
  re-tags (heals) the store. A tag stripped by an external rewrite of a
  previously-tagged store is detected as tamper, not mistaken for a legacy store.
  Fail-closed-at-load for the registry would have bricked the estate battery's
  pinned self-repair (sync must see forged/deleted entries); the scoping is the
  smallest change that makes tampering loud and unusable without breaking the
  loop's own healing.
- **Migration:** pre-tag stores gain tags in place on first load — fingerprints,
  trust entries, and registry contents untouched (asserted by test).
- **Not claimed:** this is detection, not the M.1 countersigned store — M.1
  remains designed-not-built in the register, and a same-uid writer who
  re-derives the tag from the identity file stands inside the local trust
  boundary (register #4).
- **New tests:** tampered identity → load throws `store-integrity`; swapped peer
  key in the book → load throws; routing edit → loads fine; tampered registry
  entry → presentation refused with the precise error + the tamper testified in
  `vaultd.log`; stripped stores migrate with seal/sign fingerprints identical.

### 5. Register updates (local only — `OPEN-SURFACES.md` was not pushed)
Item 1 annotated (detection half shipped; M.1 still designed-not-built), item 19
annotated (socket budget + registry cache shipped; the 10,000-forged-RPC fuzz
acceptance is **still unrun** and the item stays open), and a new
"Gemini-review pass" section records residuals 27 (Claim 1), 28 (Claim 4
wrinkle), 29 (Claims 2/3 residual) as closed by this pass.

## README (updated only where the proven fixes entitle)
- Closed-loop section: registry held in memory / re-read on change; the three
  stores carry integrity tags; the outbox is surfaced with age and flushed before
  a wrap; recovery candidates + owner approval described.
- Repo mode: the sidecar cross-check's verify-first order stated (and why).
- Tests section: the battery total — **431 checks** with the per-suite
  breakdown — as the final sweep printed it. Nothing rounded, no new claims
  beyond the battery.
