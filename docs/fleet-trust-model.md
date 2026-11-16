# Fleet abilities and the paid corpus: trust model (2026-11-16)

Status: **synthetic proof only.** Every key and identity in the proof is generated inside the tests in temp dirs, and all data is synthetic. Production owner keys, the transport and the distribution policy do **not** exist yet. Nothing here claims they do.

Proof: `node --test --test-force-exit test/fleet-boundaries.test.mjs test/ability-pipeline.test.mjs test/local-brain-access.test.mjs`

## Three libraries, three trust levels

| Store | Path | Who fills it | Gate |
|---|---|---|---|
| User's own methods | `<state>/abilities/methods` | the user (`writeMethod`, `promoteDraft`) | none, never paywalled; the isolated test must pass |
| Fleet abilities | `<state>/fleet/abilities/methods` | **only** `acceptAbilityRelease` | owner signature against a pinned key, revocation, replay, corpus, policy |
| Curated corpus cache | `<state>/brain-library/methods` | **only** `huntMethod` from the update host | server-side `library.methods` entitlement (`update-host/worker.js`) |

## The fleet path (nothing auto-trusts)

1. **Package** (`lib/fleet-review.mjs packageContribution`), on any install. This takes one method from the user's own library. It needs `consent === true` for that item, plus the install's current fleet consent (`sharing.json` with the current disclosure digest). Only the executable block is kept. Prose, notes, provenance paths, author names and the install id are dropped. If the executable block still holds secrets, private data, device paths or non-empty input defaults, the method **stays local** with its reasons. Nothing is silently redacted. Rights must be attested as `own-work` or `licensed`. Provenance records the origin, the per-item consent, the disclosure digest and the bytes stripped. The bundle goes to `<state>/fleet/outbox` and is **never transmitted**.
2. **Owner queue** (`createOwnerReviewQueue`), on the owner's private Kingmaker. Enqueue rechecks integrity, the per-item consent record, and whether the item matches the owner's corpus. `review` runs privacy, rights, parse, the Armor lexical scan, REA, and an isolated test. Little Brother is recorded as not applied. `decide` is the owner's act. `approve` signs a `kingmaker.ability-release/1` with the **ability-approve** Ed25519 key, and only if the stored evidence passed. `reject` signs a rejection record. Each item gets one decision. Nothing is approved by default or by timeout.
3. **Accept** (`acceptAbilityRelease`, the only way into the fleet store), on any install. It refuses with a reason when:
   - the release is not signed, or has a bad signature;
   - it was signed by a key other than the **pinned** owner ability key (this includes the runtime-release key);
   - the text does not match its hash, or the id/version does not match;
   - the owner has revoked it;
   - it has no `decisionId`;
   - it is **replayed**, meaning the same `decisionId` was already applied;
   - it is a **rollback**, meaning its version is not newer than the installed one;
   - it matches a paid corpus item;
   - the policy says no (see below).

   An owner-signed revocation quarantines an ability. A revocation from anyone else is ignored.

## Paid corpus boundary

- The real gate is the server. `GET /library/methods/*` returns 401 unless the request carries a host-signed `ronin.entitlement/1` that is unexpired, unrevoked and for sku `library.methods`. Without an entitlement the client does not contact the host at all.
- What has already been downloaded is not revoked offline. Revocation stops further downloads, and the docs do not claim otherwise.
- `lib/corpus-guard.mjs` fingerprints cached corpus methods by id and by a hash of their canonical steps. It refuses a match at four points: `promoteDraft`, `writeMethod`, packaging/proposal, and `acceptAbilityRelease`. The owner queue also checks against the owner's corpus source (`corpusStores`). **Limitation:** a copy paraphrased by hand, with changed steps, is not detected.
- Scripture Armor tools use sku `scripture-armor` (`lib/paid-access.mjs`). That is separate from this boundary.

## Still needed before production (owner decisions and infrastructure)

1. **Policy: should free installs receive fleet abilities?** No document decides this. The flag is `<state>/fleet/policy.json` (`kingmaker.fleet-policy/1`, `freeInstallsReceiveFleetAbilities`). The default is **false**, which is conservative: only installs with a verified membership receive fleet abilities. Owners also need to decide which sku counts as membership. The proof uses `library.methods`, and that choice is an assumption.
2. **Production owner role keys.** These need generation on the owner's private Kingmaker, custody and backup. `createOwnerAuthority` is used only by the tests.
3. **Pinning the owner trust record in the signed release.** Today `pinOwnerTrust` is a provisioning helper.
4. **Transport.** There is no transport for proposals (outbox → owner) or for releases and revocations (owner → installs). `lib/fleet-transport.mjs` and the `brain-library-fleet*` modules are not wired to abilities.
5. **Key rotation.** There is no rotation or compromise procedure, and nothing yet re-signs or revokes releases after a key changes.
6. **Distribution of the revocation list.** Receivers only see revocations they are given.
7. **Accepted abilities after a policy change.** If the policy is flipped back to members-only, abilities already accepted stay installed. Deciding what happens to them is an owner decision.
