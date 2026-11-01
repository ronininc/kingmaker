import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { verifyEntitlementEnvelope, CERT_KEY_PEM } from './addons.mjs';

export const INSTALL_CERT_KEYCHAIN = Object.freeze({ service: 'com.ronininc.ronin-launcher', account: 'kingmaker-install-cert' });
const INSTALL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;
const DEVICE_RE = /^[0-9a-f]{16,64}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/i;
export const INSTALL_CERT_SCHEMA = 'ronin.install-cert/1';
export const INSTALL_CERT_ISSUER = 'ronin-update-host';
export const KINGMAKER_BUNDLE_ID = 'com.ronininc.solghost';

export function verifyInstallCertificate(envelope, { deviceSha256, certKeyPem = CERT_KEY_PEM, now = Date.now } = {}) {
  const claims = verifyEntitlementEnvelope(envelope, certKeyPem);
  if (!claims) return { ok: false, reason: 'bad_install_certificate_signature' };
  if (claims.schema !== INSTALL_CERT_SCHEMA || claims.issuer !== INSTALL_CERT_ISSUER || claims.bundleId !== KINGMAKER_BUNDLE_ID
    || !INSTALL_RE.test(String(claims.installId || '')) || !DEVICE_RE.test(String(claims.deviceSha256 || ''))
    || !SHA256_RE.test(String(claims.keySha || '')) || typeof claims.releaseTag !== 'string' || !claims.releaseTag
    || !Number.isFinite(Date.parse(claims.issuedAt)) || Date.parse(claims.issuedAt) > now() + 300_000) {
    return { ok: false, reason: 'bad_install_certificate_claims' };
  }
  if (!DEVICE_RE.test(String(deviceSha256 || '')) || claims.deviceSha256.toLowerCase() !== String(deviceSha256).toLowerCase()) return { ok: false, reason: 'install_certificate_wrong_device' };
  return { ok: true, installId: claims.installId, deviceSha256: claims.deviceSha256.toLowerCase(), claims };
}

/** Read and verify this installation's Launcher-delivered certificate. Never returns unverified claims. */
export function readInstallIdentity({
  run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
  deviceHash,
  certKeyPem = CERT_KEY_PEM,
  now = Date.now,
} = {}) {
  let raw;
  try { raw = String(run('/usr/bin/security', ['find-generic-password', '-s', INSTALL_CERT_KEYCHAIN.service, '-a', INSTALL_CERT_KEYCHAIN.account, '-w'])).trim(); }
  catch { return null; }
  if (raw && !raw.startsWith('{') && /^([0-9a-f]{2})+$/i.test(raw)) raw = Buffer.from(raw, 'hex').toString('utf8');
  let envelope; try { envelope = JSON.parse(raw); } catch { return null; }
  const result = verifyInstallCertificate(envelope, { deviceSha256: deviceHash(), certKeyPem, now });
  return result.ok ? {
    installId: result.installId,
    deviceSha256: result.deviceSha256,
    keySha: result.claims.keySha.toLowerCase(),
    releaseTag: result.claims.releaseTag,
  } : null;
}

/** Installer-compatible SHA-256 of a hardware identifier line. Injectable; no I/O here. */
export const hashDeviceIdentifier = (identifier) => createHash('sha256').update(`${identifier}\n`).digest('hex');

/** Launcher-side composition point: verify Kingmaker locally, then have the
 * Launcher report that verified identity to CRM. Kingmaker never contacts CRM.
 * The callbacks are adapters; this helper is not itself a network protocol.
 */
const sameTypes = (a, b) => Array.isArray(a) && a.length > 0 && Array.isArray(b)
  && a.length === b.length && [...a].sort().every((type, i) => type === [...b].sort()[i]);
export function createLauncherDockGate({ expectedInstallIdentity, expectedArmorIdentity, verifyKingmaker, reportToCrm, checkRevocation, consumeChallenge, now = Date.now, ttlMs = 120_000 }) {
  if ([verifyKingmaker, reportToCrm, checkRevocation, consumeChallenge].some((fn) => typeof fn !== 'function')) throw new Error('DOCK_ADAPTERS_REQUIRED');
  if (!expectedInstallIdentity?.installId || !DEVICE_RE.test(String(expectedInstallIdentity.deviceSha256 || ''))
    || !SHA256_RE.test(String(expectedInstallIdentity.keySha || '')) || !expectedInstallIdentity.releaseTag) throw new Error('VERIFIED_INSTALL_IDENTITY_REQUIRED');
  if (!expectedArmorIdentity?.senderSignFp || !Array.isArray(expectedArmorIdentity.keyTypes) || expectedArmorIdentity.keyTypes.length === 0) throw new Error('VERIFIED_ARMOR_IDENTITY_REQUIRED');
  return async ({ challenge, issuedAt, kingmakerProof }) => {
    const id = String(challenge || ''); const at = Number(issuedAt);
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(id)) return { ok: false, reason: 'malformed_challenge' };
    if (!Number.isFinite(at) || at > now() + 5_000 || now() - at > ttlMs) return { ok: false, reason: 'expired_challenge' };
    // `ok` must mean proof-of-possession was verified against the locally
    // enrolled Armor sender fingerprint; labels or hashes alone never suffice.
    const install = await verifyKingmaker({ challenge: id, issuedAt: at, proof: kingmakerProof });
    if (!install?.ok || install.issuer !== 'kingmaker' || !install.installId || !install.deviceSha256 || !install.keySha
      || install.installId !== expectedInstallIdentity.installId
      || install.deviceSha256.toLowerCase() !== expectedInstallIdentity.deviceSha256.toLowerCase()
      // keySha is the Launcher/update-host enrollment key hash. It is not
      // treated as an Armor signing fingerprint.
      || install.keySha.toLowerCase() !== expectedInstallIdentity.keySha.toLowerCase()
      || install.releaseTag !== expectedInstallIdentity.releaseTag
      || install.senderSignFp !== expectedArmorIdentity.senderSignFp
      || !sameTypes(install.keyTypes, expectedArmorIdentity.keyTypes)) return { ok: false, reason: 'kingmaker_mismatch' };
    if (await checkRevocation({ issuer: install.issuer, senderSignFp: install.senderSignFp, installId: install.installId })) return { ok: false, reason: 'docking_identity_revoked' };
    // Must be a durable atomic insert/claim. In-memory Sets are not sufficient.
    if (!(await consumeChallenge({ challenge: id, issuedAt: at, installId: install.installId }))) return { ok: false, reason: 'replayed_challenge' };
    const receipt = await reportToCrm({ challenge: id, issuedAt: at, install });
    // CRM's existing endpoint returns an authenticated-session JSON receipt,
    // not a separately signed CRM document. The Launcher transport validates
    // HTTP status and these exact echoes before returning it here.
    if (!receipt?.ok || receipt.state !== 'valid' || receipt.certifiedInstallationId !== install.installId
      || receipt.deviceSha256 !== install.deviceSha256 || !receipt.eventId) return { ok: false, reason: 'crm_report_rejected' };
    return { ok: true, installId: install.installId, deviceSha256: install.deviceSha256, armor: { kingmakerSignFp: install.senderSignFp, keyTypes: [...install.keyTypes] } };
  };
}
