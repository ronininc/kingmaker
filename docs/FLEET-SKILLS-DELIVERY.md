# Fleet Skills delivery

## Owner provisioning

Approve a private, read-only HTTPS origin, the exact catalog URL, and the Fleet Skills publisher's Ed25519 public key. The existing Fleet contribution worker accepts telemetry submissions. A Fleet Skills catalog endpoint and key have yet to be approved.

Provision two files in the install's Fleet state directory. This is `$SOL_GHOST_HOME/fleet` when overridden, or `~/Library/Application Support/sol-ghost/fleet` by default.

| File | Contents |
| --- | --- |
| `skills-feed.json` | `{"catalogUrl":"https://fleet.example.invalid/skills/catalog.json"}`, with the approved URL substituted |
| `skills-public-key.pem` | The approved Ed25519 public key in SPKI PEM format, delivered separately from the feed |

Both the catalog and package URLs must use the approved HTTPS origin. Restrict access at the private network or origin. The client uses GET without redirects or credentials. If the approved service requires authentication beyond network access, agree on that integration before rollout. Each response is limited to 2 MiB and a 10-second request.

The bar fetches at startup, every minute, and when Fleet Skills is opened or refreshed. A failed refresh or a cache older than 135 seconds blocks Add and invocation. The bar can still show the last verified rows alongside the refresh error. The persisted signed revision serves as the rollback check, including across restarts. Preserve it when moving an install. A key change needs a separate trusted migration plan.

`fixtureLoopback: true` permits HTTP on `127.0.0.1` only. Leave this field out of production provisioning.

## Publisher handoff

1. Export the reviewed declarative package using schema `kingmaker.skill-package/1`. Use a new package version for changed contents.
2. Sign the bytes of `kingmaker.fleet-skills.package.v1:` followed by `canonicalJson(package)` using the offline Fleet Skills Ed25519 key. Encode the signature in Base64 and serialize the envelope as `{"package": {...}, "signature": "..."}`.
3. Hash the exact envelope bytes with SHA-256. Build the catalog using schema `kingmaker.fleet-skills/1`, a strictly increasing UTC ISO 8601 `publishedAt`, and a `skills` array. Each entry carries the package's ID, version, publisher, description, permissions and dependencies, plus the same-origin HTTPS `packageUrl`, lowercase `packageSha256`, and `state: "reviewed"`.
4. Sign `kingmaker.fleet-skills.catalog.v1:` followed by `canonicalJson(catalog)`. Add that Base64 signature as the catalog's top-level `signature`. Use the canonicalizer exported by `vendor/fleet/fleet-packet.mjs`. Verify the finished artifacts with the provisioned public key before handing them to the origin operator.
5. With owner approval, make the immutable package available first, then replace the catalog atomically. Serve the catalog with `Cache-Control: no-store`. For revocation, publish a newer signed catalog with the same skill entry marked `"revoked"` and an optional `reason`. Keep revoked entries in future catalogs so clients retain the reason.

Publishing remains with the approved origin operator. The client has no upload path and needs only the URL and public key.

## Verification and native build inputs

Run `node --test test/fleet-skills*.test.mjs test/connectors.test.mjs` for the fixture proof. The loopback test provisions only config and a public key on two clients, then exercises actual HTTP delivery and the real Add and invocation handlers with a mocked model.

Native acceptance needs either an owner-supplied signed package for this revision or approval to run the production signing path. Production staging needs the app wrapper, engine executable and complete engine resource tree, this revision's payload tar, the release manifest with its offline Ed25519 signature and payload pin, and the installed private key for the pinned Kingmaker Release code-signing identity. The installer build also takes the matching release manifest and detached signature. A shipping DMG requires its normal enrollment inputs and, for Developer ID notarization, the approved identity and notary profile. Test installs need the approved feed URL and public key provisioned independently.
