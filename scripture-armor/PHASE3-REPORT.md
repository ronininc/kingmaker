# Scripture Armor v2 — PHASE 3 (Closure 4: estate extension) — BUILD REPORT

**Verdict: Closure 4 is BUILT and its battery is green. All prior gates
stay green.** Per item below: DONE / PARTIAL / BLOCKED, with the limits
named as limits.

## Test tally — all suites run on the final Phase-3 tree

| Suite | Result |
|---|---|
| v1 regression (`test/run-tests.mjs`) | **53/53** |
| Closure 1 scan battery (`test/run-tests-v2-scan.mjs`) | **83 passed / 0 failed / 4 deferred(phase2)** |
| Closure 2 cell battery (`test/run-tests-v2-cell.mjs`) | **94/94** |
| Closure 3 airlock battery (`test/run-tests-v2-airlock.mjs`) | **61/61** |
| Closure 4 estate battery (`test/run-tests-v2-estate.mjs`) | **27/27** (14 spec checks, several split into sub-checks, + 4 extras) |

## Per item

**Mesh transport + signed RPC (§4.2) — DONE.** Optional TCP mesh
listener in `vaultd.mjs`, started only when `policy.json
estate.mesh_listen` is set, bound ONLY to that address (battery check
6: connections on other local interfaces are refused; absent the
policy key there is no listener and the daemon's `status` output is
byte-identical to v1 — check 14). Every RPC is an application-signed
canonical document: `signPayload()` / `verifyPayload()` /
`canonicalMeshDoc()` extracted into `armor.mjs` on the same discipline
as frame signing (fixed field order, Ed25519). The receiving gate
checks, in order: known command → sender fingerprint present in the
address book with matching keys → signature valid → addressed to this
endpoint → sender not revoked. Responses are signed mesh documents
too, so a client can tell a definitive refusal from silence. RPC set:
`register`, `sync-registry`, `revoke`, `status`. `unwrap` / `approve`
/ `activate` are refused `unknown-command` on the mesh listener
(check 10) — opening stays a local act under the owner's hand.

**Registration over mesh (§4.2) — DONE.** `registerIssuances()` in
`armor.mjs` is transport-aware: a Unix socket path (v1, unchanged) or
`{mesh, toSealFp}` — the same register semantics and the SAME outbox
queueing on a new transport, per §0's seam table. The recipient is
chosen per wrap from the address book (`--register-socket` /
`--register-mesh` flags win; then the peer's `mesh` address or
`daemon_socket`; then the v1 default). Queued entries remember their
mesh destination (`_mesh_to`) and flush only to that daemon
(check 4: offline wrap queues, `register --to` drains on return).
Mesh register entries must be the signed sender's own issuances
(`register-sender-mismatch` otherwise) — attribution is intrinsic.

**Sync-registry (§4.2) — DONE, plus repair.** Digest exchange both
directions (`held` = what I hold from you; `issued` = what my issuer
memory says I sent you), revocations piggybacked, enrollment proofs
carried, conflicts resolved by refusal-and-log, never overwrite.
Two additions the spec's text supports and the battery proves:
(a) `want` — canaries a side is missing ride the response and the
issuer fulfills them with a full-entry register from its issuer
memory; the reverse direction works via a `fulfill_request` follow-up
(check X1: a lost registration is never-issued until sync repairs it,
then the package opens);
(b) `revocation_ids` — every sync view names all record ids the
sender holds, so ack tables converge in one exchange even for records
that arrived via a response side.

**Enrollment (§4.3) — DONE.** `armor.mjs enroll <label>`: seals the
estate descriptor (member list + tiers + mesh host + Tier-3 roster +
policy digest + current revocation records) and a probe package to
the new endpoint as ordinary packages through `sealPlaintext`, and
registers both over the mesh. The new endpoint's state starts
`pending` and is named as such in status (checks 2/2a); the new
owner's approval of the descriptor package installs the roster
(descriptor opening = the act of joining); the probe's return-match +
opening logs `enroll-verified` on the new endpoint, and the proof
reported back over sync logs it on the enrolling endpoint and flips
the member to `verified` (check 1). A third peer enrolling MID-STREAM,
after the estate was already carrying traffic, is battery-proven
(check 15).

