import assert from 'node:assert/strict';
import { createHash, createSign, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createLauncherCrmIdentityClient, createProductionLauncherIdentityReporter, launcherIdentityCanonicalJson, verifyLauncherReportInputs, verifyLauncherReportInputsForFixture } from '../lib/launcher-crm-identity-client.mjs';
import { pubkeyFingerprint, signManifestBytes } from '../lib/release-signing.mjs';
import { createIdentity, signPayload } from '../scripture-armor/armor.mjs';

const reportKeys = generateKeyPairSync('ed25519');
const certKeys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const releaseKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.NODE_ENV = 'test'; process.env.KINGMAKER_DOUBLE_FIXTURE_GATE = '1';
const releasePublicPem = releaseKeys.publicKey.export({ format: 'pem', type: 'spki' });
const install = { installId: '11111111-1111-4111-8111-111111111111', deviceSha256: 'a'.repeat(64), keySha: pubkeyFingerprint(releasePublicPem).replace(/\s+/g, '').toLowerCase(), releaseTag: 'v4.4.2' };
const appBytes = Buffer.from('exact-app-archive-bytes');
const appSha256 = createHash('sha256').update(appBytes).digest('hex');
const claims = { schema: 'ronin.install-cert/1', issuer: 'ronin-update-host', bundleId: 'com.ronininc.solghost', issuedAt: '2026-11-02T00:00:00Z', ...install };
const certBytes = Buffer.from(JSON.stringify(claims));
const cert = { payload: certBytes.toString(), sig: createSign('sha256').update(certBytes).sign({ key: certKeys.privateKey, dsaEncoding: 'der' }).toString('base64'), alg: 'ES256' };
const manifest = { schema: 'kingmaker.release/1', product: 'Kingmaker', tag: install.releaseTag, app: { sha256: appSha256 } };
const manifestBytes = Buffer.from(JSON.stringify(manifest));
const releasePrivate = releaseKeys.privateKey.export({ format: 'pem', type: 'pkcs8' });
const trust = { installCertPublicKeyPem: certKeys.publicKey.export({ format: 'pem', type: 'spki' }), releasePublicKeyPem: releasePublicPem };
const raw = { installCertificate: cert, deviceSha256: install.deviceSha256, manifestBytes, manifestSignature: signManifestBytes(manifestBytes, releasePrivate), appBytes, now: () => Date.parse('2026-11-02T00:01:00Z') };
const verified = () => verifyLauncherReportInputsForFixture(raw, trust);
const keyTypes = ['X25519', 'Ed25519', 'ML-KEM-768', 'ML-DSA-65'];

function fixture(expectedArmorIdentity = null, overrides = {}) {
  let payload; const calls = [];
  const client = createLauncherCrmIdentityClient({ baseUrl: 'https://crm.invalid', bearerToken: 'fixture-token', applicationId: 'app', memberId: 'member', providerRegistrationId: 'reg', provider: 'launcher', providerPublicJwk: reportKeys.publicKey.export({ format: 'jwk' }), expectedArmorIdentity, fixtureMode: true, now: () => 1000,
    checkInstallCertificateStatus: async () => ({ current: true, revoked: false, installId: install.installId, keySha: install.keySha, releaseTag: install.releaseTag }),
    checkArmorRevocation: async () => false, ...overrides,
    signReport: async (p) => ({ keyId: 'report-key', value: sign(null, Buffer.from(launcherIdentityCanonicalJson(p)), reportKeys.privateKey).toString('base64url') }),
    fetchImpl: async (url, init) => { calls.push({ url: String(url), body: JSON.parse(init.body) });
      if (String(url).endsWith('/challenge')) return new Response(JSON.stringify({ schema: 'ronin.launcher.identity-challenge/v1', challengeId: 'cid', challenge: 'challenge-value-1234', expiresAt: 1240, pairingId: 'pid', pairingInstallId: 'legacy' }), { status: 201 });
      payload = JSON.parse(init.body).signedReport.payload;
      return new Response(JSON.stringify({ ok: true, eventId: 'eid', state: payload.state, certifiedInstallationId: payload.certifiedInstallationId, deviceSha256: payload.deviceSha256, verifiedAt: payload.issuedAt }), { status: 201 }); } });
  return { client, calls, payload: () => payload };
}

test('free report derives certificate and release fields from verified bytes', async () => {
  const f = fixture(); const p = (await f.client.report({ verified: verified() })).payload;
  assert.equal(p.identityProfile, 'free'); assert.deepEqual(p.armorKeyTypes, []);
  assert.equal(p.certifiedInstallationId, install.installId); assert.equal(p.releaseTag, install.releaseTag);
  assert.equal(p.releaseKeySha, install.keySha); assert.equal(p.appSha256, appSha256); assert.equal(p.manifestDigest.length, 64);
  assert.equal('hostname' in p || 'serial' in p || 'inventory' in p, false);
});

