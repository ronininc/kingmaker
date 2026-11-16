# Reusable skill-only boundary, review candidate

Owner terms: $99/month or explicit fleet participation; eligible reusable components Apache-2.0, projects remain proprietary to their owners. No inference that a public repository or a license assertion grants redistribution rights. In particular, no blanket admission of ronin-skill-library or its symlink targets.

## Active paths changed

- `cli.mjs` daily sharing formerly exported `learning.kept()` preferences. It now exports only exact original generic method templates minted through the scoped admission API; preferences/model/device/routing telemetry are not exported.
- `createSkillFolder` (actual Skills-tab handler) rejects raw prose/code/unknown provenance before any directory or skill file is written. Known credential/private markers generate redacted flags; a regex miss is not approval. Unknown content is rejected regardless of a caller-supplied license/safe flag.
- `absorbConnector` no longer automatically mints raw tool descriptions/configuration. It returns redacted flags; existing local candidates are not deleted or relicensed.
- `state-conductor` can still tune and execute a local task in memory, but task-specific goals/paths are no longer persisted as reusable `.method.json` files without independent rights review.
- `openSharing`, the fleet envelope helper, and both plaintext/wrapped transport sinks independently enforce exact method admission. Armor identity initialization now occurs only when an admitted exchange is actually made, not on merely configuring the transport.
- Old telemetry opt-in is insufficient. Local sharing defaults off; current disclosure digest must match. Withdrawal is rechecked after asynchronous packet construction. The exact website disclosure text is reused, SHA256 `e36af28bdeb5fe7ad71fae31ba727d700a9d0e193ea6cc2073904a44999f9d32`, purpose `fleet-participation-for-platform-benefits`. Local settings do not create signed CRM benefit consent or grants.

## Deliberately narrow positive admission

Only `file-review` and `output-verification`, original release-reviewed generic recipes in `reusable-skill-policy.mjs`, currently qualify. These are structured reusable instructions, not trained weights, autonomous learning, or arbitrary source reconstruction. The exporter reconstructs them from immutable catalog content, never copies SKILL.md or customer files. Minted components carry an Apache-2.0 SPDX notice and separate authorship/project-ownership metadata. This does not relicense owner-authored method files or third-party material.

Unknown learned skills remain blocked pending a real item-specific provenance, redistribution-rights and privacy review process. Normal free-form Skills-tab creation and automatic connector minting are therefore intentionally unavailable for now. This is a substantive usability limit, not completion of autonomous safe skill synthesis. Detection flags never echo secret values; no perfect leak-detection claim is made.

## Packaging and unresolved integration

New `lib/reusable-skill-policy.mjs` must enter the next source payload and signed app build. This isolated branch is based on frozen candidate b68beff; that review build is untouched. No install, deployment, existing key, or live state changes.

The new `kingmaker.fleet-skills/1` wire schema has not been deployed or added to the legacy fleet host/aggregator. Legacy host retains its old telemetry contract, so a new client is expected to be refused until the server explicitly supports reviewed methods. Do not advertise successful live contributions. Protocol uses only an existing opaque installation ID and random packet ID plus exact generic methods; these identifiers are not a claim of anonymity. No account name, source text, private configuration, content hash of user material, preference or device metadata is included.

Tests retain legacy host storage checks as direct synthetic requests (not a claim the new client still exports telemetry). Active client tests prove old schema refusal, credential/unknown-rights mint refusal, exact component admission, tamper refusal, explicit consent and withdrawal, and task-local tuning without reusable promotion.

Focused verification: 38 tests passed, zero failures/skips (including legacy host synthetic compatibility and active new-client refusal).


## Follow-up: skill-only host acceptance (local review)

The legacy host gap described above is now addressed in source: actual `fleetTransport.send` -> Worker `/contribute` -> synthetic KV/R2 -> pinned signed receipt succeeds for exact `kingmaker.fleet-skills/1` packets. Both ends import the same reviewed catalog (`reusable-skill-catalog.mjs`, no filesystem APIs). Full standard Apache-2.0 license text and component-only NOTICE accompany every method, with exact validation; minted folders also receive LICENSE and NOTICE. This does not change repository-wide or owner-project licensing.

The Worker refuses legacy telemetry, unknown IDs, changed instructions, extra source/password fields, changed authorship/license/notice and malformed packets. Body reading is bounded by actual streamed bytes. Refusals use fixed reasons and do not echo arbitrary packet IDs or content. Storage paths use server day, not client-provided paths. Existing install-proof binding and signed receipts remain; invalid content cannot enroll an install. Serial replay IDs are refused. Forget tombstones the old install before deleting stored packets so it cannot silently re-enroll with an old proof; a failed deletion can be retried with its matching retained proof.

`/bundle` returns 501 even for a valid proof until a governed signed redistribution issuer exists; old arbitrary bundle objects are never returned. No new remote execution/import path is provided. No production consent issuance or fleet entitlement is minted by this host. The install-proof remains its existing first-valid-contribution trust model, not a substitute for the separate signed CRM benefit consent.

**Remaining production limits:** KV rate/replay/tombstone checks are not cross-region transactional; serial tests do not prove race-free distributed admission/withdrawal. A strongly consistent coordinator is needed before claiming such guarantees. Explicit sharing-off prevents future local sends; remote forgetting/tombstoning is the separate forget action. Re-enrollment after tombstoning has no automatic reset route. Actual hosted deployment, bindings, remote grant readiness and governed redistribution remain unproved. No live deployment, signing keys or user state were changed.

Packaging now additionally includes `lib/reusable-skill-catalog.mjs` and `lib/method-component-license.mjs`; the signed Kingmaker app must be rebuilt. The Worker update is separate reviewable code, not a live service change.

Follow-up evidence: 40/40 broader focused tests passed; final host-only suite after added body-limit and failed-cleanup retry cases: 9/9 passed, zero skips.
