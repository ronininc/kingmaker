import { createHash } from 'node:crypto';

const canonical = (value) => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const digest = (value) => createHash('sha256').update(canonical(value)).digest('base64url');
const requiredKeyTypes = Object.freeze(['X25519', 'Ed25519', 'ML-KEM-768', 'ML-DSA-65']);
const sameTypes = (value) => Array.isArray(value) && value.length === requiredKeyTypes.length && requiredKeyTypes.every((key) => value.includes(key));

/** Launcher-only CRM transport. Kingmaker supplies a locally verified Armor
 * attestation to Launcher; this client never gives Kingmaker a CRM route.
 */
export function createLauncherCrmIdentityClient({
  baseUrl, bearerToken, applicationId, memberId, providerRegistrationId,
  provider, providerPublicJwk, signReport, fetchImpl = globalThis.fetch,
  now = () => Math.floor(Date.now() / 1000),
} = {}) {
  if (!baseUrl || !bearerToken || !applicationId || !memberId || !providerRegistrationId || !provider
    || !providerPublicJwk || typeof signReport !== 'function' || typeof fetchImpl !== 'function') throw new Error('LAUNCHER_CRM_CONFIG_REQUIRED');
  const post = async (path, body = {}) => {
    const response = await fetchImpl(new URL(path, baseUrl), { method: 'POST', headers: { authorization: `Bearer ${bearerToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    let value = null; try { value = await response.json(); } catch {}
    return { response, value };
  };
  return {
    async report({ installCertificate, verifiedInstallIdentity, providerAttestation, armorKeyTypes, state = 'valid', certRevoked = false, identityPresent = true, dropReason = null } = {}) {
      if (!installCertificate || !verifiedInstallIdentity?.installId || !verifiedInstallIdentity?.deviceSha256 || !providerAttestation || !sameTypes(armorKeyTypes)) throw new Error('VERIFIED_LAUNCHER_REPORT_INPUT_REQUIRED');
      if (state === 'valid' && (!identityPresent || certRevoked !== false || dropReason !== null)) throw new Error('INVALID_VALID_IDENTITY_STATE');
      if (state === 'dropped' && ((identityPresent && certRevoked !== true) || !String(dropReason || '').trim())) throw new Error('INVALID_DROPPED_IDENTITY_STATE');
      const challengeResult = await post('/api/launcher/device-identity/challenge');
      const c = challengeResult.value; const issuedAt = now();
      if (challengeResult.response.status !== 201 || c?.schema !== 'ronin.launcher.identity-challenge/v1' || !c.challengeId || !c.challenge
        || !c.pairingId || !c.pairingInstallId || !Number.isInteger(c.expiresAt) || c.expiresAt <= issuedAt) throw new Error('CRM_IDENTITY_CHALLENGE_INVALID');
      const payload = {
        schema: 'ronin.launcher.identity-report/v1', challengeId: c.challengeId, challenge: c.challenge,
        applicationId, memberId, pairingId: c.pairingId, pairingInstallId: c.pairingInstallId,
        certifiedInstallationId: verifiedInstallIdentity.installId, deviceSha256: verifiedInstallIdentity.deviceSha256,
        certDigest: digest(installCertificate), certRevoked, identityPresent, state, dropReason,
        provider, signingKeyFingerprint: digest(providerPublicJwk), providerAttestationDigest: digest(providerAttestation),
        armorKeyTypes: [...armorKeyTypes], issuedAt, expiresAt: Math.min(c.expiresAt, issuedAt + 240),
      };
      const signature = await signReport(payload);
      if (!signature?.keyId || !signature?.value) throw new Error('LAUNCHER_REPORT_SIGNATURE_REQUIRED');
      const result = await post('/api/launcher/device-identity/report', { providerRegistrationId, installCertificate, signedReport: { payload, signature } });
      const receipt = result.value;
      if (result.response.status !== 201 || receipt?.ok !== true || receipt.state !== state
        || receipt.certifiedInstallationId !== payload.certifiedInstallationId || receipt.deviceSha256 !== payload.deviceSha256
        || receipt.verifiedAt !== payload.issuedAt || !receipt.eventId) throw new Error('CRM_IDENTITY_REPORT_REJECTED');
      return { receipt, payload };
    },
  };
}

export const launcherIdentityCanonicalJson = canonical;