test('forged labels, certificates, digests, tags and app bytes cannot create verified input', async () => {
  const f = fixture();
  await assert.rejects(() => f.client.report({ verified: { ...verified() }, identityProfile: 'paid-armor', providerAttestation: { armor: 'verified' } }), /INPUT_REQUIRED/);
  assert.throws(() => verifyLauncherReportInputsForFixture({ ...raw, installCertificate: { ...cert, sig: 'forged' } }, trust), /CERTIFICATE_NOT_VERIFIED/);
  assert.throws(() => verifyLauncherReportInputsForFixture({ ...raw, appBytes: Buffer.from('tampered') }, trust), /RELEASE_INSTALL_BINDING/);
  const wrong = Buffer.from(JSON.stringify({ ...manifest, tag: 'v9.9.9' }));
  assert.throws(() => verifyLauncherReportInputsForFixture({ ...raw, manifestBytes: wrong, manifestSignature: signManifestBytes(wrong, releasePrivate) }, trust), /RELEASE_INSTALL_BINDING/);
  assert.throws(() => verifyLauncherReportInputsForFixture({ ...raw, manifestSignature: 'forged' }, trust), /MANIFEST_NOT_VERIFIED/);
  assert.throws(() => verifyLauncherReportInputs({ ...raw, installCertPublicKeyPem: trust.installCertPublicKeyPem }), /TRUST_ROOT_OVERRIDE_FORBIDDEN/);
  const substituted = generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.throws(() => verifyLauncherReportInputsForFixture(raw, { ...trust, releasePublicKeyPem: substituted.publicKey.export({ format: 'pem', type: 'spki' }) }), /RELEASE_KEY_MISMATCH|MANIFEST_NOT_VERIFIED/);
});

test('paid profile requires a genuine challenge-bound Armor proof', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'launcher-crm-armor-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const armor = createIdentity(join(dir, 'identity'), 'fixture'); const expected = { senderSignFp: armor.signFp, keyTypes };
  const proof = signPayload(armor, { type: 'kingmaker.install-proof/1', nonce: 'challenge-value-1234', at: new Date(1000000).toISOString(), body: { schema: 'kingmaker.install-proof/1', challenge: 'challenge-value-1234', issuedAt: 1000000, ...install } });
  const f = fixture(expected); const p = (await f.client.report({ verified: verified(), kingmakerProof: proof })).payload;
  assert.equal(p.identityProfile, 'paid-armor'); assert.deepEqual(p.armorKeyTypes, keyTypes);
  const forged = structuredClone(proof); forged.body.releaseTag = 'v9.9.9';
  await assert.rejects(() => fixture(expected).client.report({ verified: verified(), kingmakerProof: forged }), /PAID_ARMOR_PROOF_INVALID/);
  await assert.rejects(() => fixture().client.report({ verified: verified(), kingmakerProof: proof }), /PAID_ARMOR_TRUST_NOT_CONFIGURED/);
});

test('certificate and paid Armor revocation are derived from current providers', async () => {
  await assert.rejects(() => fixture(null, { checkInstallCertificateStatus: async () => ({ current: true, revoked: true, installId: install.installId, keySha: install.keySha, releaseTag: install.releaseTag }) }).client.report({ verified: verified() }), /CERTIFICATE_STATUS_INVALID/);
  await assert.rejects(() => fixture(null, { checkInstallCertificateStatus: async () => null }).client.report({ verified: verified() }), /CERTIFICATE_STATUS_INVALID/);
  const dir = mkdtempSync(join(tmpdir(), 'launcher-crm-revoked-')); const armor = createIdentity(join(dir, 'identity'), 'fixture');
  const expected = { senderSignFp: armor.signFp, keyTypes };
  const proof = signPayload(armor, { type: 'kingmaker.install-proof/1', nonce: 'challenge-value-1234', at: new Date(1000000).toISOString(), body: { schema: 'kingmaker.install-proof/1', challenge: 'challenge-value-1234', issuedAt: 1000000, ...install } });
  await assert.rejects(() => fixture(expected, { checkArmorRevocation: async () => true }).client.report({ verified: verified(), kingmakerProof: proof }), /ARMOR_IDENTITY_REVOKED/);
  rmSync(dir, { recursive: true, force: true });
});

test('fixture trust and caller-selected Armor pins cannot enter production composition', async () => {
  assert.throws(() => createLauncherCrmIdentityClient({ baseUrl: 'https://crm.invalid', bearerToken: 'fixture-token', applicationId: 'app', memberId: 'member', providerRegistrationId: 'reg', provider: 'launcher', providerPublicJwk: reportKeys.publicKey.export({ format: 'jwk' }), expectedArmorIdentity: { senderSignFp: 'attacker', keyTypes }, checkInstallCertificateStatus: async () => ({ current: true }), signReport: async () => ({ keyId: 'k', value: 'v' }), fetchImpl: async () => { throw new Error('SHOULD_NOT_FETCH'); } }), /STATUS_AUTHORITY_UNAVAILABLE/);
  assert.throws(() => createProductionLauncherIdentityReporter({ fixtureMode: true }), /TRUST_OVERRIDE_FORBIDDEN/);
  assert.throws(() => createProductionLauncherIdentityReporter({ expectedArmorIdentity: { senderSignFp: 'attacker' } }), /TRUST_OVERRIDE_FORBIDDEN/);
  assert.throws(() => createProductionLauncherIdentityReporter({ installCertificateStatusProvider: async () => ({ current: true, revoked: false }) }), /STATUS_CALLBACK_FORBIDDEN/);
  await assert.rejects(() => createProductionLauncherIdentityReporter({}).report({ verified: {} }), /STATUS_AUTHORITY_UNAVAILABLE/);
});
