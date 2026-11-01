# Scripture Armor — standalone

**Seal any file — or an entire repository — inside a closed loop only its
own machine can open, and know by hash if it ever comes back wrong.**
Zero-dependency Node.js ≥ 24. No npm install, no network, no account.
`node:crypto`, `node:fs`, `node:net`, and nothing else.

Scripture Armor began as a design for one person's key vault. It is
released on its own because the problem it answers is everyone's:
public-key cryptography is under a closing window (see *Threat model*),
recorded ciphertext is a time capsule for whoever breaks the math later,
and most "encrypted file" tools still reduce to a password somebody can
phish, reuse, or brute-force offline. Scripture Armor has no password.
There is a *machine* instead: the copy you sealed to, a registry of the
hashes that machine issued, and an owner who approves every opening.

- `armor.mjs` — the client: identity, address book, wrap, register,
  inspect, and whole-repo wrap / unwrap / verify.
- `vaultd.mjs` — the vault daemon: the loop's boundary keeper. It alone
  can open what was sealed to its copy, it checks every returning package
  against the hashes it issued, and it acts only after the owner approves.
- `dns-profiles/` — configuration profiles that point a phone's or a
  computer's DNS lookups at a resolver inside your own loop (see
  *DNS: the agnostic-tracks surface for traffic*).

---

## The doctrine

This section is the design in its author's own terms. It is reproduced
in full because everything after it — every mechanism in this README —
exists to implement exactly this, and nothing else.

**Scripture Armor forms a CLOSED LOOP within whatever system it is
applied to.**

**The daemon checks GENERATED HASHES when data packets LEAVE the
system** — egress is when a packet becomes an attack surface. **Hashes
are generated when the information leaves.**

**The armor is a CONTAINMENT layer**: a "trojan chameleon" that does no
damage — a reactionary, metadata-filled skin of randomly generated
unreadable glyphs around the packet while it is outside the loop.

**The machine that created the hash waits for the RETURN HASH to
match.** Every request already has a hash; now every hash gets
Scripture Armor.

**The trust anchor is the loop's own machine and the hashes it issued —
NOT sender identity between strangers.** A returning packet is valid
because its hash matches one the machine generated.

**Scripture Armor is an EXTENSION with completely agnostic train
tracks**: it bolts onto the boundary of whatever system it is applied
to, rides the hashes that system already generates per request, and
requires no changes to the host's internals or request formats.
Payload-, platform-, and host-agnostic.

**The glyphs are NOT letters.** The author's correction, verbatim:
*"Not letters — unreadable, untranslatable glyphs with metadata for
location and identity reporting."* A letter belongs to a language and
can be read and translated. These glyphs cannot. There is no underlying
language to translate from — the glyph mapping is re-shuffled per packet
from the Rosetta key, and much of the alphabet does not even render
without the bundled font. Untranslatable by construction, not by
difficulty. The metadata frame is the reporter: packet identity and
location are frame functions, by design.

**If the hashes don't match, the stolen data is a built-in homing
beacon.** The author's words: *"Plus if the hashes don't match the
stolen data is a built in homing beacon."* A stolen armored packet that
surfaces with a non-matching hash identifies itself: the signed frame's
canary names *which* packet was taken, the mismatch proves it left the
loop, and the network it wakes on is what it reports. Theft converts
the data from an asset into evidence against the thief. The posture is
**sight, not strike**: the beacon lawfully reports where it woke; there
is no hack-back.

---

## What a package is

```
SCRIPTURE-ARMOR v1
{ …metadata frame as JSON, Ed25519-signed… }
<glyph armor, one glyph per ciphertext byte, 48 per line>
```

- **Layer 1 — the math.** The content is sealed with ChaCha20-Poly1305
  (AEAD) under a random per-package file key. The file key is sealed to
  the recipient (X25519 ECDH + HKDF-SHA256 → ChaCha20-Poly1305).
  Tampering fails closed: a flipped glyph, a cut line, a swapped key
  block — the AEAD tag or the frame signature refuses it. **This layer,
  and only this layer, is the secrecy.**
- **Layer 2 — the skin.** The ciphertext is re-encoded in a glyph
  alphabet: 128 Private Use Area codepoints (U+E000–U+E07F, which do not
  render without a bundled font) mixed with 64 Linear A and 64 Cuneiform
  signs as decoys — 256 glyphs, one per byte. The alphabet's order is
  permuted per package by an HKDF stream seeded from that package's
  `armor_seed` — the Rosetta key — so the same file wrapped twice reads
  as two different unreadable texts, and there is no fixed mapping for
  anyone to learn. **Honest framing: the glyph layer is keyed
  obfuscation — a skin, not the lock.** It defeats eyeballs, casual
  tooling, and foreign fonts. It is never asked to defeat cryptanalysis;
  Layer 1 is the security foundation. The glyphs are not letters and
  there is no language here to translate.
