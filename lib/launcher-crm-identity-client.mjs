import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { CERT_KEY_PEM, verifyEntitlementEnvelope } from './addons.mjs';
import { verifyInstallCertificate } from './install-docking.mjs';
import { createArmorRevocationChecker, createKingmakerArmorProofVerifier } from './install-docking-runtime.mjs';
import { RELEASE_PUBLIC_KEY_PEM } from './release-pubkey.mjs';
import { pubkeyFingerprint, verifyManifestBytes } from './release-signing.mjs';
import { loadIdentity } from '../scripture-armor/armor.mjs';

const canonical = (value) => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const hexDigest = (value) => createHash('sha256').update(value).digest('hex');
const digest = (value) => createHash('sha256').update(canonical(value)).digest('base64url');
const SHA256 = /^[0-9a-f]{64}$/;
const paidArmorKeyTypes = Object.freeze(['X25519', 'Ed25519', 'ML-KEM-768', 'ML-DSA-65']);
const samePaidTypes = (value) => Array.isArray(value) && value.length === paidArmorKeyTypes.length && paidArmorKeyTypes.every((key) => value.includes(key));
const verifiedReports = new WeakSet();
const fixtureReports = new WeakSet();
const trustedStatusProviders = new WeakSet();

/** Existing update-host `/cert-status` adapter. Transport is untrusted; only a
 * fresh, complete ES256 response under the already-pinned install-cert key is
 * accepted. The bearer stays in the Launcher and is never reported to CRM. */
