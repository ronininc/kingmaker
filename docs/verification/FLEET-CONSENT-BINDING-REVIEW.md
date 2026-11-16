# Consent-bound fleet ingress: local review

## Implemented protocol

1. The existing local current-disclosure choice is checked before and after asynchronous authorization. Missing local consent stops contribution/catalog retrieval; proof-only forget is exempt.
2. The client requests a bounded DO challenge over the configured fleet origin. The SQLite object stores a random one-use nonce bound to opaque fleet ID, actual proof hash, operation, canonical request digest, certificate digest, and the fleet server's public-key fingerprint. Pending challenges are bounded16 per installation and expire after60seconds. Challenge issuance does not enroll or authorize sharing.
3. The client sends its existing enrollment bearer **only** to the already-pinned update-host `/install-cert-status`, with the challenge nonce and enrollment certificate. No new update-host endpoint, key or bearer destination was introduced.
4. Contribution/catalog requests carry the signed status and signed enrollment certificate as separate authorization metadata, not in the skill packet. The fleet verifies the existing pinned certificate authority, certificate tuple, nonce, current/unrevoked status and freshness. Its fixed public pin is tested byte-for-byte against the shipped enrollment PEM. Production never accepts caller-selected trust roots; fixture verification is explicitly double gated.
5. Fleet calls the trusted `FLEET_AUTHORITY.evaluateFleetSharingEvidence` service RPC with certificate-derived installation/device, enrolled provider fingerprint, fleet ID, proof hash and a fresh independent nonce. The RPC must validate current signed consent containing the exact immutable fleet binding. Missing binding, old unbound consent, mismatch, withdrawal, stale/malformed evidence or unavailable authority denies. No member ID, raw proof, bearer or packet content is sent to CRM.
6. The SQLite transaction consumes the challenge with the exact operation/body/certificate/key binding and checks evidence expiry. Replay and body substitution fail. Revocation tombstone prevents a concurrent late operation from committing after forget. Forget still authenticates solely with the existing proof so revoked installs can erase retained packets.

## Client configuration

Existing `fleet/fleet.json` may reference `enrollmentFile` and `updateFile`. These are explicit owner-only bounded regular single-link JSON files, with final symlinks refused. `updateFile` is the existing installer `{url,key}` file; its URL must match the pinned update host. No second bearer store is created. `enrollmentFile` contains the signed `installCertificate` and enrolled `providerFingerprint`, not private provider keys. CRM still independently verifies their relationship. No runtime configuration or user credential files were created or read during development.

The anonymous skill packet is unchanged. Authorization metadata necessarily includes signed installation/device claims for the fleet verifier; this is not a promise that the transport is anonymous or sends no installation metadata. No customer/source content, plaintext, private keys or enrollment bearer goes to fleet or CRM. The fleet proof itself is used only for authentication at its configured fleet endpoint, never as shared knowledge. The existing Armor-wrapped ingress remains explicitly unavailable rather than silently falling back.

## Evidence and limits

Actual local Miniflare/workerd ran the real fleet Worker, SQLite Durable Object, service-RPC routing and actual update-host handler with synthetic enrollment. Verified consent linkage, mismatched proof denial, revoked install denial, withdrawal and proof-only forgetting, exact-request replay/body substitution, concurrent rate/replay/forget ordering, signed catalog tamper refusal, and withdrawal during status fetch preventing payload dispatch. Network capture confirmed bearer only at the pinned update host and only proof hashes at the CRM RPC.

This proof's CRM adapter uses deterministic fixture evidence, not a claim that a live CRM returned consent. The separate website worker's real-D1 source/consent tests and combined service fixture are required for end-to-end store authority evidence. 36 focused Node tests passed, zero skips. Run the actual runtime proof explicitly:

```
KINGMAKER_WORKER_TEST_DEPS=/path/to/existing/package.json node test/fleet-consent-routing-workerd.proof.mjs
```

No production services, bindings, migrations, keys, consent records or deployments changed. `FLEET_AUTHORITY` remains a review placeholder until the real unmounted entrypoint is approved and bound. Existing remote state needs the previously documented migration audit. A signed status may remain valid for its short lease; current CRM consent is separately checked on every fleet ingress. This is bounded authorization, not instantaneous revocation of already delivered copies.

Build changes: fleet transport is bundled app code requiring rebuild. New fleet-host consent verifier and public-pin module belong to the Worker bundle, not a replacement credential. Original `fleet-coordinator-workerd.proof.mjs` now delegates to the stronger consent-bound runtime proof rather than retaining an unauthenticated alternate path.
