# Authority deployment configuration: local review only

Frozen 4.5.3 product artifacts are unchanged by this test/documentation branch. Nothing here deploys, migrates, creates secrets, or authorizes payment/consent.

## Routing now tested, not merely mocked

```
PLATFORM_AUTHORITY_CHECKOUT=/path/to/reviewed/crm node scripts/capability-service-binding-proof.mjs
```

The script runs the actual update-host worker and the actual CRM `PlatformCapabilityAuthority` WorkerEntrypoint as separate local workerd workers, connected by the real named service binding. Actual local D1, KV and R2 hold synthetic records. Both paid and fleet paths produce correctly signed grants and current status; absence of evidence and later D1 revocation deny. No injected RPC callback substitutes for the service boundary. Synthetic ephemeral authority keys never leave this local test. No production credentials are used.

This adds routing evidence to the separate existing full Armor encryption/decryption proof, not a claim of live payment or enrollment.

## Concrete production configuration work

1. CRM must export its reviewed `PlatformCapabilityAuthority` entrypoint from the actual production Worker entry module. Its separate review file is not currently a production export.
2. The update-host configuration must bind `CRM_CAPABILITIES` to that **verified deployed CRM Worker name** and entrypoint `PlatformCapabilityAuthority`. Do not invent a service name or expose a public JSON entitlement endpoint. Example structural shape only: `services: [{binding: 'CRM_CAPABILITIES', service: VERIFIED_CRM_WORKER_NAME, entrypoint: 'PlatformCapabilityAuthority'}]`.
3. CRM's existing D1 binding needs reviewed authority evidence/revocation tables. The proposed SQL has not been applied. Existing device/member mapping tables must belong to the same authoritative environment.
4. `PLATFORM_AUTHORITY_RECORD_PUBLIC_KEYS` must contain explicitly approved P-256 public JWKs indexed by actual record-signing key ID. Never use test pins, derive trust from an incoming record, include a private JWK, or silently create a new authority.
5. Verified ingestion must populate exact account/install/device/provider-bound signed records. Signature validity alone cannot prove payment, informed consent, active membership or ownership. Revocation must invalidate fresh status promptly.
6. Host retains its existing `CERT_SIGNING_KEY`, DEVICES and RELEASES bindings. Do not export or rotate the existing key to configure this bridge. Existing published-release/install-certificate checks remain mandatory.
7. Review exact offer and consent semantics before enabling records. `$99` does not establish recurrence, existing-customer migration, refund policy or consent scope. Missing approved values must keep that route unavailable, never default to a guessed value.
8. After explicit deployment permission, verify real service routing, configuration and current authority evidence in the target environment. Then perform an authorized account's real enrollment/activation and withdrawal/revocation check. Local tests cannot attest that production configuration exists.

## Remaining blockers, not code limitations

Actual offer identification/cadence and approved fleet disclosure cannot be invented by implementation. No reviewed live authority signer/record-ingestion configuration has yet been established. Deployment and any necessary terms/account changes remain held for owner review. Free base operation remains independent of paid/fleet availability.