- **The frame.** Every package carries a metadata frame, Ed25519-signed
  by the sender over the canonical frame fields plus a SHA-256 of the
  glyph body:

  | Field | What it is / does |
  |---|---|
  | `v` | Format version (1). |
  | `canary` | Random UUID minted at wrap time. The packet's identity — the name the registry knows it by and the name a beacon event reports. |
  | `created` | Wrap timestamp (ISO 8601). |
  | `expiry` | Optional expiry timestamp, or null. Policy stated by the frame, enforced by an honest daemon. Registered at egress and compared at return, so editing it breaks the return-match even if the frame is re-signed. |
  | `sha256` | SHA-256 of the *plaintext*. The hash generated when the information leaves; the return-match compares it, and a successful unwrap re-verifies the opened plaintext against it. |
  | `sender_sign_fp` | SHA-256 fingerprint of the sender's Ed25519 signing key. Registered at egress; a return signed by any other key fails the return-match. |
  | `sender_sign_pub` | The sender's Ed25519 public key (JWK `x`). The signature verifies against it. |
  | `recipient_seal_fp` | SHA-256 fingerprint of the recipient's X25519 sealing key — the copy this package was sealed to. The daemon refuses any package not sealed to itself. |
  | `armor_seed` | Seed for this package's glyph-alphabet permutation. |
  | `eph_pub`, `key_nonce`, `key_ct` | The sealed file key: ephemeral X25519 public key, nonce, and the AEAD-sealed file key. **Inside the signed canonical frame** — swapping the key block breaks the signature (proven under attack; see the test suite). |
  | `file_nonce` | The content AEAD nonce. |
  | `sig` | Ed25519 signature over the canonical frame + body hash. |
  | `sig_pq` | **(v4)** ML-DSA-65 signature over the same data. A v4 frame verifies only when BOTH signatures verify. |
  | `kem_alg`, `kem_ct` | **(v4)** `ML-KEM-768` and the 1088-byte KEM ciphertext of the hybrid key seal (below). Inside the signed canonical frame — stripping it breaks both signatures and the unseal. |
  | `sender_mldsa_fp`, `sender_mldsa_pub` | **(v4)** The sender's ML-DSA-65 fingerprint and public key. |
  | `recipient_kem_fp` | **(v4)** SHA-256 fingerprint of the recipient's ML-KEM-768 public key — the KEM half of the copy this package was sealed to. The daemon refuses a v4 package whose KEM half names a different copy. |

  **The post-quantum closure (v4, shipped).** Earlier versions named
  two classical parts and called them swappable: the Ed25519 frame
  signature and the X25519 key seal. Naming a swap is not shipping
  one, so v4 shipped both. The key seal is now **hybrid**: X25519 ECDH
  *and* ML-KEM-768 encapsulation, the two shared secrets concatenated
  into a single HKDF — an attacker must break both, so a future
  quantum machine that shatters X25519 still faces the ML-KEM secret,
  and harvest-now/decrypt-later is closed for every v4 package. The
  frame is **dual-signed**: Ed25519 *and* ML-DSA-65 over the same
  signed data; a v4 frame whose PQ signature or KEM block is stripped
  does not verify and does not open — downgrade is a refusal, never a
  fallback. Sealing to a pre-v4 identity (no ML-KEM key) is refused
  for the same reason. Pre-v4 identities gain PQ keys automatically,
  in place, the first time they are loaded — seal/sign fingerprints,
  trust relationships, and registry entries are untouched. Legacy
  v1–v3 packages still open, under exactly the cryptography they were
  honestly sealed with; re-seal them to move them under v4. The
  runtime requirement moved with the math: **Node ≥ 24** (ML-KEM /
  ML-DSA in the standard library), and the armor fails closed on a
  runtime that lacks them rather than sealing classical-only.

## Also shipped with v4 (the register, closing)

- **First contact (M.17).** `trust` now records an *introduction* —
  who introduced the identity, when, and a pairing SAS (Short
  Authentication String) computed over the peer's FULL key material,
  classical and post-quantum — printed at pairing time for the two
  humans to compare out-of-band. Re-trusting an existing label with
  different key material is refused outright: an introduction is
  replaced only by an explicit `untrust` first, never overwritten in
  silence.
- **Defenses that can't be fired at the owner (M.19).** The daemon
  budgets its own surfaces: pendings per origin are capped at 32
  (excess is shed and *counted* — the owner sees a count in the log,
  not a flood of approvals) and registrations per sender are capped
  per hour (registry bloat is a cost, so it is budgeted). Quarantine
  and beacon decisions continue to require authenticated events;
  unauthenticated noise dies at the signature gate before any state
  is touched.
- **The scanner's verdict is evidence, not a gate (M.11/M.12).** A
  Ghidra verdict can refuse a wrap and can demand the owner's
  override, but no verdict — clean or dirty — changes what an
  activated program *is*: code runs inside cells under the cell
  tiers' confinement, and content crossing inward arrives as data on
  a channel that cannot command. A document that scans clean can
  still be a lie; the armor governs crossings, not meanings, and
  says so.
- **No orphan packages (adoption).** `FORMAT.md` specifies the
  package format (v1–v4) completely, and `open-standalone.mjs` — a
  single file importing nothing from this codebase — opens every
  version. If this project died tomorrow, your packages would not
  die with it.

## The closed loop in operation

### Egress — the hash is generated when the information leaves

`armor.mjs wrap` / `wrap-repo` seal the package, write it, and then
**register the issuance** with the vault daemon of the loop it was
sealed for: `{canary, sha256, recipient_seal_fp, sender_sign_fp,
expiry, issued_at}` per package (repo mode registers every part and the
manifest). The daemon records it in its **issued-hash registry**
(`registry.json` in its identity dir, mode 0600, rewritten atomically
on every change and held in memory — re-read whenever the file
changes on disk — so registrations survive daemon restarts). The
registry, the address book's key material, and the identity itself
carry HMAC integrity tags keyed from the identity: an outside edit
to any of the three stores is detected on load and fails closed
rather than passing in silence. Registration is bound to the daemon's own
identity: an entry whose recipient is a different copy is refused, and
re-registering a canary with a different hash or expiry is refused as a
conflict.

