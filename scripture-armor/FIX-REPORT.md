# FIX-REPORT — Scripture Armor closed-loop fix build

Build location: `~/workspace/scripture-armor-fix/` (a copy; the original
`~/workspace/scripture-armor-standalone/` was never modified — it was under
an active pentest battery while this was built).
Basis: pentest verdict **SHIP AFTER FIXES**
(`~/workspace/scripture-armor-pentest-2026-10-23.md`) + Robbie's closed-loop
doctrine (`~/workspace/scripture-armor-doctrine-2026-10-23.md`).
Package format unchanged: `SCRIPTURE-ARMOR v1` frames are byte-compatible
with the original tools. Zero dependencies added. License untouched
(placeholder remains; the license is set at publish on Robbie's word).

## Test results

`node test/run-tests.mjs` — **48/48 checks passed, ALL TESTS PASSED**
(final run, after all edits). All 21 pre-existing baseline checks are green
(same names, same assertions; the harness now starts the daemon before
wrapping, because egress registration needs it — the behavior the new
doctrine mandates). 27 new checks cover the pentest fix list. Suite runs
in ~40 s.

## What changed, per file

### `vaultd.mjs` — the loop's boundary keeper

- **Issued-hash registry** (pentest fix #1/#2 core): new `registry.json`
  in the identity dir, mode 0600, atomic tmp+rename writes, re-read on
  every operation (survives restarts; consistent across local daemons
  serving one identity). Entry: `{canary, sha256, recipient_seal_fp,
  sender_sign_fp, expiry, issued_at, returned_at}`.
- **`register` daemon command**: accepts issuance batches; refuses
  per-entry any entry sealed to a different copy and any canary
  re-registered with a different sha256/expiry (conflict); identical
  re-registration is idempotent. Registrations are testimony-logged.
- **Return-match** in `handleUnwrap`, after the recipient check and
  **before** signature/expiry validation and before any pending entry
  exists. Presented frame is compared against its registry entry:
  no entry → beacon `never-issued`; entry consumed → beacon
  `replay-consumed`; sha256 differs → beacon `hash-mismatch` (expected
  hash included); **expiry differs → beacon `expiry-mismatch`**
  (expected expiry included — this kills proven attack A1: the honestly
  expired package whose expiry was edited to 2099 and re-signed under
  an attacker key unwrapped in the old build; it also can no longer
  resurrect the same canary the log had already refused); sender sign
  fingerprint differs → beacon `sender-mismatch` (the registry records
  and compares `sender_sign_fp` as a superset of the pentest's required
  fields, closing the re-sign variant where expiry is left untouched).
- **Beacon events** (pentest fix #3): distinct log records
  `{ts, event:"beacon", canary, sha256, reason_class, presented_path,
  surface:{daemon_label, seal_fp, socket}, expected_*}` in `vaultd.log`,
  and the client receives `{ok:false, error:"beacon: <class>", beacon:true,
  reason_class, …}`. Beacon refusals are never offered as approvals.
- **One-shot return**: a successful unwrap marks the registry entry
  returned (`returned_at`); replays beacon.
- **Approval surface** (pentest fix #4): pending entries and the
  `pending` list now carry `sender_sign_fp`, `registry_status`
  (`issued-by-this-machine`), and the requester's `context` string;
  the pending-approval log line carries them too. `status` reports
  registry issued/returned counts.
- **Raw-socket hardening** (unexecuted battery group D): request
  buffer capped at 1 MiB — an oversized unterminated frame is logged
  (`oversized-frame`) and the connection destroyed. Approve with no
  matching pending (covers no-pending, double-approve,
  approve-after-window) is refused **and logged**.

### `armor.mjs` — egress, restore hardening, inspect beacons

- **Egress registration**: `wrap` and `wrap-repo` (every part + the
  manifest) register issuances with the daemon after sealing
  (`--register-socket <path>` selects the daemon socket; default is the
  identity dir's socket).
- **Daemon-unreachable behavior** (design decision): if the daemon
  cannot be reached at wrap time, issuances are queued in
  `registry-outbox.jsonl` (0600) in the wrapping identity's store and
  sync on the next successful registration contact (any later wrap, or
  the new `armor.mjs register <file.scripture>…` command, which also
  serves to register packages wrapped by older tools). Wraps never fail
  on registration problems; they print exactly what happened. Until an
  issuance syncs, the daemon refuses the package as never-issued —
  stated plainly in the README.
  Entries the daemon actively refuses (wrong recipient, canary
  conflict) are dropped with a warning rather than queued forever: a
  refusal is a configuration fact, not a transient failure.
- **`inspect` beacons** (pentest fix #3, added scope): on signature
  invalid, inspect emits the same beacon record shape (reason_class
  `signature-invalid`, surface marked `via:"inspect"`) to stderr and
  appends it to `beacon.log` in the identity dir.
- **Restore hardening** (pentest fix #5), all in `cmdUnwrapRepo`:
  - manifest modes applied as `entry.mode & 0o777` — setuid/setgid/
    sticky never applied (proven attack B3: the 0o4755 plant now
    restores 0755);
  - `lstat` walk of every restore-path component (target root,
    manifest dirs, parents, the file itself) — any existing symlink
    component refuses the restore (proven attack B2);
  - every `part.package` must `path.resolve` inside the wrapped tree,
    validated for the whole file **before** the destination is opened
    (proven attack B4: refusal leaves nothing behind);
  - manifest self-validation: declared `fileCount` / `partCount` /
    `totalBytes` must equal actual entries / parts / summed sizes,
    before anything is created (proven attack C enabler);
  - `../` and absolute manifest paths still refused (held defense,
    unchanged).
- **Restore scale in the approval prompt** (pentest fix #5 / C):
  `wrap-repo` writes `RESTORE-INFO.json` (cleartext, advisory) with
  file/part counts and total bytes; `unwrap-repo` passes that scale as
  the manifest unwrap request's `context`, which the daemon shows in
  the pending entry the owner approves. After the manifest opens, the
  sealed counts are cross-checked against the sidecar; divergence
  aborts before any write. Legacy trees without a sidecar get a prompt
  that says the scale is undeclared, with self-validation still
  applied. (The 20,000-zero-byte flood now restores only under an
  approval that stated "20000 files, 0 bytes, 0 packages", with counts
  validated.)
- **`trust` hardening** (unexecuted battery group G):
  `parsePublicBlock` now validates key material — both public keys must
  decode to 32-byte X25519/Ed25519 points that construct; garbage
  blocks and fake keys are refused at trust time.

### `test/run-tests.mjs` — extended suite (21 baseline + 27 new)

New coverage, mapped to the pentest: wrap-repo registration + registry
0600; consumption on return; replay-consumed beacon; pending-surface
sender fp + registry status; double-approve / no-pending approve
refused + logged; **A1** re-signed expiry → `expiry-mismatch` beacon,
content never written; hash-edit re-sign → `hash-mismatch` beacon;
honest expired still refused `expired`; inspect beacon (stderr +
`beacon.log`); outbox queue on daemon-down wrap (0600, canary present,
never silently skipped); **A2** never-issued beacon; outbox sync via
`register`; registry persistence across restart (consumed stays
consumed, issued stays issuable); oversized-frame drop + daemon
survival + log; approve-after-window (400 ms daemon) refused;
**B3** setuid restore masked to 0755; RESTORE-INFO sidecar presence;
**B2** symlink-component refusal with no escape write; **B4**
part.package traversal refused pre-read; manifest count-mismatch abort;
**C** flood: scale in the approval prompt + 20,000 files restored under
exactly 1 informed approval; **G** trust garbage/fake-key refusal;
identity-store permissions (dir 0700; identity/registry/log/out 0600);
dns-profiles parse + placeholder scan. Held defenses re-verified by
the unchanged baseline checks (key block inside signed frame — tampered
glyph still `signature INVALID` / `bad-frame-signature`; AEAD
fail-closed via hash-checked restore; manifest hash chain via
part-hash verification at restore).

### `dns-profiles/` — new deliverable (Robbie, 2026-10-23 22:33)

Additive; ships in the repo with the fixed build.

- `scripture-armor-dns.mobileconfig` — one Apple profile (iOS + macOS):
  DNS Settings payload, DNS over HTTPS, server fields as marked
  operator placeholders (`https://dns.example-loop.invalid/dns-query`,
  TEST-NET-1 `192.0.2.53`), DoT variant noted in comments, a commented
  inactive VPN On Demand section, and plain-language
  PayloadDisplayName/Description stating what it does (DNS layer only).
  Parses under python3 `plistlib` (asserted in the test suite).
- `android-private-dns.md` — Private DNS (DoT) hostname steps with the
  same placeholder.
- `windows-doh.md` — Settings steps ("Encrypted only") + registry
  snippet, placeholders throughout; honestly notes per-interface
  config belongs to the UI/cmdlets rather than invented registry paths.
- `linux-resolved.conf` / `linux-stubby.yaml` — header-commented DoT
  snippets with the placeholders.
- README gains a full section, *DNS: the agnostic-tracks surface for
  traffic*: DNS is the one lookup protocol every OS already speaks, so
  profiles point device lookups at a resolver inside the operator's own
  loop over DoH/DoT — with the mandatory honest wording: **a DNS
  profile wraps the DNS layer (queries), NOT all traffic**; full-traffic
  wrap is the separate VPN posture. Operator fields, running a resolver
  on the loop's node (dnscrypt-proxy / AdGuard Home / Technitium named
  as examples, operator's choice, nothing vendored), and how enrolled
  devices relate to the loop (clients of the resolver; no keys, no
  vault rights) are all spelled out.
- Test suite parses the mobileconfig via `plistlib`, asserts the DoH
  endpoint is the marked placeholder, and scans the whole directory:
  every file carries the placeholder and no production-looking address
  appears anywhere.
- `package.json` `files` list gains `dns-profiles` so the published
  package includes it.

### `README.md` — complete rewrite

Now the complete doctrine document, per Robbie's escalated requirement
("explain the entire thing verbatim"): the doctrine section reproduces
his formulations in full and verbatim where he gave them (closed loop;
daemon checking generated hashes when packets leave; hashes generated
when information leaves; trojan-chameleon containment that does no
damage; the creating machine waits for the return hash to match; every
request already has a hash, now every hash gets Scripture Armor;
agnostic train tracks; the glyph correction — "Not letters —
unreadable, untranslatable glyphs with metadata for location and
identity reporting"; mismatch = built-in homing beacon; sight not
strike). Beneath it, the full technical explanation: both layers with
the AEAD/glyph roles never conflated, a field-by-field frame table,
egress/registry/outbox mechanics, the return-match gate order with the
A1 kill explained, one-shot semantics, owner approval and what the
approval surface shows, beacon record shape and reason classes, the
daemon protocol table, repo mode and every restore hardening, the DNS
section, full command reference, files table, and the honest limits
(loop-machine compromise voids everything; the canary is an
identifier whose reporting depends on the packet waking on an observed
network — presented to a daemon or inspected; no phone-home; cleartext
metadata; classical Ed25519/X25519 named as swappable). The retired
"adding letters" phrasing appears nowhere except inside the verbatim
correction that supersedes it.

## Design decisions worth flagging

1. **Registry is file-backed and re-read per operation** rather than
   held in daemon memory: restart persistence and multi-daemon
   consistency come free, and the re-test battery's restart scenarios
   exercise the real path.
2. **Registration is best-effort + outbox, never blocking the wrap.**
   The alternative (wrap fails when the daemon is down) would let a
   stopped daemon stop all egress; the doctrine's answer is stricter
   and simpler — an unsynced package is refused at return. Operators
   see the queue state on stderr at wrap time and in the outbox file.
3. **`sender_sign_fp` is registered and matched** beyond the pentest's
   five required registry fields, because A1's root cause was a frame
   re-signed under a different key; comparing expiry alone leaves the
   untouched-expiry re-sign variant open. It is not.
4. **The scale sidecar is advisory by design** — the sealed manifest is
   the authority; the sidecar exists only so a human sees the scale
   *before* the first approval. Divergence aborts. No format change:
   frames and manifests are untouched; the sidecar is a new file in the
   wrapped tree that older `verify` ignores.
5. **Beacon on inspect uses reason_class `signature-invalid` only** —
   inspect has no registry and no plaintext, so it cannot judge
   hash/expiry issuance; what it can prove is that the package does not
   verify. That is what it reports, no more.

## Doctrine conformance

Every doctrine point is implemented as specified; none were found
unimplementable. One scoping note: "location reporting" by the
metadata frame is implemented as the beacon record's `presented_path`
+ receiving surface (daemon label / seal fp / socket, or the inspecting
copy) — the truthful local facts a waking packet produces. The tool
contains no network phone-home, per the doctrine's own sight-not-strike
limit and the README's honest statement of it.

---

## Addendum — F1 gating fix (claim-at-pend), 2026-10-24

The independent re-scan of this tree (`scripture-armor-rescan-2026-10-23.md`)
returned SHIP AFTER FIXES with exactly one gating item:

- **F1 (MODERATE):** one-shot return was checked only at presentation;
  consumption was recorded after unwrap and never re-checked. Two
  *concurrent* presentations of the same honestly-issued package both
  pended as `issued-by-this-machine`, and approving both unwrapped
  both. (Sequential replay was already refused correctly.)

**The fix — claim-at-pend semantics in `vaultd.mjs`:**

1. When a package passes the return-match and is placed into
   pending-approval, the daemon atomically claims its registry entry
   (`claim: {id: <pending request id>, at: <timestamp>}`) in one
   synchronous load → re-validate → mark → save cycle against
   `registry.json` — the same read-modify-write the match decision
   stands on. A second presentation of the same canary while a claim
   is live beacon-refuses (`reason_class: "replay-claimed"`, with the
   holding pending id and claim time recorded) and never creates a
   twin pending.
2. On approval execution the entry is consumed (existing one-shot
   semantics) and the claim is cleared in the same registry write.
3. On pending expiry (approval window), on the requester disconnecting
   unapproved (the refusal path), on a failed unwrap, and on daemon
   shutdown cleanup (SIGTERM/SIGINT), the claim is **released** —
   holder-checked by pending id, so one pending can never release
   another's claim. A released claim is not a consumption:
   `returned_at` is untouched and the package may pend again.
4. `handleApprove` re-validates claim ownership before executing: the
   approving pending must be the claim holder. A stale approval
   (entry already consumed) or a foreign one (claim held by another
   pending) is refused as `claim-not-held`, is logged, drops that
   pending, and mutates no registry state.
5. Registry writes keep the existing discipline (atomic tmp+rename,
   mode 0600). No package-format changes. No new dependencies.

**Regression tests** — five new checks in `test/run-tests.mjs`, all
against the live daemon:

- concurrent double-presentation of one issued package: the second
  beacon-refuses `replay-claimed` and never pends; the beacon record
  lands in the testimony log;
- the live pending holds the registry claim (`claim.id` == pending id,
  `returned_at` still null);
- approve-both attempt: exactly one output file is ever produced (byte
  identical to the source), the second approval is refused
  (`no-matching-pending-request`), the entry ends consumed with the
  claim cleared;
- claim release on requester disconnect: re-presentation pends and
  unwraps byte-identical;
- claim release on window expiry (800 ms window daemon): the timed-out
  presentation leaves no claim and no consumption, and the package
  pends normally when presented again.

**Suite counts:** full run after this fix — **53/53 checks passed,
ALL TESTS PASSED** (the 48 prior checks all stay green, plus the 5 new
F1 checks above).

**Documentation:** the README's return-flow description now documents
claim-at-pend, `replay-claimed`, `claim-not-held`, and claim release;
its threat model now names the re-scan's three LOW findings (F2–F4)
plainly as known limits — the registry, the registration outbox, and
the testimony logs are unauthenticated local files whose only
protection is the 0700 store / 0600 permissions, under the
store-compromise caveat that already voids the loop. No code changes
were made for F2–F4, per the gating brief.