**Revocation (§4.5) — DONE, all three branches battery-proven
(check 7).** `vaultd.mjs revoke <label>` (owner act): creates the
signed record `{label, seal_fp, sign_fp, at, by_sign_fp, reason}` in
`revocations.json` (0600, atomic), distributes it by mesh `revoke`
RPC immediately and by sync piggyback until acked; un-acked members
show `revocation-pending` in the estate view (check 7a). Enforcement:
mesh RPCs from a revoked fingerprint refuse at the gate; new
registrations from it refuse `register-revoked` on BOTH transports
(the register path is shared); return-match of an issuance dated
AFTER the revocation beacon-refuses `revoked-sender`; an issuance
dated BEFORE it still returns, with `REVOKED SENDER …` in the
approval prompt notices (the notice rides `buildNotices`, so it
appears in unwrap and activation prompts alike). Wraps TO a revoked
peer are refused at wrap time by `armor.mjs` when this endpoint holds
a verified record. `untrust <label>` (the local inverse of `trust`)
is implemented and logged to `estate-events.jsonl` (check X2).
A revocation record is enforced ONLY when its signature verifies
against a known key for its signer — unverifiable records are kept as
claims and never enforced.

**Staleness bound (§4.5) — DONE.** An endpoint whose last completed
sync-registry is older than `estate.revocation_max_stale` (default
86400 s = 24 h) refuses new mesh registrations as `estate-stale`;
sync/revoke/status are never gated (sync is the cure); local traffic
is unaffected (check 8). A daemon that has never synced counts from
daemon start — the bound is on silence, not on birth. The task's
literal case is battery-proven: a peer whose persisted last-sync is
25 h old refuses under the DEFAULT bound (check X3).

**Tiering (§4.4) — DONE as tiered coverage, as the spec's verdict
requires.** Tier 1/2 members ride the descriptor with their tiers.
Tier 3 is named honestly as posture: the descriptor and the estate
view list the device at Tier 3 with `keys: false, can_open: false`
and its coverage stated as mesh-governed (routing/DNS/exit via the
mesh host — Addendum B: the mesh is the estate, the host device is
its server) + on-device posture (`dns-profiles/`, templates verified
placeholder-intact). Check 11 proves the negative: no key material
for the Tier-3 device exists in the descriptor, in either endpoint's
address book, or as an identity store — there is nothing to open
with. Tier 0 is the v1 `never-issued` behavior, regression-proven
(check 12).