**If the daemon is unreachable at wrap time, the issuance is not
silently skipped.** It is queued in `registry-outbox.jsonl` (mode
0600) in the wrapping identity's store, and the queue syncs on the
next successful registration contact — any later wrap, or an explicit:

```sh
node armor.mjs register somefile.scripture --socket <daemon-socket>
```

Until an issuance syncs, the daemon refuses that package as
*never-issued*. That is the doctrine working as designed: the loop only
opens what it knows it sent out.

The queue is not invisible while it waits: `armor.mjs identity` and
the daemon's owner status report how many issuances sit unsynced and
how old the oldest is, and a new wrap flushes the queue before it
proceeds whenever the daemon is reachable. If the queue itself is
ever lost, the refusal is no longer a dead end either: the package
still beacons *never-issued* — the testimony never changes — but when
its frame signature verifies and its sender is this copy or a trusted
peer, the daemon also records a **recovery candidate**. Only the
owner's explicit approval on the owner channel (`vaultd.mjs
recovery`, then `vaultd.mjs approve --id …`) derives the issuance
from the package itself, registers it, and opens it. A presentation
alone never registers anything.

### Transit — containment

Outside the loop, a package is the trojan chameleon: inert, unreadable,
untranslatable glyphs around AEAD ciphertext, carrying a signed frame
that names it (canary) and states its terms (expiry). It does no
damage, runs no code, phones nothing home by itself. It waits.

### Return — the daemon waits for the return hash to match

An unwrap request to the daemon passes these gates **in order**:

1. **Parse.** Not a `SCRIPTURE-ARMOR v1` package → refused.
2. **Recipient.** Sealed to a different copy → refused
   (`recipient-mismatch`).
3. **RETURN-MATCH.** The presented frame is compared against the
   registry entry for its canary:
   - no entry → **beacon event**, refused (`never-issued`);
   - entry already consumed by a successful return → **beacon event**,
     refused (`replay-consumed`);
   - `sha256` differs from the issued hash → **beacon event**, refused
     (`hash-mismatch`, with the expected hash recorded);
   - `expiry` differs from the issued expiry → **beacon event**,
     refused (`expiry-mismatch`) — this is what kills the re-sign
     attack: editing an expired package's expiry to 2099 and re-signing
     it under a fresh attacker key still fails, because the *issued*
     expiry is on record and the presented one no longer matches it;
   - `sender_sign_fp` differs from the issued sender → **beacon
     event**, refused (`sender-mismatch`) — a frame re-signed under
     any key but the one that issued it is not the packet that left.
4. **Signature.** Frame signature invalid → refused
   (`bad-frame-signature`). **Expiry.** Past the frame's expiry → refused (`expired`). **Decode.** Glyph body corrupt → refused (`armor-corrupt`). **Owner approval.** Only now does the request become *pending*,
   held for the approval window (default 120 s) — and pending is a
   **claim**: in the same atomic registry write, the daemon marks the
   entry claimed by this pending request. A second presentation of
   the same canary while a claim is live — even concurrently, on
   another connection — is a **beacon event**, refused
   (`replay-claimed`); it never creates a twin pending, so two
   approvals can never both unwrap the same packet. The pending entry
   the owner sees carries: request id, canary, plaintext SHA-256, file
   path, age, **sender sign fingerprint**, **registry status**
   (`issued-by-this-machine`), and any context the requester attached
   (repo restores attach their declared scale — see *Repo mode*). No
   approval in the window, the request dies **and the claim is
   released** — as it is if the requester disconnects unapproved, or
   on daemon shutdown. A released claim is not a consumption: the
   package has not returned until an unwrap succeeds, and it may pend
   again. **Unwrap.** Approval executes only for the pending that
   holds the claim (re-validated at approval time; a stale or foreign
   approval is refused as `claim-not-held` and consumes nothing).
   After approval the daemon unseals the file key, opens the AEAD,
   **re-verifies the plaintext SHA-256 against the frame**, writes
   the file (mode 0600) into its out dir, and **consumes the registry
   entry** (marked returned, with timestamp, claim cleared in the
   same write). Returns are one-shot: the same packet can never be
   opened twice — sequentially or concurrently.

### Beacon events and the testimony

Every boundary mismatch writes a first-class **beacon record** to the
daemon's testimony log (`vaultd.log`, mode 0600):

```json
{"ts":"…","event":"beacon","canary":"…","sha256":"…",
 "reason_class":"never-issued | hash-mismatch | expiry-mismatch | sender-mismatch | replay-consumed | replay-claimed",
 "presented_path":"/path/the/package/was/presented/from",
 "surface":{"daemon_label":"vault-b","seal_fp":"…","socket":"/path/vaultd.sock"},
 "expected_sha256":"… (when a registered hash exists)"}
