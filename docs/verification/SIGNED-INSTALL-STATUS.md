# Signed installation status (review candidate)

The legacy `/cert-status` remains unchanged. New bounded POST `/install-cert-status` verifies the existing ES256 enrollment certificate, matches its device and key hash to the authenticated device record, reads the server's current release, checks device/install revocation, and signs a 60-second nonce-bound status with the existing `CERT_SIGNING_KEY`. It does not issue entitlements or prove that running binaries are genuine.

The production client permits only the established update host origin from the verified shipped installer. It refuses configurable transport, destination, clock or trust overrides, disallows redirects, bounds the response, and checks the exact signed certificate digest and installation tuple. Missing host key, device record, valid current-release metadata or signature fails closed. The fixture seam remains double-gated.

Verification: `node --test test/update-host-signed-status.test.mjs test/launcher-crm-identity-client.test.mjs test/update-host-addons.test.mjs test/update-host-download.test.mjs` exercises the actual worker and client using synthetic ES256 keys, mocked KV/R2 and real signatures. It also verifies unchanged legacy behavior, revoked/superseded installs, wrong bearer/device, forged certificate, bounded requests and forbidden trust overrides.

Not deployed or tested against live credentials. Server deployment and inspection of its existing signing/public-pin alignment and current `latest.json` remain required before production composition works. This status is separate from paid/fleet capability grants and must not be treated as a purchase or contribution entitlement.