**F2–F4 cluster (§4.6) — DETECTION implemented; prevention NOT
addressed, as the spec states.** The issuer-side memory
(`issued-log.jsonl`, appended by `registerIssuances` for every
transport and by the daemon for cell-egress issuances) gives sync a
ground truth to judge held-claims against: a canary one endpoint
holds that its counterparty never issued surfaces at sync as a
`sync-conflict`, logged on BOTH endpoints, and never overwrites
anything (check 13). What remains unaddressed, plainly: local
registry/outbox/log files are still unauthenticated — a same-uid
attacker on an endpoint can still FORGE that endpoint's local records
(prevention unchanged from v1); sync makes one class of forgery
detectable after the fact, it does not prevent it. One further
residual in the same family, named here because the battery exposed
its shape: sync restores ISSUANCE records from issuer memory, but
consumption state (`returned_at`) is local — an endpoint whose
registry loses a consumption record can have the bare issuance
restored by sync, so the local-integrity assumption (the store is
the owner's) is load-bearing exactly as in v1's F2–F4.

**Addendum B (mesh-first) — honored in the artifacts.** The
descriptor and every estate view name the mesh host (policy
`estate.mesh_host`, default self); Tier-3 coverage is expressed as
mesh governance + posture, never as daemon coverage. The mesh
transport itself is configuration (`mesh_listen`, address-book
`mesh` addresses), so the same build runs over a self-hosted
Headscale-class control plane or hosted Tailscale — nothing in the
code knows or cares which coordination server the tailnet uses.

**Addendum D (Kingmaker exception) — honored by absence.** There is
no code path that wraps, cells, catalogs, or enrolls any named
subject; the estate enrolls endpoints whose owners run the ceremony.
Kingmaker is not a mesh subject anywhere in this build.

## Deviations from the spec's letter (named)

1. **`status` is one of the mesh RPCs and also grew locally:** the
   local `status` output gains an `estate` field ONLY when an estate
   is configured (mesh_listen set, estate state, or revocations
   present) — with none, the output is byte-identical to v1
   (check 14 asserts the field's absence).
2. **Sync carries two fields beyond §4.2's list** — `want` /
   `fulfill_request` and `revocation_ids` — both inside the signed
   body, both serving text already in the spec (digest reconciliation
   with "full entries only for estate-internal issuances", and ack
   tracking in the descriptor state, §4.5). No new RPC types.
3. **`revocation_max_stale` is expressed in seconds** in policy
   (default 86400), where §4.5 speaks of "24 h" — same bound,
   test-friendly unit.
4. **The mesh listener's policy is read at daemon start** (a listener
   binds once), while all other policy is re-read per operation.
   Changing `mesh_listen` means restarting that daemon; enforcement
   values (staleness) are still read live.
5. **Estate state lives in `estate.json` + `revocations.json` +
   `issued-log.jsonl`** in the identity store — the spec names
   `revocations.json` and "descriptor state"; the split used here
   keeps each file single-purpose and 0600 like the registry.

## Honest limits (implemented-not-provable-here, never faked)

- **No live tailnet.** The battery runs multiple daemons on loopback
  (the spec §4.7 harness, verbatim). WireGuard/Tailscale/Headscale
  transport is platform-provided and out of suite scope; the mesh
  code path is identical either way, but a multi-machine estate has
  not been run.
- **Response signing is verified by the built-in clients** (armor's
  register path and the daemon's meshCall check the responder's
  fingerprint + signature); a peer daemon that answers unsigned is
  treated as unreachable and registrations queue — safe, but worth
  knowing when debugging a foreign implementation.
- **Revocation cannot recall the past** (§4.6, unchanged): packages
  already delivered and opened stay opened; revocation bounds future
  trust only. An offline endpoint keeps its old view until it syncs —
  bounded by the staleness rule only for endpoints that come back.
- **Tier 3 remains a ceiling, not a vault** (§4.6): posture is
  settings; nothing in this phase changes what a locked phone can or
  cannot do locally, offline, outside the mesh's sight.

## Files

New: `test/run-tests-v2-estate.mjs` (battery), `test/mesh-tee.mjs`
(capture proxy, own process — see its header for why).
Changed: `armor.mjs` (signPayload/verifyPayload/canonicalMeshDoc,
meshRpc, revocation + estate-state + issued-log helpers,
transport-aware registerIssuances, registrationTransport,
trust --mesh, untrust, enroll, wrap-side revoked-peer refusal),
`vaultd.mjs` (estate state + resolver, shared register path with
register-revoked, revoked-sender beacon + REVOKED SENDER notice on
unwrap/activate/activate-repo, enrollment openings in executeUnwrap,
mesh listener + signed-RPC gate + register/sync/revoke/status
handlers, revoke + mesh-sync + estate-status local RPCs and CLI
clients, egress issuer-memory append, status estate field),
`scan.mjs` (policy `estate` section + merge). The v1 standalone tree
was not touched; no GitHub calls were made.