```

The record names *which* packet (canary), *what* was wrong
(reason_class), *where it was presented from* (path), and *which
surface received it* (this daemon's label, seal fingerprint, socket).
That is the homing beacon: stolen data that surfaces at any copy of
this tool announces itself in that copy's testimony. `inspect` — the
tool you would point at a surfaced package anywhere — emits the **same
record shape** (to stderr, and appended to `beacon.log` in the identity
dir) whenever a package's frame signature does not verify
(reason_class `signature-invalid`, surface marked `"via":"inspect"`).

Posture, again: **sight, not strike.** Nothing in this tool calls out,
retaliates, or reaches back. The beacon fires where the packet wakes —
in the log of the machine it was presented to, for the owner of that
machine to testify from.

The testimony log also records registrations, pending requests,
approvals, refusals (including refused approvals, oversized frames,
and timeouts), and every successful unwrap. **The log is the receipt.**

## Repo mode — wrap an entire tree

```sh
node armor.mjs wrap-repo ./my-repo --to vault
# → ./my-repo.scripture-repo/
#     MANIFEST.scripture          (the sealed index package)
#     RESTORE-INFO.json           (cleartext restore-scale sidecar)
#     files/<path>.partNNNN.scripture   (one package per chunk)
```

The scan is recursive and total: everything is wrapped except `.git/`
and `node_modules/` (skipped by rule). Symlinks are never followed;
they are recorded in the manifest as skipped. Relative paths are
preserved under `files/`.

**Scale.** Files are read in fixed-size chunks (default 4 MiB,
`--chunk-size <bytes>`). Each chunk becomes its own complete package —
own file key, own frame, own signature, own registry entry. The
manifest records every file's path, size, mode, whole-file SHA-256, and
each part's SHA-256 and canary, and is then sealed as one ordinary
package itself (and registered like one). Peak memory is a few
chunk-sized buffers plus one chunk's glyph text, **no matter how large
the file or the repo** — a 10 GB file wraps exactly like a 10 KB one;
it just produces more parts. A zero-byte file produces zero parts: it
exists only in the sealed manifest and is recreated on unwrap.

**Verify without opening anything:**

```sh
node armor.mjs verify ./my-repo.scripture-repo
```

Checks every package's frame signature, sender/recipient consistency
with the manifest package, part sequencing, and expiry. It never
unwraps: full content-hash verification against the manifest happens
inside `unwrap-repo`, after the daemon approves each package. Two
honest limits: zero-byte files leave no package on disk, so `verify`
cannot see them — they are vouched for by the sealed manifest alone;
and `verify` cannot detect two part packages swapped on disk — the
manifest hash chain catches that at restore, and the test suite proves
both behaviors.

**Restore, and the hardening around it:**

```sh
node armor.mjs unwrap-repo ./my-repo.scripture-repo --into ./my-repo-restored
# each package prints "pending approval: <canary> — owner runs: …"
node vaultd.mjs approve --id <request-id>   # once per package
```

Every package goes through the daemon and is individually approved and
individually return-matched; there is no batch key and no silent path.
`unwrap-repo` verifies every part's SHA-256 against the manifest, then
every file's whole-file SHA-256, before it reports success. Around
that, the restore path is hardened, in this order:

- **Restore scale in the approval prompt.** The wrapped tree carries
  `RESTORE-INFO.json`, a cleartext sidecar declaring the restore scale
  (file count, part count, total bytes). When the manifest package is
  presented, that scale travels with the request and appears in the
  pending entry the owner approves — a manifest that would restore
  20,000 files says so *before* the owner approves it. The sidecar is
  **advisory and untrusted**: before the manifest's one-shot return is
  spent, the manifest is opened verify-only — every gate and the
  owner's approval, but no consumption — and the sidecar's declared
  counts are cross-checked against the sealed manifest. Any
  divergence aborts the restore with the manifest's return unburned:
  fix the sidecar and re-run. (The cross-check once ran only after
  the consuming open, so a corrupted sidecar burned the manifest
  permanently; the verify-first order is the fix.) Trees
  wrapped before the sidecar existed declare nothing in the prompt —
  their counts are still validated against themselves (next point) —
  and the prompt says exactly that.
- **Manifest count validation.** The manifest's declared
  `fileCount` / `partCount` / `totalBytes` must equal its own contents
  (entries, parts, summed sizes). A lying manifest restores nothing.
- **Symlink refusal.** Every component of every restore path — the
  target itself, manifest dirs, file parents, the file — is `lstat`ed;
  if any existing component is a symlink, the restore refuses. A
  pre-planted symlink inside the target cannot redirect a write
  outside it.
- **Mode masking.** Manifest modes are applied masked to `0o777`:
  setuid/setgid/sticky bits recorded in a manifest are never applied
  to restored files.
- **Part containment.** Every `part.package` must resolve inside the
  wrapped tree before it is read; a manifest pointing outside the tree
  is refused before any package is opened.

## The daemon

On the loop's machine (the matching copy):

```sh
node vaultd.mjs serve                     # socket: ~/.scripture-armor/vaultd.sock
node vaultd.mjs serve --out-dir ~/vault-out --approval-window-ms 120000
```

### Default install posture — always-on vaultd

**The vault daemon is always on by default.** A daemon that only runs
when somebody remembers to start it is not a boundary keeper, so the
standard install registers `vaultd` as a boot-level service wherever
the tree ships a service path:

| Platform | Default service registration |
|---|---|
| **macOS** | **Implemented — the default.** `mac/install-armor.sh` installs vaultd as a system **LaunchDaemon** (`org.ronininc.scripture-vaultd`, `RunAtLoad` + `KeepAlive`): started by launchd at boot, **before any login**, running as the owner user, surviving logout. A pre-existing per-user LaunchAgent install is booted out and its plist is moved aside as a backup, never deleted. |
| **Linux** | **Implemented — the default.** `linux/install-armor.sh` installs vaultd as a system **systemd service** (`scripture-vaultd.service`, enabled for `multi-user.target`, `Restart=always`): started by systemd at boot, **before any login**, running as the owner user, surviving logout. The unit is hardened and health-gated (its start completes only when vaultd's own status answer comes back), and refuses to restart-loop configuration-class exits (78) — corrected 2026-10-26 against the ecosystem's original pattern, Solomon's `solomon.service`; the per-user twin is `scripture-vaultd-user.service`. A pre-existing per-user unit install is disabled and its file moved aside as a backup, never deleted. |
| **Windows** | **Implemented — the default; NOT YET RUN on a live Windows host.** `windows/install-armor.ps1` registers vaultd as a **Task Scheduler boot task** (`ScriptureArmorVaultd`, AtStartup trigger, S4U principal: runs as the owner, no stored password, before any login; restart-on-failure without limit). See the Windows hosting note below for why a boot task and not an SCM service, and for what is unverified. A pre-existing fallback logon task is exported to an XML backup, never silently deleted. |

**Windows hosting note.** Stock Windows cannot run a Node script as a
true Service Control Manager service without a service-host binary,
and none (WinSW / NSSM / node-windows) ships anywhere in this
ecosystem — so the Windows default is a Task Scheduler boot task,
which delivers the same posture (boot, pre-login, owner identity,
restart-on-failure) through the mechanism the platform actually
provides. Two honesty labels, also printed by the installer itself:
the Windows installer has been statically reviewed but **not run on
Windows** (no Windows host was available), and vaultd's control
channel is a Unix-domain socket path — `vaultd.mjs` carries no
Windows named-pipe path — so the daemon's socket behavior on Windows
is unverified. The installer's identity step is plain Node file I/O
and cross-platform; the daemon's first live Windows run is the open
item.

**Designated hosts (macOS).** On a host designated as an always-on
armor node, the standard install also sets the system sleep policy so
sleep and lid-close cannot take the daemon down:

```sh
bash mac/install-armor.sh --designated-host
# (or: SCRIPTURE_ARMOR_DESIGNATED_HOST=1 bash mac/install-armor.sh)
```

That runs `pmset -a disablesleep 1` — and the installer **prints**
that it did, with the revert (`sudo pmset -a disablesleep 0`). No
system change is made silently: the daemon install, the agent
migration, and the sleep-policy change are each printed as they
happen, and a non-designated install leaves sleep untouched and says
so.

**Designated hosts (Linux).** `bash linux/install-armor.sh
--designated-host` masks the systemd sleep targets — the standard
systemd mechanism:

```sh
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
# revert: sudo systemctl unmask sleep.target suspend.target hibernate.target hybrid-sleep.target
```

The installer prints the change and the revert as it makes it;
without the flag, sleep is untouched and the installer says so. The
per-user fallback cannot change system sleep.

**Designated hosts (Windows).** `windows\install-armor.ps1
-DesignatedHost` sets the AC standby and hibernate timeouts to
never:

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
# revert: powercfg /change standby-timeout-ac <minutes> (and hibernate-timeout-ac likewise)
```

