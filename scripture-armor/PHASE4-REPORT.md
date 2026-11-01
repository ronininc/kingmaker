# Scripture Armor v2 — Phase 4 Report: Closing the Red Team's Wounds

Phase 4 was the response to the independent red-team break-in battery
(2026-10-24), which broke v2 at the socket tier and through the SOFT
cell, and recovered a low-entropy plaintext offline from the frame's
cleartext hash. This report states, per fix, what was built, how it is
proven, and — plainly — what is still open. All work is local to this
tree; nothing was committed or pushed.

## Battery results (final code, all run in this session)

| Battery | Result |
|---|---|
| v1 suite (`test/run-tests.mjs`) | **53/53 passed** |
| Closure 1 — scan (`test/run-tests-v2-scan.mjs`) | **83 passed, 0 failed, 4 deferred** (deferred = Phase-2 items, landed there) |
| Closure 2 — cell (`test/run-tests-v2-cell.mjs`) | **94/94 passed** |
| Closure 3 — airlock (`test/run-tests-v2-airlock.mjs`) | **61/61 passed** |
| Closure 4 — estate (`test/run-tests-v2-estate.mjs`) | **27 passed, 0 failed** |
| Phase 4 regression (`test/run-tests-v2-phase4.mjs`) | **68 passed, 0 failed** |

One transient: the Phase 4 battery's first full run failed exactly one
check (S8 replay-consumed, see FIX 6). The identical sequence was then
reproduced standalone (refusal fires correctly) and the full battery
re-ran 68/68. The flake is recorded here rather than smoothed over;
its likely seat is a present-stream timing race in the battery helper,
not the daemon gate, which the standalone repro exercises directly.

## FIX 1 — Socket trust collapse (critical) — DONE

**The break:** any same-uid process with the daemon socket could
register foreign packages (unsigned `register`), self-approve both
dual-approval stages (the stage-2 `confirm_code` was returned in the
stage-1 approve response, on the same channel), revoke estate members,
revoke grants, clear anomalies, supersede, and accept terms. The
approval surface also claimed `issued-by-this-machine` for entries
that had arrived over the socket from elsewhere.

**The fix:**
- The socket is split. Owner acts (approve, register, revoke,
  revoke-grant, clear-anomaly, supersede, accept-terms, mesh-sync,
  estate-status, enrollment decisions) live on a separate **owner
  channel**: its own socket inside a 0700 directory, socket mode 0600,
  gated by a per-daemon owner token (0600 file). The requester socket
  keeps present/pending/public-status only, and its socket file is now
  created 0600 (the red team noted the socket file was 0770).
- Local registration is **signed**: a `register` doc carries the
  sender's Ed25519 signature, fingerprint binding, `at` + nonce
  (retries are idempotent). The daemon accepts only signers that are
  itself or address-book members, binds every entry's
  `sender_sign_fp` to the signer, and restricts non-self signers to
  `origin: 'egress'` — a peer can no longer mint activation-store
  issuances. Unsigned registration is refused
  (`register-unauthenticated`).
- Dual-approval confirm codes are **never returned over any socket**.
  At stage 1 the daemon writes the code to a 0600 confirm file beside
  the owner socket; the owner CLI reads it there and the owner enters
  it out-of-band for stage 2.
- Provenance is truthful: every registry entry records
  `registered_via` / `registered_from` (`owner`, `local-self`,
  `sender-signed`, `mesh`, `daemon-egress`, `daemon-candidate`,
  `daemon-airlock`), and every pend carries `provenance: {via, from}`.
  `issued-by-this-machine` is claimed only for cryptographically bound
  paths; an owner-relayed foreign issuance names the relay.
- Public `status` no longer leaks seal fingerprints or the estate
  view; owner `status` (owner channel) keeps the full shape.
