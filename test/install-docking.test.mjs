import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';
import test from 'node:test';
import { createLauncherDockGate, hashDeviceIdentifier, readInstallIdentity, verifyInstallCertificate } from '../lib/install-docking.mjs';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
const envelope = (claims) => {
  const payload = JSON.stringify(claims); const sig = createSign('sha256').update(payload).sign({ key: privateKey, dsaEncoding: 'der' }).toString('base64');
  return { payload, sig, alg: 'ES256' };
};
const device = 'a'.repeat(64);
const claims = (overrides = {}) => ({
  schema: 'ronin.install-cert/1', issuer: 'ronin-update-host', installId: 'install-001',
  deviceSha256: device, bundleId: 'com.ronininc.solghost', releaseTag: 'v4.4.2',
  issuedAt: '2026-01-01T00:00:00.000Z', keySha: 'b'.repeat(64), ...overrides,
});

test('per-install certificate is signature, schema, issuer, bundle, key, and device bound', () => {
  const valid = envelope(claims());
  assert.equal(verifyInstallCertificate(valid, { deviceSha256: device, certKeyPem: publicKeyPem, now: () => Date.parse('2029-01-01') }).ok, true);
  assert.equal(verifyInstallCertificate(valid, { deviceSha256: 'b'.repeat(64), certKeyPem: publicKeyPem, now: () => Date.parse('2029-01-01') }).reason, 'install_certificate_wrong_device');
  assert.equal(verifyInstallCertificate({ ...valid, sig: valid.sig.slice(0, -3) + 'abc' }, { deviceSha256: device, certKeyPem: publicKeyPem }).reason, 'bad_install_certificate_signature');
  for (const bad of [{ schema: 'wrong' }, { issuer: 'wrong' }, { bundleId: 'com.fake' }, { keySha: 'bad' }, { issuedAt: 'bad' }]) {
    assert.equal(verifyInstallCertificate(envelope(claims(bad)), { deviceSha256: device, certKeyPem: publicKeyPem, now: () => Date.parse('2029-01-01') }).reason, 'bad_install_certificate_claims');
  }
});

test('keychain handoff returns only independently verified local identity', () => {
  const valid = envelope(claims({ installId: 'install-002' }));
  const got = readInstallIdentity({ run: () => JSON.stringify(valid), deviceHash: () => device, certKeyPem: publicKeyPem });
  assert.deepEqual(got, { installId: 'install-002', deviceSha256: device, keySha: 'b'.repeat(64), releaseTag: 'v4.4.2' });
  assert.equal(readInstallIdentity({ run: () => JSON.stringify(valid), deviceHash: () => 'b'.repeat(64), certKeyPem: publicKeyPem }), null);
});

test('Launcher verifies Kingmaker then reports the same fresh installation to CRM', async () => {
  let t = 10_000; const keyTypes = ['X25519', 'Ed25519', 'ML-KEM-768', 'ML-DSA-65'];
  const expectedInstallIdentity = { installId: 'install-003', deviceSha256: device, keySha: 'b'.repeat(64), releaseTag: 'v4.4.2' };
  const expectedArmorIdentity = { senderSignFp: 'kingmaker-fp', keyTypes };
  const install = { ok: true, issuer: 'kingmaker', ...expectedArmorIdentity, ...expectedInstallIdentity };
  const used = new Set();
  const gate = createLauncherDockGate({ expectedInstallIdentity, expectedArmorIdentity, now: () => t, verifyKingmaker: async ({ proof }) => proof === 'kingmaker-ok' ? install : { ok: false }, reportToCrm: async ({ install: got }) => ({ ok: true, issuer: 'ronin-crm', installId: got.installId, deviceSha256: got.deviceSha256, keyTypes: got.keyTypes }), checkRevocation: async () => false, consumeChallenge: async ({ challenge }) => !used.has(challenge) && !!used.add(challenge) });
  const request = { challenge: 'challenge_1234567890', issuedAt: t, kingmakerProof: 'kingmaker-ok' };
  assert.equal((await gate({ ...request, kingmakerProof: 'wrong' })).reason, 'kingmaker_mismatch');
  assert.equal((await gate(request)).ok, true);
  assert.equal((await gate(request)).reason, 'replayed_challenge');
  t += 120_001;
  assert.equal((await gate({ ...request, challenge: 'challenge_abcdefghijkl' })).reason, 'expired_challenge');
});