The installer prints the change as it makes it — including the
previous standby value for the revert when it could be read — and
leaves the power plan untouched, saying so, without the flag. The
logon-task fallback cannot change the power plan.

**Opting out (macOS).** The always-on daemon is the default, not a
trap:

- Lighter fallback (starts at login, can be stopped by logout/sleep):
  `bash mac/install-armor.sh --user-agent` — a per-user LaunchAgent.
- No service at all: `bash mac/install-armor.sh --no-daemon`
  (or `SCRIPTURE_ARMOR_DAEMON=off`). vaultd then runs only when
  started manually: `node vaultd.mjs serve`.
- Removing the default daemon later:
  `sudo launchctl bootout system /Library/LaunchDaemons/org.ronininc.scripture-vaultd.plist`
  and delete that plist; restore sleep with
  `sudo pmset -a disablesleep 0` if the designated-host policy was set.

**Opting out (Linux).** The same three postures, same flag shapes:

- Lighter fallback (starts with your systemd user session — at boot
  only if you enable linger as root, `loginctl enable-linger
  <user>`): `bash linux/install-armor.sh --user-service` — the
  per-user twin unit (`scripture-vaultd-user.service`).
- No service at all: `bash linux/install-armor.sh --no-daemon`
  (or `SCRIPTURE_ARMOR_DAEMON=off`). Manual foreground:
  `node vaultd.mjs serve`.
- Removing the default service later:
  `sudo systemctl disable --now scripture-vaultd`, delete
  `/etc/systemd/system/scripture-vaultd.service`, then
  `sudo systemctl daemon-reload`; restore sleep with
  `sudo systemctl unmask sleep.target suspend.target hibernate.target hybrid-sleep.target`
  if the designated-host policy was set.

**Opting out (Windows).** The same three postures:

- Lighter fallback (starts at login, ends at logoff):
  `windows\install-armor.ps1 -UserTask` — the
  `ScriptureArmorVaultdLogon` task.
- No task at all: `windows\install-armor.ps1 -NoDaemon`
  (or `SCRIPTURE_ARMOR_DAEMON=off`). Manual foreground:
  `node vaultd.mjs serve`.
- Removing the default task later:
  `Unregister-ScheduledTask -TaskName ScriptureArmorVaultd -Confirm:$false`;
  restore the power plan with
  `powercfg /change standby-timeout-ac <minutes>` (and
  `hibernate-timeout-ac` likewise) if the designated-host policy
  was set.

