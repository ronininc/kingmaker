# Unified platform capability bridge: review candidate

No deployment, real billing, fleet enrollment, owner-key access, or installed-product mutation is performed by this work.

## Implemented

- `armor-dock-provider.mjs`: public-only protocol consumer for standalone Armor. Requires independently pinned four-key public identity, performs real X25519 and ML-KEM-768 challenge, verifies both Ed25519 and ML-DSA-65 signatures and derived possession commitment. Fresh 60-second, audience-bound, single-use challenges. Owner Unix socket transport reads only the documented private token; never opens/migrates identity keys or imports paid implementation.
- `unified-capability-access.mjs`: free base remains accessible. Extended skill/PQC access requires ES256 authority-signed capability grant plus fresh signed nonce-bound current/revocation status. Grant is bound to installation, device and provider. Both paid and fleet grants grant the same requested capabilities. Fleet additionally requires explicit local consent matching authority consent ID/version and not withdrawn. Opt-in alone and client payment assertions never grant access. PQ capability additionally requires a module-verified real provider proof, not a caller-created boolean.
- `fleet-learning.mjs`: old raw-report envelope that merely set `customerDataIncluded:false` is refused. Only the existing closed fleet packet schema may be wrapped. Raw operational reports remain local aggregation inputs.
- `sharing.mjs`: no default allow-all validator; even a caller-supplied validator cannot bypass the closed schema. Ambiguous affirmative prefixes are not consent. Consent is rechecked after asynchronous packet construction, so withdrawal prevents that pending send.

## Executable evidence

`node --test test/armor-capability-integration.test.mjs test/fleet-privacy-boundary.test.mjs test/sharing.test.mjs test/fleet-learning.test.mjs` passed 14 tests, zero failures/skips (plus legacy test file's 11 internal assertions). Includes real crypto and owner-socket client round trip with synthetic provider, grant signatures, payment/fleet/free paths, withdrawal, forged proof object, replay, revocation/expiry, personal-text sentinel exclusion and validator-bypass refusal.

Standalone Armor worker independently tested actual provider implementation against this consumer with synthetic identities. Its real daemon owner-auth and PQ endpoint changes are separately reviewed.

## Authority contract and remaining blockers

Signed grant payload: `ronin.capability-grant/1`, issuer `ronin-update-host`, product `kingmaker`, grantId, installId, deviceSha256, providerFingerprint, basis `paid` or `fleet`, capabilities `ronin.skill-base`/`scripture-armor.pqc`, issuedAt/expiresAt in epoch milliseconds, fleet consent `{id,version}`. Public identity order is x25519, ed25519, mlkem768, mldsa65 (DER SPKI base64); fingerprint is SHA256 of its JSON.

Current-status payload: `ronin.capability-status/1`, same issuer/grant/install/device, current true, revoked false, nonce from `begin()`, grantDigest = SHA256 of exact signed grant payload, issuedAt/expiresAt with maximum 60-second status life. Envelopes use the existing ES256 signing-key trust root. No new key is invented.

CRM evidence evaluator/issuance wiring must provide these actual signed grants and status from verified payment or explicit fleet enrollment records. That bridge is not deployed or wired here. Existing install-certificate status is not capability status. Existing classical Kingmaker paid-profile reporter cannot be made PQ-capable by changing claimed key names; do not mark that path operational until the new provider and authoritative grants are wired through it.

The provider proof demonstrates key possession, not content sealing. Generated-output protection still requires a real authenticated sealing operation and verified output receipts. Do not claim generated apps have received PQ protection from this handshake alone.

Privacy tests prove rejection/exclusion of the tested personal-text fields at these boundaries, not absolute anonymity. Metadata and allowed vocabulary/counts can remain identifying, and outbound paths outside this boundary need their own review. No blanket 'personal data never leaves' guarantee is made. A grant must be reauthorized at each protected operation; do not cache an allowed boolean across withdrawal or expiry.

## Output-sealing review continuation

- `armor-output-provider.mjs` implements bounded owner-socket `seal-output`, verifies both provider signatures, fresh single-use challenge, input/package/recipient hashes, language, expiry and pinned four-key identity. Maximum plaintext 256 KiB; response limited to 2 MiB. No plaintext fallback.
- `createStandaloneGeneratedOutputProtection` composes the real provider with `createGeneratedOutputProtection`. Every operation checks a new signed capability grant status and actual hybrid possession before sealing and again before returning output, including local fleet withdrawal. No cached allowed Boolean. Provider receipts are local evidence containing input hashes; do not publish them indiscriminately with ciphertext.
- Production capability factory fixes the existing authority key and derives installation from a verified enrollment certificate, not caller-supplied installId. Custom keys/plain installation are accepted only by explicitly named fixture factories with both NODE_ENV=test and KINGMAKER_DOUBLE_FIXTURE_GATE=1. Capability status is not install-certificate revocation status; live composition still needs the separate current-install status bridge.
- Transport has an absolute deadline (slow-drip cannot extend it) and rejects a symlinked standalone root as well as unsafe owner/token/socket. These checks are not a claim of immunity to hostile same-user filesystem races.
- Local tests: 18/18 pass, no skips, including altered/replayed/expired receipts, revoked grants, withdrawn consent during the asynchronous seal, authority override refusal and slow-drip timeout.
- Independent actual standalone synthetic daemon -> socket consumer -> distinct recipient decrypt passed with exact plaintext equality; altered receipt and replay rejected. No user keys or identity stores used.
- Still not deployed or wired into a shipped UI. Authoritative paid-or-fleet issuance bridge remains unavailable. Receipt proves encryption, not registration, owner-approved unwrapping, or permanently guaranteed protection. Live paid/fleet entitlement is not established by these synthetic tests.
