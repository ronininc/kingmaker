import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { verifyEntitlementEnvelope, CERT_KEY_PEM } from './addons.mjs';

export const INSTALL_CERT_KEYCHAIN = Object.freeze({ service: 'com.ronininc.ronin-launcher', account: 'kingmaker-install-cert' });
const INSTALL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;
const DEVICE_RE = /^[0-9a-f]{16,64}$/i;

export function verifyInstallCertificate(envelope, { deviceSha256, certKeyPem = CERT_KEY_PEM, now = Date.now } = {}) {
  const claims = verifyEntitlementEnvelope(envelope, certKeyPem);
  if (!claims) return { ok: false, reason: 'bad_install_certificate_signature' };
  if (!INSTALL_RE.test(String(claims.installId || '')) || !DEVICE_RE.test(String(claims.deviceSha256 || ''))) return { ok: false, reason: 'bad_install_certificate_claims' };
  if (!DEVICE_RE.test(String(deviceSha256 || '')) || claims.deviceSha256.toLowerCase() !== String(deviceSha256).toLowerCase()) return { ok: false, reason: 'install_certificate_wrong_device' };
  if (claims.expiresAt && (!Number.isFinite(Date.parse(claims.expiresAt)) || Date.parse(claims.expiresAt) <= now())) return { ok: false, reason: 'install_certificate_expired' };
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
  return result.ok ? { installId: result.installId, deviceSha256: result.deviceSha256 } : null;
}

/** Installer-compatible SHA-256 of a hardware identifier line. Injectable; no I/O here. */
export const hashDeviceIdentifier = (identifier) => createHash('sha256').update(`${identifier}\n`).digest('hex');

/**
 * Both independent docks must attest the same installation and device for one
 * fresh challenge. Verifier callbacks own the Launcher and CRM protocols; this
 * gate composes them without weakening either one.
 */
const ARMOR_KEY_TYPES = Object.freeze(['X25519', 'Ed25519', 'ML-KEM-768', 'ML-DSA-65']);
const armorTypesOk = (proof) => ARMOR_KEY_TYPES.every((type) => proof?.keyTypes?.includes(type));
export function createDualDockGate({ verifyLauncher, verifyCrm, isRevoked = async () => false, now = Date.now, ttlMs = 120_000, seen = new Set() }) {
  if (typeof verifyLauncher !== 'function' || typeof verifyCrm !== 'function') throw new Error('DOCK_VERIFIERS_REQUIRED');
  return async ({ challenge, issuedAt, launcherProof, crmProof }) => {
    const id = String(challenge || ''); const at = Number(issuedAt);
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(id)) return { ok: false, reason: 'malformed_challenge' };
    if (!Number.isFinite(at) || at > now() + 5_000 || now() - at > ttlMs) return { ok: false, reason: 'expired_challenge' };
    if (seen.has(id)) return { ok: false, reason: 'replayed_challenge' };
    const [launcher, crm] = await Promise.all([verifyLauncher({ challenge: id, issuedAt: at, proof: launcherProof }), verifyCrm({ challenge: id, issuedAt: at, proof: crmProof })]);
    // `ok` must mean the adapter verified an Armor proof of possession against
    // the locally enrolled sender fingerprint. Key-type equality alone is
    // descriptive metadata and is never accepted as identity proof.
    if (!launcher?.ok || launcher.issuer !== 'ronin-launcher' || !launcher.senderSignFp) return { ok: false, reason: 'launcher_mismatch' };
    if (!crm?.ok || crm.issuer !== 'ronin-crm' || !crm.senderSignFp) return { ok: false, reason: 'crm_mismatch' };
    if (!armorTypesOk(launcher) || !armorTypesOk(crm)) return { ok: false, reason: 'armor_key_type_mismatch' };
    if (await isRevoked({ issuer: launcher.issuer, senderSignFp: launcher.senderSignFp }) || await isRevoked({ issuer: crm.issuer, senderSignFp: crm.senderSignFp })) return { ok: false, reason: 'docking_identity_revoked' };
    if (launcher.installId !== crm.installId || launcher.deviceSha256 !== crm.deviceSha256) return { ok: false, reason: 'dock_identity_mismatch' };
    seen.add(id);
    return { ok: true, installId: launcher.installId, deviceSha256: launcher.deviceSha256, armor: { launcherSignFp: launcher.senderSignFp, crmSignFp: crm.senderSignFp, keyTypes: ARMOR_KEY_TYPES } };
  };
}
