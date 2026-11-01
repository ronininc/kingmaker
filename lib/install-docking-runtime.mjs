import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fingerprintOfRaw, loadIdentity, revocationFor, signPayload, verifyPayload, verifyRevocation } from '../scripture-armor/armor.mjs';

const SHA256 = /^[0-9a-f]{64}$/;
const b64url = (value) => Buffer.from(String(value), 'base64url');
const ARMOR_KEY_TYPES = Object.freeze(['X25519', 'Ed25519', 'ML-KEM-768', 'ML-DSA-65']);

/** Produce the local half of the Launcher docking protocol.
 *
 * This deliberately does not create an identity or supply a trust root. The
 * install must already have its Armor identity and the caller must provide a
 * configured, fail-closed revocation check. That keeps fixture identities in
 * tests from becoming a production fallback.
 */
export async function createKingmakerInstallProof({
  state,
  challenge,
  issuedAt,
  installIdentity,
  checkRevocation,
  now = Date.now,
  maxClockSkewMs = 30_000,
}) {
  if (!state) throw new Error('ARMOR_STATE_REQUIRED');
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(String(challenge || ''))) throw new Error('DOCK_CHALLENGE_INVALID');
  if (!Number.isFinite(issuedAt) || Math.abs(now() - issuedAt) > maxClockSkewMs) throw new Error('DOCK_CHALLENGE_STALE');
  if (!installIdentity?.installId || !SHA256.test(String(installIdentity.deviceSha256 || ''))
    || !SHA256.test(String(installIdentity.keySha || '')) || !installIdentity.releaseTag) {
    throw new Error('VERIFIED_INSTALL_IDENTITY_REQUIRED');
  }
  if (typeof checkRevocation !== 'function') throw new Error('TRUSTED_REVOCATION_PROVIDER_REQUIRED');

  const identity = loadIdentity(join(state, 'armor', 'identity'));
  if (!identity) throw new Error('KINGMAKER_ARMOR_IDENTITY_REQUIRED');
  if (await checkRevocation({ senderSignFp: identity.signFp })) throw new Error('KINGMAKER_ARMOR_IDENTITY_REVOKED');

  const proof = signPayload(identity, {
    type: 'kingmaker.install-proof/1',
    nonce: challenge,
    at: new Date(issuedAt).toISOString(),
    body: {
      schema: 'kingmaker.install-proof/1',
      challenge,
      issuedAt,
      installId: installIdentity.installId,
      deviceSha256: installIdentity.deviceSha256,
      keySha: installIdentity.keySha,
      releaseTag: installIdentity.releaseTag,
    },
  });
  return {
    proof,
    armorIdentity: { senderSignFp: identity.signFp, keyTypes: [...ARMOR_KEY_TYPES] },
    installIdentity: { ...installIdentity },
  };
}

/** Verify the existing Scripture Armor canonical Ed25519 mesh envelope and
 * bind its embedded key, fingerprint, challenge, and install claims.
 */
export function createKingmakerArmorProofVerifier({ expectedArmorIdentity, expectedInstallIdentity }) {
  if (!expectedArmorIdentity?.senderSignFp || !Array.isArray(expectedArmorIdentity.keyTypes)) throw new Error('VERIFIED_ARMOR_IDENTITY_REQUIRED');
  return async ({ challenge, issuedAt, proof }) => {
    try {
      if (!verifyPayload(proof) || proof.type !== 'kingmaker.install-proof/1' || proof.nonce !== challenge) return { ok: false };
      const embeddedFp = fingerprintOfRaw(b64url(proof.from_sign_pub));
      if (embeddedFp !== proof.from_sign_fp || embeddedFp !== expectedArmorIdentity.senderSignFp) return { ok: false };
      if (Date.parse(proof.at) !== issuedAt) return { ok: false };
      const body = proof.body;
      if (!body || body.schema !== 'kingmaker.install-proof/1' || body.challenge !== challenge || body.issuedAt !== issuedAt
        || body.installId !== expectedInstallIdentity.installId || body.deviceSha256 !== expectedInstallIdentity.deviceSha256
        || body.keySha !== expectedInstallIdentity.keySha || body.releaseTag !== expectedInstallIdentity.releaseTag) return { ok: false };
      return { ok: true, issuer: 'kingmaker', ...expectedInstallIdentity, ...expectedArmorIdentity };
    } catch { return { ok: false }; }
  };
}

