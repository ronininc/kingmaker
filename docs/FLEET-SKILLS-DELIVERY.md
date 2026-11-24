# Fleet Skills delivery

The private Fleet index is one signed document with four entry types. Brain and Weights are distinct metadata references. Reviewed skills and tools explicitly approved for defensive use can carry an Add package. The package is declarative. Add registers it in My Tools and grants no access or execution.

## Source ownership

| Type | Source repository | Contribution |
| --- | --- | --- |
| Brain | `ronininc/kingmaker-brain-library` | Brain Library selection metadata, benchmark results, and model references. `lib/brain-library.mjs` pins the repository name and `docs/MAC-PROFILES.md` documents `library.json`. GitHub currently reports this repository as public. |
| Weights | `ronininc/weights` | Private weight manifests, model blobs or parts, and some tool release artifacts. `docs/8GB-CLASS-LAYOUT.md` documents the JEV weight manifest; `docs/opencode-tool.md` records the tool artifact overlap. |
| Skill | `ronininc/ronin-skill-library` | Private reusable build skills and their composition index, confirmed by GitHub repository metadata. A source listing alone supplies no per-item Add approval. |
| Tool | `ronininc/kingmaker-tools` | Private tool and method source. `lib/method-conductor.mjs` documents its method seed records. Inclusion as a source supplies no defensive tool approval. |

`ronininc/xtool` exists. Its repository metadata describes an Xcode replacement and Kingmaker's catalog references did not establish it as an index source.

## Source reconciliation and CRM handoff

**527** — owner-reported Ronin CRM methods; live count unverified. The repository counts below describe the pinned paths used for overlap checks.

| Source | Verified commit | Scope |
| --- | --- | --- |
| `ronininc/kingmaker-brain-library` | `98bfdf57a3a2fbc0b035076f3bf4cd7316aa3aa2` | `library.json` metadata reference |
| `ronininc/weights` | `7602635dcbd38a563e579ae8b70898b80ea6f22a` | `jev/MANIFEST.md` metadata reference |
| `ronininc/ronin-skill-library` | `8ea59d5a868c241e3b2070bf2feb1aaa36bd048f` | 190 top-level skill files |
| `ronininc/kingmaker-tools` | `5f72f4c30f5975b04d00eebc04f8e81e7c26850b` | 440 skill files under `skills/` and 34 Markdown files under `methods/` |
| Ronin CRM Method Library | access blocked; count unverified | Fifth candidate source. Total, unique, duplicate, draft, archived, and approved counts are unverified. |

All 190 top-level Skills files have byte-identical copies at the corresponding `skills/` paths in Tools, verified by matching Git blob IDs. The 34 Tools method files had zero digest matches and zero filename-derived name matches against those Skills files. Brain and Weights contribute distinct manifest references.

The six existing review candidates' SHA-256 pins were verified against their pinned commits. Their review status remains pending.

**Request to the authorized Ronin CRM admin** — Please provide a private, metadata-only export of the method library containing the stable method ID, exact version, source status, and content digest where available. Include the digest algorithm if known and leave missing digests empty. Omit customer data, CRM notes, and method bodies. Share the export privately with the authorized reviewer.

Reconcile exact stable IDs and comparable content digests first. An exact stable ID links the same method across versions. Confirm an exact version duplicate using its version and matching digest where both are available. Record differing digests as different content and leave missing-digest comparisons unresolved. A digest match across IDs confirms identical content without merging the identities. When names are already available in authorized metadata, report name-only matches as possible overlaps. Report total, unique, duplicate, draft, archived, and approved counts separately and preserve the CRM status labels. CRM routing status alone does not establish Fleet approval.

Keep CRM metadata in the private review material. Admit only a reusable method whose exact version has been reviewed and explicitly approved by the owner through the existing publisher approval gate. Customer data, CRM notes, and method bodies stay out of the published catalog.

## Owner provisioning

Approve a private, read-only HTTPS origin, the exact index URL, and the index publisher's Ed25519 public key. The Fleet contribution worker handles telemetry submissions. Neither it nor GitHub access to the source repositories defines an approved signed index endpoint or key.

Provision two files in the install's Fleet state directory at `$SOL_GHOST_HOME/fleet` when overridden, or `~/Library/Application Support/sol-ghost/fleet` by default.

| File | Contents |
| --- | --- |
| `skills-feed.json` | `{"catalogUrl":"https://fleet.example.invalid/catalog/index.json"}` with the approved URL substituted |
| `skills-feed-token` | Per-install bearer credential for `"auth":"bearer"`, mode 0600. Provision separately. |
| `skills-public-key.pem` | The approved Ed25519 SPKI public key in PEM format, delivered separately from the feed |