The manual `serve` commands above remain the way to run the daemon in
the foreground (development, or under Kingmaker's launcher).

Request an unwrap (from the same host), then approve it as the owner:

```sh
node vaultd.mjs unwrap ~/release-key.p12.scripture release-key.p12
# → {"state":"pending-approval", …} — the daemon holds it
node vaultd.mjs pending                   # see what's waiting, with sender + registry status
node vaultd.mjs approve                   # the owner's hand on the gate
# → the waiting client receives {"state":"unwrapped", "out": "…", "sha256": "…"}
```

Approval is a **local owner action on the host** — the `approve`
command above. That is deliberate: the closed loop means no network
caller, token, or script option can open a package without the owner
of the matching copy acting, per package, in the open.

### Daemon protocol (Unix socket, one JSON object per line)

| Request | Response |
|---|---|
| `{"cmd":"status"}` | label, seal/sign fingerprints, uptime, pending count, registry counts (issued / returned) |
| `{"cmd":"register","entries":[{canary, sha256, recipient_seal_fp, sender_sign_fp, expiry, issued_at}, …]}` | `{ok:true, registered:n, canaries:[…], refused:[{canary, error}, …]}` — entries sealed to a different copy, and canaries re-registered with a different hash/expiry, are refused per entry |
| `{"cmd":"unwrap","path":"…","out":"…","context":"…"}` | streams: `pending-approval` (with id, sender fp, registry status, context) → after owner approval `unwrapped`; or an immediate refusal / beacon object |
| `{"cmd":"pending"}` | the pending list, each entry with sender sign fingerprint + registry status + context |
| `{"cmd":"approve","id":"…"}` | approves one pending request; an unknown, consumed, or expired id is refused (`no-matching-pending-request`) and the refusal is logged |

A request line is capped at 1 MiB; an oversized unterminated frame is
dropped and logged (`oversized-frame`). Packages travel by filesystem
path, never by socket — the socket carries only control records.

## Setup — two copies

On each machine (or each identity dir):

```sh
node armor.mjs identity --label vault        # prints a public block
node armor.mjs identity --label laptop
```

`identity` creates `~/.scripture-armor/identity.json` (mode 0600, dir
0700): an X25519 sealing keypair + an Ed25519 signing keypair. It
prints **one portable public block** (base64). That block is the only
thing that travels. Give each copy the other's block:

```sh
node armor.mjs trust vault '<public-block-from-the-vault-copy>'
```

`trust` validates the block's key material — a garbage block or one
carrying fake keys is refused on the spot, not discovered at first
wrap. Private keys are never printed, never exported, never leave the
store.

## Commands

```sh
node armor.mjs identity [--label <name>] [--identity-dir <dir>]
node armor.mjs trust <label> <public-identity-block> [--identity-dir <dir>]
node armor.mjs wrap <file> --to <label> [--expires <ISO date>] \
    [--identity-dir <dir>] [--register-socket <path>]
node armor.mjs register <file.scripture>… [--socket <path>] [--identity-dir <dir>]
node armor.mjs inspect <file.scripture> [--identity-dir <dir>]
node armor.mjs wrap-repo <dir> --to <label> [--out <dir>] \
    [--chunk-size <bytes>] [--expires <ISO date>] \
    [--identity-dir <dir>] [--register-socket <path>]
node armor.mjs unwrap-repo <wrapped-dir> --into <dir> [--socket <path>] \
    [--daemon-out-dir <dir>] [--identity-dir <dir>]
node armor.mjs verify <wrapped-dir>
node vaultd.mjs serve [--identity-dir <dir>] [--socket <path>] \
    [--out-dir <dir>] [--approval-window-ms <n>]
node vaultd.mjs status|pending|approve|unwrap … [--socket <path>] [--identity-dir <dir>]
```

`inspect` reads a frame — canary, dates, plaintext SHA-256, sender,
recipient, signature validity — **without** unwrapping, and beacons
(see above) when the signature does not verify.

## Files

| Path | What |
|---|---|
| `~/.scripture-armor/identity.json` | this copy's private identity (0600) |
| `~/.scripture-armor/addressbook.json` | trusted peers' public blocks |
| `~/.scripture-armor/registry.json` | the daemon's issued-hash registry (0600) |
| `~/.scripture-armor/registry-outbox.jsonl` | issuances queued while the daemon was unreachable (0600) |
| `~/.scripture-armor/vaultd.sock` | daemon socket (default) |
| `~/.scripture-armor/vaultd.log` | the testimony: registrations, matches, beacons, approvals, unwraps |
| `~/.scripture-armor/beacon.log` | beacon records emitted by `inspect` |
| `~/.scripture-armor/out/` | daemon unwrap output (default `--out-dir`) |
| `<file>.scripture` | a wrapped package — inert anywhere else |
| `<dir>.scripture-repo/` | a wrapped repo: `MANIFEST.scripture` + `RESTORE-INFO.json` + `files/…` |
| `dns-profiles/` | DNS configuration profiles for phones and computers (below) |
| `mac/install-armor.sh` | the standard Mac install — identity + the default always-on daemon (below, *Default install posture*) |
| `mac/install-daemon.sh` | renders + installs the vaultd service (system LaunchDaemon by default; LaunchAgent only as explicit fallback) |
| `mac/org.ronininc.scripture-vaultd.plist` | the launchd template the daemon installer renders with the owner's paths |
| `/Library/LaunchDaemons/org.ronininc.scripture-vaultd.plist` | the installed default daemon (macOS, after install) |
| `linux/install-armor.sh` | the standard Linux install — identity + the default always-on daemon |
| `linux/install-daemon.sh` | renders + installs the vaultd service (system systemd service by default; per-user twin unit only as explicit fallback) and verifies the start against vaultd's own status answer |
| `linux/scripture-vaultd.service` | the system systemd unit template the daemon installer renders with the owner's paths (hardened, health-gated; corrected against Solomon's `solomon.service`) |
| `linux/scripture-vaultd-user.service` | the per-user twin unit template (fallback posture; same health gate + restart discipline, no hardening block) |
| `/etc/systemd/system/scripture-vaultd.service` | the installed default service (Linux, after install) |
| `windows/install-armor.ps1` | the standard Windows install — identity + the default always-on boot task (Task Scheduler; not yet run on a live Windows host) |
| `ScriptureArmorVaultd` (Task Scheduler task) | the installed default boot task (Windows, after install) |