/** Restart-safe atomic replay consumption. The directory and SQLite sidecars
 * are owner-only; unsafe pre-existing paths are refused.
 */
export function createDockChallengeStore({ path, now = Date.now } = {}) {
  if (!path) throw new Error('CHALLENGE_DB_PATH_REQUIRED');
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const privatePath = (target, kind) => {
    const st = lstatSync(target);
    if (st.isSymbolicLink() || (kind === 'directory' ? !st.isDirectory() : !st.isFile())) throw new Error('UNSAFE_CHALLENGE_PATH');
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error('CHALLENGE_PATH_NOT_OWNED');
    if ((st.mode & 0o077) !== 0) throw new Error('CHALLENGE_PATH_NOT_PRIVATE');
  };
  privatePath(dir, 'directory');
  if (existsSync(path)) privatePath(path, 'file');
  const old = process.umask(0o077); let db;
  try {
    db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS consumed_challenges (challenge TEXT PRIMARY KEY, install_id TEXT NOT NULL, issued_at INTEGER NOT NULL, consumed_at INTEGER NOT NULL)');
  } finally { process.umask(old); }
  const secure = () => { for (const file of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(file)) { chmodSync(file, 0o600); privatePath(file, 'file'); } };
  secure();
  return {
    consumeChallenge: async ({ challenge, issuedAt, installId }) => {
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(String(challenge)) || !installId || !Number.isFinite(issuedAt)) return false;
      const result = db.prepare('INSERT OR IGNORE INTO consumed_challenges(challenge,install_id,issued_at,consumed_at) VALUES(?,?,?,?)').run(challenge, installId, issuedAt, now());
      secure(); return Number(result.changes) === 1;
    },
    close: () => { secure(); db.close(); secure(); },
  };
}

/** Adapter for Scripture Armor's signed revocation registry. Configuration is
 * mandatory; an unavailable registry or unknown authority throws (fail closed).
 */
export function createArmorRevocationChecker({ trustedIssuerSignFp, fetchSnapshot, resolveSignPub, now = Date.now, maxAgeMs = 300_000 }) {
  if (!SHA256.test(String(trustedIssuerSignFp || '')) || typeof fetchSnapshot !== 'function' || typeof resolveSignPub !== 'function') throw new Error('TRUSTED_REVOCATION_PROVIDER_REQUIRED');
  return async ({ senderSignFp }) => {
    if (!SHA256.test(String(senderSignFp || ''))) throw new Error('REVOCATION_IDENTITY_INVALID');
    const snapshot = await fetchSnapshot(senderSignFp);
    if (!snapshot || !verifyPayload(snapshot) || snapshot.type !== 'armor.revocation-query-response/1') throw new Error('REVOCATION_SNAPSHOT_UNAUTHENTICATED');
    let embeddedFp;
    try { embeddedFp = fingerprintOfRaw(b64url(snapshot.from_sign_pub)); } catch { throw new Error('REVOCATION_SNAPSHOT_UNAUTHENTICATED'); }
    if (embeddedFp !== snapshot.from_sign_fp || embeddedFp !== trustedIssuerSignFp) throw new Error('REVOCATION_SNAPSHOT_UNTRUSTED_ISSUER');
    const body = snapshot.body;
    const generatedAt = Date.parse(body?.generatedAt); const validUntil = Date.parse(body?.validUntil);
    if (body?.schema !== 'armor.revocation-query-response/1' || body?.querySignFp !== senderSignFp || body?.complete !== true
      || !Array.isArray(body?.records)) throw new Error('REVOCATION_SNAPSHOT_INCOMPLETE');
    if (!Number.isFinite(generatedAt) || !Number.isFinite(validUntil) || generatedAt > now() + 5_000
      || now() - generatedAt > maxAgeMs || validUntil <= now() || validUntil - generatedAt > maxAgeMs) throw new Error('REVOCATION_SNAPSHOT_STALE');
    const records = { v: 1, records: body.records };
    const matching = records.records.filter((record) => record?.sign_fp === senderSignFp);
    if (matching.some((record) => !verifyRevocation(record, resolveSignPub))) throw new Error('REVOCATION_RECORD_UNVERIFIABLE');
    return Boolean(revocationFor(records, senderSignFp, resolveSignPub));
  };
}