The client uses same-origin HTTPS for the index and packages and refuses redirects. For bearer-authenticated private delivery, add `"auth":"bearer"` to the config. The token goes only in the Authorization header. The private read handler can serve an explicit artifact-path map behind owner-managed TLS, returns 401 to unauthorized clients, and disables caching. Each response is limited to 2 MiB and 10 seconds.

The bar fetches at startup, every minute, and when Fleet Skills is opened or refreshed. A failed refresh or a cache older than 135 seconds blocks Add and invocation. The last verified rows can appear alongside the error. The signed revision serves as the rollback check across restarts. Preserve it when moving an install. A key change needs a separate trusted migration. `fixtureLoopback: true` permits HTTP on `127.0.0.1` for test fixtures.

## Publisher handoff

Run `node scripts/prepare-fleet-index.mjs --review <file> --out <new-file>` before signing. The review file contains `publishedAt`, `deliveryOrigin`, and `candidates` of the form `{"reviewStatus":"pending","entry":{...}}`. Add `--approvals <owner-approved-entry-array.json>` after owner review. A candidate enters the draft only after its status is `ready` and the entire proposed entry exactly matches a record in that separate array. The command only writes a private local unsigned draft.

For subsequent batches, supply `--previous <signed index> --public-key <approved PEM>`. Set `revocations` in the review file to `[{"id":"...","reason":"..."}]` when needed. The command verifies the prior revision, requires a later timestamp, and carries forward existing revocations.


1. Collect arrays of reviewed metadata from the verified repository sources. Apply the CRM handoff gate before considering a CRM-derived entry. Each entry carries `type` (`brain`, `weights`, `skill`, or `tool`), globally unique `id`, `version`, `publisher`, `description`, `state` (`reviewed` or `revoked`), and `source` with `repo`, full `commit`, repository-relative `path`, and lowercase SHA-256 `sha256` of the reviewed artifact or manifest bytes. For multipart weights the referenced manifest supplies the weight and part pins. Keep source material outside the index.
2. For a reviewed skill or approved defensive tool, export the reviewed declarative package with schema `kingmaker.skill-package/1`. Sign `kingmaker.fleet-skills.package.v1:` followed by `canonicalJson(package)` using the offline Fleet Ed25519 signer and encode the signature in Base64. Serialize `{"package": {...}, "signature": "..."}`. Adopting entries carry `packageUrl`, the SHA-256 `packageSha256` of those exact envelope bytes, and matching `permissions` and `dependencies`. Set `approval: "defensive"` only with a recorded defensive approval. Executable tool artifacts stay outside this adoption path.
3. Compose the arrays into a single `kingmaker.fleet-index/1` document with a strictly increasing UTC `publishedAt`. The builder validates the envelope and emits counts by type. Omit `--sign-key` for a local unsigned draft. On the approved offline signer, `--sign-key` adds an Ed25519 signature over `kingmaker.fleet-index.v1:` followed by `canonicalJson(index)`.

   ```sh
   node scripts/build-fleet-index.mjs --published-at 2026-11-24T00:00:00Z \
     --out /private/path/fleet-index.json /private/path/reviewed-entries.json
   ```

4. With owner approval, make immutable packages available first, then atomically replace the index. Serve the index with `Cache-Control: no-store`. For revocation, set the entry to `"revoked"` with an optional `reason`, and sign and deliver a newer revision. Keep revocation entries in later revisions.

Signed managed feeds require the new index schema. Legacy manually supplied skill catalogs remain readable on unconfigured installs until an index has been accepted. Publishing remains with the approved operator.

## Verification and native build inputs

Run `node --test test/fleet-skills*.test.mjs test/connectors.test.mjs` for fixture proof. The loopback test provisions only a URL and fixture public key on two state directories, exercises actual HTTP delivery, then tests Add and explicit invocation with a mocked model. It covers signed revocation, tampering, rollback, and same-revision conflicts.

The standalone Kingmaker release can proceed independently of Fleet Skills acceptance.

Fleet Skills native acceptance needs either an owner-supplied signed package for this revision or approval to run production signing. Staging requires the native wrapper, engine executable and complete engine resource tree, this revision's payload tar, its signed release manifest with the payload pin, and the private key for the pinned Kingmaker Release code-signing identity available to the signing machine. The installer requires the matching release manifest and detached signature. Shipping DMGs also require their normal enrollment inputs and, for Developer ID notarization, the approved identity and notary profile. Test installs need the approved index URL and public key provisioned independently.