## DNS: the agnostic-tracks surface for traffic

DNS is the one lookup protocol every operating system already speaks —
phones, laptops, servers, all of them, with no host changes and no app
support required. That makes DNS the natural place for Scripture
Armor's agnostic-tracks idea to reach *traffic*: the `dns-profiles/`
directory ships configuration profiles that point a device's lookups at
a resolver running **inside the operator's own closed loop**, so the
queries travel between the device and the loop on encrypted DNS
(DNS over HTTPS / DNS over TLS) instead of going to whatever resolver
the local network hands out — the same boundary posture as the armor
itself, applied to the one flow every device always emits.

**Honest mechanics — read this before the profiles.** A DNS profile
wraps the **DNS layer: the queries**. It does **not** wrap all of the
device's traffic, and nothing in this directory claims it does.
Wrapping the full traffic is a separate posture (VPN On Demand — the
Apple template carries a commented, inactive sketch of it, and the
distinction is stated there too). Anyone who tells you a DNS setting
"encrypts your traffic" is selling you the confusion this paragraph
exists to prevent: what rides inside the loop under these profiles is
*which names the device asks about*, asked of *your* resolver, over an
encrypted channel — which is precisely the metadata that open-network
resolvers otherwise collect.

What's in `dns-profiles/`:

| File | For |
|---|---|
| `scripture-armor-dns.mobileconfig` | iOS + macOS — one Apple configuration profile: DNS Settings payload, DNS over HTTPS, with a commented optional VPN On Demand section |
| `android-private-dns.md` | Android — Private DNS (DoT) hostname steps |
| `windows-doh.md` | Windows — encrypted DNS settings steps + registry snippet |
| `linux-resolved.conf` | Linux — systemd-resolved drop-in (DoT, fail-closed) |
| `linux-stubby.yaml` | Linux/BSD — stubby upstream config (DoT) |

**Operator fields.** Every server value in these files is a marked
placeholder — `https://dns.example-loop.invalid/dns-query` and the
TEST-NET-1 address `192.0.2.53`. `.invalid` can never resolve and
192.0.2.0/24 is a documentation range: the templates cannot
accidentally point a real device at a real server. Replace them with
your loop resolver's hostname/address (and mint fresh profile UUIDs)
before enrolling anything.

**Running the resolver on the loop's node.** The resolver itself is
the operator's choice and nothing here vendors one. Real, open
options that serve DoH/DoT and are commonly run exactly this way:
**dnscrypt-proxy**, **AdGuard Home**, **Technitium DNS Server** —
pick one, run it on a node inside your loop (the same machine that
hosts your vault is the natural home), bind it to your loop's
interfaces, and point the profiles at it. Loop discipline applies:
give enrolled devices *only* loop resolvers (a foreign fallback
quietly routes lookups back outside), and prefer the fail-closed
modes the platform offers (e.g. "Encrypted only" on Windows,
`DNSOverTLS=yes` on systemd-resolved).

**How enrolled devices relate to the loop.** An enrolled device is a
client of the loop's resolver, nothing more: enrollment does not give
the device the loop's keys, does not make it a vault copy, and does
not let it open packages. It means one thing — when that device asks
"name, please," it asks *your machine*, inside *your boundary*, over
an encrypted channel, and your machine's resolver logs are the
testimony of what was asked. The loop gained ears at its edge; the
keys stayed home.

## Threat model

**What this is for.** Content that must survive exposure of the
transport or the storage: leaked backups, seized drives, a mesh/vault
host someone else can see, a public release of sealed material — and
content whose movement you must be able to *testify* about: what left,
when, under which hash, and what came back. The attacker is assumed to
hold the `.scripture` packages forever and to throw offline compute at
them. Against that attacker, confidentiality rests on ChaCha20-Poly1305
with a random per-package key, sealed by a hybrid X25519 + ML-KEM-768
key seal (v4) — symmetric AEAD has the large margin cryptographers
point to when they warn about the public-key side, which is why the
design puts the content there and says so plainly; the frame's
signatures (Ed25519, and ML-DSA-65 on v4) are authentication only and
never carry confidentiality.

**What this is not.**
- Not protection against compromise of the loop's own machine. Whoever
  holds the daemon identity's `identity.json` *is* the vault — and
  whoever can edit `registry.json` edits the loop's memory of what it
  issued. Guard both like the crown jewels; the identity needs its own
  cold, sealed backup, and a lost vault identity means every package
  sealed to it is gone forever, by design.
