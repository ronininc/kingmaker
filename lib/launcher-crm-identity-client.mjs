import { createHash } from 'node:crypto';
import { verifyInstallCertificate } from './install-docking.mjs';
import { createKingmakerArmorProofVerifier } from './install-docking-runtime.mjs';
import { verifyManifestBytes } from './release-signing.mjs';

const canonical = (value) => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const hexDigest = (value) => createHash('sha256').update(value).digest('hex');
const digest = (value) => createHash('sha256').update(canonical(value)).digest('base64url');
const SHA256 = /^[0-9a-f]{64}$/;
const paidArmorKeyTypes = Object.freeze(['X25519', 'Ed25519', 'ML-KEM-768', 'ML-DSA-65']);
const samePaidTypes = (value) => Array.isArray(value) && value.length === paidArmorKeyTypes.length && paidArmorKeyTypes.every((key) => value.includes(key));
const verifiedReports = new WeakSet();

export function verifyLauncherReportInputs({ installCertificate, deviceSha256, installCertPublicKeyPem,
  manifestBytes, manifestSignature, releasePublicKeyPem, appBytes, now = Date.now } = {}) {
  const cert = verifyInstallCertificate(installCertificate, { deviceSha256, certKeyPem: installCertPublicKeyPem, now });
  if (!cert.ok) throw new Error('INSTALL_CERTIFICATE_NOT_VERIFIED');
  const bytes = Buffer.from(manifestBytes || []);
  if (!bytes.length || !verifyManifestBytes(bytes, manifestSignature, releasePublicKeyPem)) throw new Error('RELEASE_MANIFEST_NOT_VERIFIED');
  let manifest; try { manifest = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('RELEASE_MANIFEST_INVALID'); }
  const appSha256 = hexDigest(Buffer.from(appBytes || [])); const manifestDigest = hexDigest(bytes);
  if (manifest?.schema !== 'kingmaker.release/1' || manifest?.product !== 'Kingmaker'
    || !SHA256.test(String(manifest?.app?.sha256 || '')) || manifest.app.sha256 !== appSha256
    || manifest.tag !== cert.claims.releaseTag || !SHA256.test(String(cert.claims.keySha || ''))) throw new Error('RELEASE_INSTALL_BINDING_INVALID');
  const result = Object.freeze({ installCertificate: structuredClone(installCertificate),
    installIdentity: Object.freeze({ installId: cert.installId, deviceSha256: cert.deviceSha256, keySha: cert.claims.keySha.toLowerCase(), releaseTag: cert.claims.releaseTag }),
    release: Object.freeze({ appSha256, manifestDigest }) });
  verifiedReports.add(result); return result;
}

export function createLauncherCrmIdentityClient({ baseUrl, bearerToken, applicationId, memberId, providerRegistrationId,
  provider, providerPublicJwk, signReport, fetchImpl = globalThis.fetch, expectedArmorIdentity = null,
  now = () => Math.floor(Date.now() / 1000) } = {}) {
  if (!baseUrl || !bearerToken || !applicationId || !memberId || !providerRegistrationId || !provider
    || !providerPublicJwk || typeof signReport !== 'function' || typeof fetchImpl !== 'function') throw new Error('LAUNCHER_CRM_CONFIG_REQUIRED');
  const post = async (path, body = {}) => { const response = await fetchImpl(new URL(path, baseUrl), { method: 'POST', headers: { authorization: `Bearer ${bearerToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }); let value = null; try { value = await response.json(); } catch {} return { response, value }; };
  return { async report({ verified, kingmakerProof = null, state = 'valid', certRevoked = false, identityPresent = true, dropReason = null } = {}) {
    if (!verified || !verifiedReports.has(verified)) throw new Error('VERIFIED_LAUNCHER_REPORT_INPUT_REQUIRED');
    const { installCertificate, installIdentity, release } = verified;
    if (state === 'valid' && (!identityPresent || certRevoked !== false || dropReason !== null)) throw new Error('INVALID_VALID_IDENTITY_STATE');
    if (state === 'dropped' && ((identityPresent && certRevoked !== true) || !String(dropReason || '').trim())) throw new Error('INVALID_DROPPED_IDENTITY_STATE');
    const challengeResult = await post('/api/launcher/device-identity/challenge'); const c = challengeResult.value; const issuedAt = now();
    if (challengeResult.response.status !== 201 || c?.schema !== 'ronin.launcher.identity-challenge/v1' || !c.challengeId || !c.challenge || !c.pairingId || !c.pairingInstallId || !Number.isInteger(c.expiresAt) || c.expiresAt <= issuedAt) throw new Error('CRM_IDENTITY_CHALLENGE_INVALID');
    let identityProfile = 'free'; let armorKeyTypes = []; let providerAttestationDigest = digest(verified);
    if (kingmakerProof !== null) {
      if (!expectedArmorIdentity?.senderSignFp || !samePaidTypes(expectedArmorIdentity.keyTypes)) throw new Error('PAID_ARMOR_TRUST_NOT_CONFIGURED');
      const verifyArmor = createKingmakerArmorProofVerifier({ expectedArmorIdentity, expectedInstallIdentity: installIdentity });
      const armor = await verifyArmor({ challenge: c.challenge, issuedAt: issuedAt * 1000, proof: kingmakerProof });
      if (!armor.ok || !samePaidTypes(armor.keyTypes)) throw new Error('PAID_ARMOR_PROOF_INVALID');
      identityProfile = 'paid-armor'; armorKeyTypes = [...armor.keyTypes]; providerAttestationDigest = digest(kingmakerProof);
    }
    const payload = { schema: 'ronin.launcher.identity-report/v1', challengeId: c.challengeId, challenge: c.challenge,
      applicationId, memberId, pairingId: c.pairingId, pairingInstallId: c.pairingInstallId,
      certifiedInstallationId: installIdentity.installId, deviceSha256: installIdentity.deviceSha256,
      certDigest: digest(installCertificate), certRevoked, identityPresent, state, dropReason,
      provider, signingKeyFingerprint: digest(providerPublicJwk), providerAttestationDigest,
      identityProfile, releaseTag: installIdentity.releaseTag, releaseKeySha: installIdentity.keySha,
      appSha256: release.appSha256, manifestDigest: release.manifestDigest, armorKeyTypes,
      issuedAt, expiresAt: Math.min(c.expiresAt, issuedAt + 240) };
    const signature = await signReport(payload); if (!signature?.keyId || !signature?.value) throw new Error('LAUNCHER_REPORT_SIGNATURE_REQUIRED');
    const result = await post('/api/launcher/device-identity/report', { providerRegistrationId, installCertificate, signedReport: { payload, signature } }); const receipt = result.value;
    if (result.response.status !== 201 || receipt?.ok !== true || receipt.state !== state || receipt.certifiedInstallationId !== payload.certifiedInstallationId || receipt.deviceSha256 !== payload.deviceSha256 || receipt.verifiedAt !== payload.issuedAt || !receipt.eventId) throw new Error('CRM_IDENTITY_REPORT_REJECTED');
    return { receipt, payload };
  } };
}

export const launcherIdentityCanonicalJson = canonical;