test('Launcher refuses a CRM receipt for another installation', async () => {
  const keyTypes = ['X25519', 'Ed25519', 'ML-KEM-768', 'ML-DSA-65'];
  const expectedInstallIdentity = { installId: 'install-A', deviceSha256: device, keySha: 'b'.repeat(64), releaseTag: 'v4.4.2' };
  const expectedArmorIdentity = { senderSignFp: 'fp', keyTypes };
  const gate = createLauncherDockGate({ expectedInstallIdentity, expectedArmorIdentity, now: () => 5, verifyKingmaker: async () => ({ ok: true, issuer: 'kingmaker', ...expectedArmorIdentity, ...expectedInstallIdentity }), reportToCrm: async () => ({ ok: true, issuer: 'ronin-crm', keyTypes, installId: 'install-B', deviceSha256: device }), checkRevocation: async () => false, consumeChallenge: async () => true });
  assert.equal((await gate({ challenge: 'challenge_abcdefghijkl', issuedAt: 5 })).reason, 'crm_report_rejected');
});

test('Launcher flow fails closed on revocation and missing durable adapters', async () => {
  const keyTypes = ['X25519', 'Ed25519', 'ML-KEM-768', 'ML-DSA-65'];
  const expectedInstallIdentity = { installId: 'install-004', deviceSha256: device, keySha: 'b'.repeat(64), releaseTag: 'v4.4.2' };
  const expectedArmorIdentity = { senderSignFp: 'fp', keyTypes };
  const base = { ok: true, issuer: 'kingmaker', ...expectedArmorIdentity, ...expectedInstallIdentity };
  const request = { challenge: 'challenge_armorproof1', issuedAt: 10 };
  assert.throws(() => createLauncherDockGate({ verifyKingmaker: async () => base }), /DOCK_ADAPTERS_REQUIRED/);
  assert.throws(() => createLauncherDockGate({ expectedInstallIdentity, verifyKingmaker: async () => base, reportToCrm: async () => ({}), checkRevocation: async () => false, consumeChallenge: async () => true }), /VERIFIED_ARMOR_IDENTITY_REQUIRED/);
  const gate = createLauncherDockGate({ expectedInstallIdentity, expectedArmorIdentity, now: () => 10, verifyKingmaker: async () => base, reportToCrm: async () => ({ ok: true }), checkRevocation: async () => true, consumeChallenge: async () => true });
  assert.equal((await gate(request)).reason, 'docking_identity_revoked');
});

test('Launcher refuses adapter identity that differs from verified local certificate or Armor key', async () => {
  const keyTypes = ['Ed25519'];
  const expectedInstallIdentity = { installId: 'install-005', deviceSha256: device, keySha: 'b'.repeat(64), releaseTag: 'v4.4.2' };
  const expectedArmorIdentity = { senderSignFp: 'trusted-armor-fp', keyTypes };
  const common = { expectedInstallIdentity, expectedArmorIdentity, now: () => 10, reportToCrm: async () => ({ ok: true }), checkRevocation: async () => false, consumeChallenge: async () => true };
  const request = { challenge: 'challenge_boundidentity', issuedAt: 10 };
  for (const changed of [{ installId: '' }, { deviceSha256: 'c'.repeat(64) }, { keySha: 'd'.repeat(64) }, { releaseTag: 'v9' }, { senderSignFp: 'attacker' }, { keyTypes: ['X25519'] }]) {
    const verifyKingmaker = async () => ({ ok: true, issuer: 'kingmaker', ...expectedInstallIdentity, ...expectedArmorIdentity, ...changed });
    assert.equal((await createLauncherDockGate({ ...common, verifyKingmaker })(request)).reason, 'kingmaker_mismatch');
  }
});

test('device hashing matches installer newline semantics', () => assert.equal(hashDeviceIdentifier('ABC'), '8470d56547eea6236d7c81a644ce74670ca0bbda998e13c629ef6bb3f0d60b69'));
