# Strongly consistent fleet coordinator and reviewed redistribution

Review source only. No namespaces, production migrations, secrets or deployments were activated.

## State and ordering

`fleet-host/index.mjs` exports the Worker and `FleetCoordinator`. Each opaque installation ID routes to its own SQLite Durable Object. A single synchronous SQLite transaction binds the initial proof hash, checks withdrawal, deduplicates packet IDs, enforces the daily cap, and stores the validated generic packet. There are no external R2 writes that can arrive after deletion. Forget atomically deletes packets and marks the instance withdrawn. A minimal installation/proof-hash withdrawal record remains so old credentials cannot re-enroll and repeated authenticated forgetting is idempotent. This is not deletion of that security tombstone.

All authoritative state is in the object; missing binding fails closed503. Legacy KV/R2 bindings have been removed from review config, not touched in any real account. Existing remote state must be separately audited/migrated before deployment; no automatic migration or silent import/re-enrollment is supplied. The proposed wrangler SQLite migration is configuration for review, not evidence it has run.

Concurrent operations linearize at the synchronous transaction. A contribution or catalog read that commits before withdrawal may complete its response afterward; nothing can commit after the withdrawal point. This does not retract copies previously delivered. Proof ownership is the retained first-valid-contribution model, not authenticated CRM fleet-benefit enrollment, paid status or a new entitlement grant.

## Governed retrieval

`GET /bundle?nonce=<64hex>` requires the existing installation proof and nonwithdrawn state. It returns only the two original immutable reviewed catalog components, not stored uploaded content or arbitrary old bundles. The response signs schema, install ID, fresh nonce, timestamps, exact methods and SHA256 catalog hash using the configured Ed25519 key. Component license text and notices travel with the definitions.

`fleetTransport.retrieveReviewedMethods()` verifies the existing public-key pin, exact immutable catalog, hash, nonce, expiry and one-use challenge. It returns inert definitions; no installation, URL fetch, code execution or entitlement grant occurs. This is a narrow original catalog distribution mechanism, not aggregation or approval of new learned methods. The legacy Armor-wrapped transport configuration explicitly refuses this retrieval until a matching armored host implementation exists; there is no silent plaintext fallback.

## Actual local runtime proof

Used the already-installed Miniflare/workerd with SQLite Durable Objects, with esbuild bundling actual source. No dependency install or external services:

```
KINGMAKER_WORKER_TEST_DEPS=/path/to/existing/package.json node test/fleet-coordinator-workerd.proof.mjs
```

Verified: 12 concurrent identical submissions produce exactly1 accepted+11replay refusals; 20 distinct concurrent submissions produce exactly4accepted+16rate refusals; competing initial proofs yield one200 and one403; concurrent forgetting/contributions leave a tombstone and zero packets on repeated forget; postwithdrawal contributions/catalog retrieval refused. Actual client retrieves and verifies the signed catalog; replay, substituted nonce, altered content, expired document and invalid signature refused. Secret/unknown-rights packets remain refused.

35 focused Node tests also pass, zero skips. The old fake-KV positive tests were replaced by this real workerd proof plus pure failclosed/signature tests, rather than preserving an unsafe mock-only fallback. Full release QA must run the workerd proof explicitly alongside the default unit suite.

Cloudflare API reference consulted: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/ . Packet state and rates use `storage.transactionSync` and synchronous SQL only; no external await occurs inside the transaction.

## Build implications

Changed `lib/fleet-transport.mjs` requires a new app payload/signature. Worker entrypoint, Durable Object source and review migration are a separate deployable service change. No production readiness claim until approved configuration, legacy-state migration assessment, real service bindings and hosted verification are complete.
