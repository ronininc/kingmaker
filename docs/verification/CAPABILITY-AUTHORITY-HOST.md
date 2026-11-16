# Capability authority host (local review candidate)

New POST `/capability-grant` and `/capability-status` require a verified enrollment certificate, its matching current device bearer, current published release, and no device/install revocation. They use the existing `CERT_SIGNING_KEY`; no signing key is generated or rotated.

Entitlement evidence is obtained only through a configured server-side `CRM_CAPABILITIES.evaluateCapabilityEvidence(query)` service-binding RPC. No caller-controlled URL, unsigned HTTP evidence or fallback exists. RPC derives the member from current database bindings. Host checks nonce, installation/device/provider/basis, exact capability set, evidence ID, consent revision and at-most-60-second freshness. Missing service/pins/records/approved consent or payment evidence fails closed. Bare opt-in and client payment flags grant nothing.

Grants and current-status envelopes are short-lived ES256 records accepted by the actual Kingmaker verifier. Status re-queries authoritative evidence and refuses changes to evidence/consent, revoked or superseded installs, altered grants and challenge mismatches. This does not itself prove PQ possession; the consumer requires its separate real Armor handshake.

Local proof command: `node --test test/update-host-capability-authority.test.mjs test/update-host-signed-status.test.mjs test/update-host-addons.test.mjs test/update-host-download.test.mjs` (34 passed). Uses actual worker/client cryptography and synthetic binding records; no live credentials or calls.

Not deployed. CRM entrypoint, explicit service binding, verified evidence ingestion and appropriate approved offer/fleet-disclosure records must be reviewed and configured before live unlock. Do not substitute legacy payment flags or fabricate fleet-benefit consent. Current installed/website releases do not gain this functionality from these local commits.