- The loop's own records are local files — stated plainly, with one
  part now closed. The **issued-hash registry** (`registry.json`) and
  the **registration outbox** (`registry-outbox.jsonl`) carry no
  signature or MAC: the daemon trusts them as written, and a forged
  registry or outbox entry would be believed. The **testimony log**
  (`vaultd.log`) is no longer in that class: every record is a link
  in an HMAC-sealed hash chain keyed from the daemon's identity —
  alter, insert, reorder, or truncate a line and
  `vaultd.mjs log-verify` names the exact line where the chain
  breaks — and on daemon start the closed log is rotated into
  `log-segments/`, sealed as an ordinary v4 package to the same
  identity, so history at rest is ciphertext. (`beacon.log`, the
  CLI-side beacon record, remains a plain append-only file.) Their only protection is the store
  itself — identity directory mode 0700, files mode 0600, one owner's
  uid. This is a known limit, not an oversight that snuck in: an
  attacker who can write inside the store already holds the very
  access that exposes `identity.json` — the private keys themselves —
  which is the voiding condition named above. Inside that boundary
  the records are exact; across it, nothing in this tool pretends
  otherwise.
- Not sender authentication between strangers. The loop does not need
  it: the return-match keys on what *this machine issued*. The frame
  signature proves a specific signing key wrapped the package, and the
  registry proves whether that key, that hash, and that expiry are the
  ones recorded at egress. A package from outside the loop is refused
  as never-issued no matter how beautiful its signature is.
- Not metadata privacy. Frames are cleartext by design
  (inspect-without-unwrap): canary, dates, and sender and recipient
  fingerprints are visible. (v1/v2 frames also carry the plaintext
  SHA-256 — a guessing oracle, and the reason v3 replaced it with a
  keyed commitment that only the recipient can compute; v3/v4 frames
  expose no content-derived value at all.) In repo mode the wrapped
  tree also preserves the source tree's relative paths. Content is
  sealed; structure is visible.
- Not a phone-home. The canary is an identifier, not a transmitter.
  Nothing in this tool calls out. The beacon fires when the packet
  *wakes on an observed network*: when it is presented to a daemon of
  this tool (return-match) or pointed at with `inspect`. A packet that
  is never presented anywhere is never reported — its confidentiality
  does not depend on being reported, but its beacon does.
- Expiry is policy enforced by an honest daemon; the frame states the
  terms, the registry remembers them, and the return-match enforces
  the remembered ones.

## Format compatibility

Packages are `SCRIPTURE-ARMOR v1` — the same format as the original
internal tools; this fix changes daemon behavior, not the package
format. Identities are interchangeable via `--identity-dir`; an
identity created by either tool works in both, and packages wrapped by
either open in both. One operational consequence of the closed loop:
packages wrapped by an older tool that never registered issuances are
refused by this daemon as never-issued until their issuances are
recorded — `node armor.mjs register <file.scripture>` does exactly
that, deliberately, in the open.

## Tests

```sh
node test/run-tests.mjs        # or: npm test
```

Builds identities and a fixture repo (nested dirs, a 10 MiB file, a
binary file, an empty file, an empty dir), wraps it, verifies it,
flips one glyph and watches verify fail on the named file, asks the
wrong daemon and watches it refuse, then unwraps the whole tree
through per-package owner approvals and compares every restored file
byte-for-byte. Around that baseline it proves the closed loop:
registration at egress and consumption on return; replay refused as a
beacon; a re-signed expiry extension (the attack that beat the
pre-fix daemon) refused as `expiry-mismatch`; an edited hash refused
as `hash-mismatch`; a never-issued package refused as `never-issued`;
the outbox queue and its sync; registry persistence across restarts;
claim-at-pend one-shot enforcement — two concurrent presentations of
one package produce exactly one pending and one output, the twin
beacon-refused as `replay-claimed`, and claims released (never
consumed) on window expiry and on requester disconnect; sender +
registry status on the approval surface; oversized socket
frames dropped; approve-after-window and double-approve refused;
restore hardening (symlink refusal, setuid stripping, part
containment, manifest count validation, restore scale in the approval
prompt, a 20,000-zero-byte-file flood restored only under an informed
approval); `trust` refusing garbage; store permissions; and the
`dns-profiles/` templates parsing with their placeholders intact.

The full battery across every suite — `run-tests.mjs`,
`run-tests-v2-scan.mjs`, `run-tests-v2-cell.mjs`,
`run-tests-v2-airlock.mjs`, `run-tests-v2-estate.mjs`,
`run-tests-v2-phase4.mjs`, `run-tests-v4-pq.mjs`, and
`run-tests-gemini-fix.mjs` — totals **431 checks** (53 + 83 + 94 +
61 + 27 + 68 + 22 + 23; the scan suite additionally defers 4 checks
to the cell suite).

## License

**Apache License 2.0 — see `LICENSE`.** Scripture Armor is free and
open source, for everyone: use it, copy it, modify it, and distribute
it under the terms of the Apache License, Version 2.0. The armor is
given away; what you wrap in it stays yours.

## Origin

Designed by Robbie Glover (Ronin Inc) — Scripture Armor: a closed loop
that generates a hash as information leaves, wraps it in unreadable,
untranslatable glyphs under symmetric math, and waits for the return
hash to match.