const makeInstallCertificateStatusProvider = ({ baseUrl, bearer, fetchImpl = globalThis.fetch,
  now = () => Math.floor(Date.now() / 1000), nonceFactory = () => randomBytes(24).toString('base64url') } = {}, certKeyPem) => {
  let origin; try { origin = new URL(baseUrl); } catch { throw new Error('INSTALL_STATUS_CONFIG_INVALID'); }
  if (origin.protocol !== 'https:' || !bearer || typeof fetchImpl !== 'function') throw new Error('INSTALL_STATUS_CONFIG_INVALID');
  const consumedNonces = new Set();
  const provider = async ({ installCertificate, installId, deviceSha256, keySha, releaseTag }) => {
    if (hexDigest(String(bearer)) !== keySha) throw new Error('INSTALL_STATUS_BEARER_KEY_MISMATCH');
    const nonce = String(nonceFactory());
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(nonce)) throw new Error('INSTALL_STATUS_NONCE_INVALID');
    if (consumedNonces.has(nonce)) throw new Error('INSTALL_STATUS_NONCE_REPLAY');
    const certDigest = digest(installCertificate), url = new URL('/cert-status', origin);
    for (const [key, value] of Object.entries({ nonce, install: installId, keySha, deviceSha256, releaseTag, certDigest })) url.searchParams.set(key, value);
    const response = await fetchImpl(url, { method: 'GET', headers: { authorization: `Bearer ${bearer}`, accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`INSTALL_STATUS_HTTP_${response.status}`);
    const text = await response.text(); if (Buffer.byteLength(text) > 64 * 1024) throw new Error('INSTALL_STATUS_RESPONSE_TOO_LARGE');
    let envelope; try { envelope = JSON.parse(text); } catch { throw new Error('INSTALL_STATUS_RESPONSE_INVALID'); }
    const claims = verifyEntitlementEnvelope(envelope, certKeyPem), at = now();
    if (!claims || claims.schema !== 'ronin.install-cert-status/1' || claims.issuer !== 'ronin-update-host'
      || claims.nonce !== nonce || claims.installId !== installId || claims.deviceSha256 !== deviceSha256
      || claims.keySha !== keySha || claims.releaseTag !== releaseTag || claims.certDigest !== certDigest
      || claims.bundleId !== 'com.ronininc.solghost' || claims.complete !== true
      || typeof claims.current !== 'boolean' || typeof claims.revoked !== 'boolean'
      || !Number.isInteger(claims.issuedAt) || !Number.isInteger(claims.expiresAt)
      || claims.issuedAt > at + 5 || claims.expiresAt <= at || claims.expiresAt - claims.issuedAt > 120) throw new Error('INSTALL_STATUS_RESPONSE_UNTRUSTED');
    consumedNonces.add(nonce);
    return { current: claims.current, revoked: claims.revoked, installId, keySha, releaseTag };
  };
  trustedStatusProviders.add(provider); return provider;
};

export function createInstallCertificateStatusProvider() {
  // The existing update-host source names the Worker but does not commit its
  // account-specific HTTPS origin, and the install certificate does not bind
  // an origin. Never send the per-install bearer to a caller-selected host.
  throw new Error('INSTALL_STATUS_ORIGIN_UNAVAILABLE');
}

/** Explicitly double-gated fixture seam. Production composition cannot pass a
 * certificate key and always uses the committed update-host pin above. */
export function createInstallCertificateStatusProviderForFixture(config = {}, certKeyPem) {
  if (process.env.NODE_ENV !== 'test' || process.env.KINGMAKER_DOUBLE_FIXTURE_GATE !== '1') throw new Error('FIXTURE_TRUST_DISABLED');
  return makeInstallCertificateStatusProvider(config, certKeyPem);
}

const verifyInputs = ({ installCertificate, deviceSha256, manifestBytes, manifestSignature, appBytes, now },
  { installCertPublicKeyPem, releasePublicKeyPem, brand }) => {
  const cert = verifyInstallCertificate(installCertificate, { deviceSha256, certKeyPem: installCertPublicKeyPem, now });
  if (!cert.ok) throw new Error('INSTALL_CERTIFICATE_NOT_VERIFIED');
  const bytes = Buffer.from(manifestBytes || []);
  if (!bytes.length || !verifyManifestBytes(bytes, manifestSignature, releasePublicKeyPem)) throw new Error('RELEASE_MANIFEST_NOT_VERIFIED');
  let manifest; try { manifest = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('RELEASE_MANIFEST_INVALID'); }
  const appSha256 = hexDigest(Buffer.from(appBytes || [])); const manifestDigest = hexDigest(bytes);
  const releaseSigningKeySha = pubkeyFingerprint(releasePublicKeyPem).replace(/\s+/g, '').toLowerCase();
  if (manifest?.schema !== 'kingmaker.release/1' || manifest?.product !== 'Kingmaker'
    || !SHA256.test(String(manifest?.app?.sha256 || '')) || manifest.app.sha256 !== appSha256
    || manifest.tag !== cert.claims.releaseTag) throw new Error('RELEASE_INSTALL_BINDING_INVALID');
  const result = Object.freeze({ installCertificate: structuredClone(installCertificate),
    installIdentity: Object.freeze({ installId: cert.installId, deviceSha256: cert.deviceSha256, keySha: cert.claims.keySha.toLowerCase(), releaseTag: cert.claims.releaseTag }),
    release: Object.freeze({ appSha256, manifestDigest, releaseSigningKeySha }) });
  brand.add(result); return result;
};

export function verifyLauncherReportInputs({ installCertificate, deviceSha256, installCertPublicKeyPem,
  manifestBytes, manifestSignature, releasePublicKeyPem, appBytes, now = Date.now } = {}) {
  if (installCertPublicKeyPem !== undefined || releasePublicKeyPem !== undefined) throw new Error('PRODUCTION_TRUST_ROOT_OVERRIDE_FORBIDDEN');
  return verifyInputs({ installCertificate, deviceSha256, manifestBytes, manifestSignature, appBytes, now },
    { installCertPublicKeyPem: CERT_KEY_PEM, releasePublicKeyPem: RELEASE_PUBLIC_KEY_PEM, brand: verifiedReports });
}

/** Test-only trust seam. Its separately branded values are rejected by every
 * production client. Both gates must be explicit so production configuration
 * cannot accidentally turn fixture keys into trust roots. */
export function verifyLauncherReportInputsForFixture(input, { installCertPublicKeyPem, releasePublicKeyPem } = {}) {
  if (process.env.NODE_ENV !== 'test' || process.env.KINGMAKER_DOUBLE_FIXTURE_GATE !== '1') throw new Error('FIXTURE_TRUST_DISABLED');
  return verifyInputs(input, { installCertPublicKeyPem, releasePublicKeyPem, brand: fixtureReports });
}

export function createLauncherCrmIdentityClient({ baseUrl, bearerToken, applicationId, memberId, providerRegistrationId,
  provider, providerPublicJwk, signReport, fetchImpl = globalThis.fetch, expectedArmorIdentity = null,
  armorState = null, checkInstallCertificateStatus, checkArmorRevocation,
  fixtureMode = false, now = () => Math.floor(Date.now() / 1000) } = {}) {
  if (!baseUrl || !bearerToken || !applicationId || !memberId || !providerRegistrationId || !provider
    || !providerPublicJwk || typeof signReport !== 'function' || typeof fetchImpl !== 'function') throw new Error('LAUNCHER_CRM_CONFIG_REQUIRED');
  const fixtureConfigAllowed = fixtureMode && process.env.NODE_ENV === 'test' && process.env.KINGMAKER_DOUBLE_FIXTURE_GATE === '1';
  if (!fixtureConfigAllowed && !trustedStatusProviders.has(checkInstallCertificateStatus)) throw new Error('INSTALL_CERTIFICATE_STATUS_AUTHORITY_UNAVAILABLE');
  const post = async (path, body = {}) => { const response = await fetchImpl(new URL(path, baseUrl), { method: 'POST', headers: { authorization: `Bearer ${bearerToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }); let value = null; try { value = await response.json(); } catch {} return { response, value }; };
  if (typeof checkInstallCertificateStatus !== 'function') throw new Error('INSTALL_CERTIFICATE_STATUS_PROVIDER_REQUIRED');
  return { async report({ verified, kingmakerProof = null } = {}) {
    const fixtureAllowed = fixtureConfigAllowed;
    if (!verified || (!verifiedReports.has(verified) && !(fixtureAllowed && fixtureReports.has(verified)))) throw new Error('VERIFIED_LAUNCHER_REPORT_INPUT_REQUIRED');
    const { installCertificate, installIdentity, release } = verified;
    const certStatus = await checkInstallCertificateStatus({ installCertificate, installId: installIdentity.installId,
      deviceSha256: installIdentity.deviceSha256, keySha: installIdentity.keySha, releaseTag: installIdentity.releaseTag });
    if (!certStatus || certStatus.current !== true || certStatus.revoked !== false
      || certStatus.installId !== installIdentity.installId || certStatus.keySha !== installIdentity.keySha
      || certStatus.releaseTag !== installIdentity.releaseTag) throw new Error('INSTALL_CERTIFICATE_STATUS_INVALID');
    const challengeResult = await post('/api/launcher/device-identity/challenge'); const c = challengeResult.value; const issuedAt = now();
    if (challengeResult.response.status !== 201 || c?.schema !== 'ronin.launcher.identity-challenge/v1' || !c.challengeId || !c.challenge || !c.pairingId || !c.pairingInstallId || !Number.isInteger(c.expiresAt) || c.expiresAt <= issuedAt) throw new Error('CRM_IDENTITY_CHALLENGE_INVALID');
    let identityProfile = 'free'; let armorKeyTypes = []; let providerAttestationDigest = digest(verified);
    if (kingmakerProof !== null) {
      let enrolledArmor;
      if (fixtureAllowed && expectedArmorIdentity) enrolledArmor = expectedArmorIdentity;
      else if (armorState) { const identity = loadIdentity(join(armorState, 'armor', 'identity')); if (identity) enrolledArmor = { senderSignFp: identity.signFp, keyTypes: [...paidArmorKeyTypes] }; }
      if (!enrolledArmor?.senderSignFp || !samePaidTypes(enrolledArmor.keyTypes)) throw new Error('PAID_ARMOR_TRUST_NOT_CONFIGURED');
      const verifyArmor = createKingmakerArmorProofVerifier({ expectedArmorIdentity: enrolledArmor, expectedInstallIdentity: installIdentity });
      const armor = await verifyArmor({ challenge: c.challenge, issuedAt: issuedAt * 1000, proof: kingmakerProof });
      if (!armor.ok || !samePaidTypes(armor.keyTypes)) throw new Error('PAID_ARMOR_PROOF_INVALID');
      if (typeof checkArmorRevocation !== 'function') throw new Error('PAID_ARMOR_REVOCATION_PROVIDER_REQUIRED');
      if (await checkArmorRevocation({ senderSignFp: enrolledArmor.senderSignFp })) throw new Error('PAID_ARMOR_IDENTITY_REVOKED');
      identityProfile = 'paid-armor'; armorKeyTypes = [...armor.keyTypes]; providerAttestationDigest = digest(kingmakerProof);
    }
    const payload = { schema: 'ronin.launcher.identity-report/v2', challengeId: c.challengeId, challenge: c.challenge,
      applicationId, memberId, pairingId: c.pairingId, pairingInstallId: c.pairingInstallId,
      certifiedInstallationId: installIdentity.installId, deviceSha256: installIdentity.deviceSha256,
      certDigest: digest(installCertificate), certRevoked: false, identityPresent: true, state: 'valid', dropReason: null,
      provider, signingKeyFingerprint: digest(providerPublicJwk), providerAttestationDigest,
      identityProfile, releaseTag: installIdentity.releaseTag, updateKeySha: installIdentity.keySha,
      releaseSigningKeySha: release.releaseSigningKeySha,
      appSha256: release.appSha256, manifestDigest: release.manifestDigest, armorKeyTypes,
      issuedAt, expiresAt: Math.min(c.expiresAt, issuedAt + 240) };
    const signature = await signReport(payload); if (!signature?.keyId || !signature?.value) throw new Error('LAUNCHER_REPORT_SIGNATURE_REQUIRED');
    const result = await post('/api/launcher/device-identity/report', { providerRegistrationId, installCertificate, signedReport: { payload, signature } }); const receipt = result.value;
    if (result.response.status !== 201 || receipt?.ok !== true || receipt.state !== 'valid'
      || receipt.current !== true || receipt.currentState !== 'valid' || receipt.identityProfile !== payload.identityProfile
      || receipt.certifiedInstallationId !== payload.certifiedInstallationId || receipt.deviceSha256 !== payload.deviceSha256
      || receipt.releaseBinding?.releaseTag !== payload.releaseTag || receipt.releaseBinding?.updateKeySha !== payload.updateKeySha
      || receipt.releaseBinding?.releaseSigningKeySha !== payload.releaseSigningKeySha
      || receipt.signedProviderClaims?.appSha256 !== payload.appSha256
      || receipt.signedProviderClaims?.manifestDigest !== payload.manifestDigest
      || receipt.verifiedAt !== payload.issuedAt || !receipt.eventId) throw new Error('CRM_IDENTITY_REPORT_REJECTED');
    return { receipt, payload };
  } };
}

/** Production composition. Trust roots are not parameters: verification uses
 * the committed install/release pins above, and paid Armor is loaded from the
 * existing governed local state. This function creates no identity or trust. */
export function createProductionLauncherIdentityReporter({ installStatus, armorState, armorRevocation, ...clientConfig } = {}) {
  if ('expectedArmorIdentity' in clientConfig || 'fixtureMode' in clientConfig) throw new Error('PRODUCTION_TRUST_OVERRIDE_FORBIDDEN');
  const checkInstallCertificateStatus = createInstallCertificateStatusProvider(installStatus);
  const checkArmorRevocation = armorRevocation ? createArmorRevocationChecker(armorRevocation) : null;
  const client = createLauncherCrmIdentityClient({ ...clientConfig, armorState, checkInstallCertificateStatus, checkArmorRevocation,
    fixtureMode: false });
  return Object.freeze({
    verifyInstalledRelease: (input) => verifyLauncherReportInputs(input),
    report: (input) => client.report(input),
  });
}

export const launcherIdentityCanonicalJson = canonical;