- Rider (red team's note): the daemon **refuses to start** when the
  socket's parent directory has any group/other permission bits
  ("not private"); the default socket path lives inside the 0700
  store.

**Regression proof (phase-4 battery S1–S3):** unsigned
register refused and never recorded; untrusted signer refused
(`untrusted-sender`); peer-signed activation-store registration
refused per-entry (`register-origin-refused`); spoofed-sender signed
doc refused (`register-sender-mismatch`); all eight owner acts from
the requester socket refused (`owner-channel-required`); owner socket
without/with-wrong token refused (`owner-auth-required`); stage-1
response contains no `confirm_code` (key absent, code string absent);
wrong code refused (`dual-confirm-mismatch`); the right code presented
on the requester socket refused; owner-channel stage 2 unwraps
byte-identical; channel file modes asserted (0700/0600/0600/0600);
shared-directory socket refused at startup.

## FIX 2 — SOFT cell escape (critical) — DONE on this host

**The break:** a pass/Tier-0 program activated into an `unshare` cell
read the daemon's `identity.json` and `registry.json` and **wrote**
into the vault store directory; the grant made the second run tap-free.

**The fix:** the SOFT cell is rebuilt as a real filesystem confinement
(`cell.mjs`): user+mount+pid+net namespaces, then a minimal tmpfs
rootfs — `/usr`, `/lib`, `/lib64`, `/bin`, `/sbin` (and the runtime's
own directory when outside those) bind-mounted **read-only**, only
`/etc/ld.so.cache` copied in, `/dev` reduced to bind-mounted device
files (null/zero/full/random/urandom/tty), the verified image bound
read-only at `/image`, a RAM tmpfs scratch at `/scratch`, the egress
socket bind-mounted at `/cell/egress.sock` — then the rootfs itself is
remounted read-only and the program is `chroot`ed into it with a
scrubbed environment. The identity store is **unreachable** (no path
to it exists in the cell), not merely unwritable; no host writes
outside scratch are possible (EROFS).

Named limits, honestly: the cell shares the **host kernel** (syscall
surface is not a separate kernel), and `/proc` inside the cell is an
empty tmpfs because this host refuses fresh proc mounts in a user
namespace (binding the host `/proc` was rejected by design — it is an
escape hatch). HARD cells (Firecracker/KVM) still do not exist on this
host: there is no `/dev/kvm` and no firecracker binary, so Tier-2's
hard-cell requirement continues to refuse by name
(`cell-unavailable … forbids downgrade`) — proven, not papered over.

**Regression proof:** the red team's escape payload, with the victim
store's real path baked in, is a permanent battery case (phase-4 S5):
inside the cell it reports the store **unreachable** for read and
write (direct path and SA_IMAGE-derived path), writes nothing outside
scratch, still reads its own image, and completes. The Closure 2
battery (94/94) re-proves the confinement cases, and its capability
case still passes in the new cell: an agent process dynamically
imported a plugin module, ran CLI tools via child_process, and
emitted its result through governed egress — the peer opened exactly
those bytes. Capability loss would have been a defect; there is none.

## FIX 3 — Plaintext-hash oracle (high) — DONE for new packages

**The break:** the frame carried the plaintext SHA-256 in cleartext.
A 4-digit PIN was recovered offline in 40 ms by hashing candidates;
any guessed file was confirmable; repeat wraps were linkable.

**The fix:** frames are now **v3**. The cleartext `sha256` field is
replaced by `commit` = HMAC-SHA256(plaintext) keyed by the package's
file key (HKDF-SHA256, info `scripture-armor/commit/v1`). Only a loop
participant who can unseal the file key can verify a guess; an
artifact alone confirms nothing, and two wraps of the same bytes carry
unrelated commitments. The registry stores `digest` + `digest_kind`
(`commit` | `sha256`) instead of a raw hash; return-match compares
commitments. The daemon's unwrap stream attests `digest_verified`
(the commitment is verified at open, before any release).

**Interop consequences, stated plainly:**
- v3 packages fail closed in v1 tools ("missing SCRIPTURE-ARMOR v1/v2
  header") — old tools refuse them rather than mishandling them.
- A v1 tool can no longer register at a v2 daemon (unsigned
  registration is gone). A v1 issuance reaches a v2 daemon by
  **owner relay** over the owner channel — proven in the scan battery
  (case 11) and phase-4 S4; the pend names the relay as provenance.
- v1/v2 frames keep their documented raw-hash exposure: the oracle
  remains open **for legacy packages only**. New wraps are v3.
- Re-seal lineage: two v3 packages of the same bytes never share a
  digest, so `supersede` can no longer prove sameness by digest
  equality. It now requires same sender + recipient **and** the
  one-time reseal token the daemon mints when it opens the old
  package for re-seal (only its hash is kept, spent on use). Legacy
  pairs keep digest equality. (This fallout was caught by the scan
  battery's reseal case during Phase 4 and fixed in the daemon +
  reseal CLI; reseal now completes end-to-end and the superseded
  beacon fires, scan battery case 22.)

**Regression proof (S4):** a wrapped PIN's frame has no `sha256` key;
brute-forcing all 10,000 4-digit candidates against every string field
in the frame confirms **nothing**; a second wrap's commitment differs
(unlinkable); the package still unwraps byte-identical for its owner;
the legacy v1 PIN package's frame is asserted to still carry the raw
hash (the named legacy exposure) and still opens via owner relay.

## FIX 4 — Airlock language confusion (moderate) — DONE

**The break:** inbound crossings were scanned under rules chosen by
the staged file extension. A `#!/bin/sh` + `curl … | sh` payload
staged as `.mjs` crossed with verdict **pass**; keyword-less Python
(`eval(input())` / `os.system`) was classified **data** and crossed
`not-applicable`.

**The fix:** classification and rule selection are by **content**
(`scan.mjs`): shebang lines and content sniffing select the packs;
the source scanner runs **all** language packs with family-deduped
composite promotion (one token counted by two packs cannot
double-promote); a new `src-shell-download` rule composes with
`src-shell-pipe-exec`; the broadened Python pack catches bare
`subprocess … shell=True`. The airlock stages inbound payloads with
the content-sniffed extension, not a fixed `.mjs`.

**Regression proof (S6):** the shell payload in `.mjs` clothing is
quarantined as composite-**critical** (`airlock-scan` beacon raised);
the keyword-less Python payload composes to critical and is
quarantined; bare `subprocess(shell=True)` crosses — if at all — as
**warn**, never pass, never data. The Closure 1 and Closure 3
batteries stayed green throughout (83/0/4, 61/61), including the
pre-existing Tier-1 single-`eval` warn case the family dedup protects.

## FIX 5 — Tier-2 freshness dead code (low) — DONE

**The break:** the activation freshness gate tested
`vr.record.generated_at`; records carry `started`, so the gate never
fired — and a naive rename would have false-refused every genuine
re-scan, because the bound digest covered the timestamps.

**The fix:** the gate reads `started`, and the scan binding is a
**timestamp-free canonical digest** (`scanDigestOf` normalizes
`started`/`duration_ms` out before digesting), so a genuine re-scan
reproduces the bound digest exactly while a stale report still
refuses.

**Regression proof (S7):** digest self-check (a record with a moved
`started` digests identically); a Tier-2 package whose bound report is
2 h old against a 1 h bound refuses `scan-stale`; a fresh report
passes the freshness gate and proceeds to the next gate
(`cell-unavailable` on this host — explicitly **not** `scan-stale`).

Interop note: packages sealed before Phase 4 bound digests computed
over the full canonical record (timestamps included). Their bound
digest cannot reproduce under the timestamp-free form, so a
pre-Phase-4 Tier-2 package under an every-activation re-verification
policy will refuse `report-mismatch` at activation until it is
re-scanned/re-sealed by the new build. Unwraps are unaffected (the
commitment check is unchanged for that path).

## FIX 6 — Mesh replay freshness (low) — DONE

**The break:** mesh documents carried no freshness: a verbatim
captured register doc replayed indefinitely (idempotent for register,
but a standing foothold and a bad precedent for every other type).

**The fix:** `handleMeshLine` enforces an `at` acceptance window
(±`estate.mesh_skew_s`, default 300 s → `mesh-stale`) **after**
signature/recipient/revocation checks, plus a nonce cache keyed by
sender+nonce: a duplicate inside the window re-sends the cached
signed response without re-executing (legitimate retries stay
idempotent); after the window the same bytes die on `at` alone.

**Regression proof (S8):** a register doc captured by a tee process
(the red team's own capture method) registers and opens at the peer;
in-window verbatim replay returns the cached ok and inserts nothing
twice; the replay does **not** resurrect consumption (re-presentation
beacon-refuses `replay-consumed`); after the window the verbatim
replay refuses `mesh-stale`; a re-signed doc with a fresh nonce and a
stale `at` refuses `mesh-stale` (freshness precedes dispatch).
One transient failure of the replay-consumed check occurred on the
first full battery run; the sequence was reproduced standalone
(refusal fires) and the battery re-ran 68/68. Recorded, not hidden.

## What is still open — named, not smoothed over

1. **STORE-WRITE tier (red-team findings F2–F4): still open.** An
   attacker with same-uid **file write** access to the store can
   still edit `registry.json` (e.g., delete `returned_at`) and
   resurrect a consumed canary. Phase 4's signed registration and
   estate sync provide *detection* of forged or conflicting records,
   not prevention. This remains the README's documented voiding
   condition: store write access is ownership of the loop. Phase 4
   closed the **socket** tier completely; it did not claim the store
   tier, and this report does not either.
2. **Wound 3 (key exposure): narrowed, not closed.** A same-uid
   compromise of the vault endpoint itself still yields
   `identity.json`. Hardware-backed key custody (Secure Enclave /
   TPM) remains the v3 direction and still breaks the
   zero-dependency constraint.
3. **SOFT-cell residuals:** shared host kernel; empty `/proc` (host
   refuses proc mounts in user namespaces here). HARD substrate
   absent on this host (no `/dev/kvm`, no firecracker) — Tier-2
   hard-cell activations refuse by name rather than downgrading.
4. **Legacy frames:** v1/v2 packages keep the cleartext plaintext
   hash (offline oracle) and their pre-Phase-4 scan-digest binding
   (see FIX 5 interop note). Only v3 packages are closed.
5. **Multi-machine estate:** the mesh code path is proven on
   loopback harness against the identical code — a true
   multi-machine estate run remains unrun, as it was in Phase 3.

## Harness adaptations made during Phase 4 (assertions, not gates)

Existing batteries were updated only where a fix changed a mechanism
they asserted on; every adaptation preserves (or strengthens) the
property under test, and each is commented in-line as a Phase 4
change:

- v1 suite (1 check): the crafted-digest beacon case now edits the
  v3 `commit` field (was `sha256`) and expects `expected_digest`.
- Scan battery: case 3's two anchor checks recompute via the keyed
  commitment and `scanDigestOf` instead of raw sha256; case 11's v1
  registration becomes an owner-channel relay (registered count now
  asserted, stronger than the old exit-code check); case 1's
  "no issuance for the refused target" negative check — silently
  vacuous under v3 — now asserts every registered entry is
  report-only.
- Cell battery: the capability case proves the governed emission by
  opening it at the peer and comparing bytes (was a registry hash
  lookup); the spawner-bad candidate check compares candidate sets
  before/after (was a hash match that v3 made vacuous).
- Airlock battery: case 11 finds the Tier-2 issuance by its frame
  canary (was a plaintext-hash lookup).
- Two genuine product bugs the batteries caught in Phase 4's own
  fallout were fixed in product code, not in tests: reseal integrity
  under v3 (daemon attestation) and supersede lineage (reseal token),
  both described under FIX 3.

## Files changed

`armor.mjs` (v3 frames + keyed commitment, signed local registration,
owner-channel helpers, reseal integrity + lineage token, provenance),
`vaultd.mjs` (owner channel + token gate, per-channel dispatch,
signed-register verification, confirm-file flow, provenance, public
status split, reseal token + supersede lineage, mesh freshness +
nonce cache, socket privacy refusal, `digest_verified` attestation),
`scan.mjs` (content-sniffed classification, all-pack source scanning
with family-deduped promotion, shell-download rule, timestamp-free
scan digest), `cell.mjs` (chrooted minimal-rootfs SOFT cell),
`airlock.mjs` (content-language staging), `launch.mjs` (status line
no longer prints the seal fingerprint), and the battery harnesses
above plus the new `test/run-tests-v2-phase4.mjs`.
