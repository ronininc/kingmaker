import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';
import test from 'node:test';
import { createDualDockGate, hashDeviceIdentifier, readInstallIdentity, verifyInstallCertificate } from '../lib/install-docking.mjs';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
const envelope = (claims) => {
  const payload = JSON.stringify(claims); const sig = createSign('sha256').update(payload).sign({ key: privateKey, dsaEncoding: 'der' }).toString('base64');
  return { payload, sig, alg: 'ES256' };
};
const device = 'a'.repeat(64);

test('per-install certificate is signature, device, and expiry bound', () => {
  const valid = envelope({ installId: 'install-001', deviceSha256: device, expiresAt: '2030-01-01T00:00:00.000Z' });
  assert.equal(verifyInstallCertificate(valid, { deviceSha256: device, certKeyPem: publicKeyPem, now: () => Date.parse('2029-01-01') }).ok, true);
  assert.equal(verifyInstallCertificate(valid, { deviceSha256: 'b'.repeat(64), certKeyPem: publicKeyPem, now: () => Date.parse('2029-01-01') }).reason, 'install_certificate_wrong_device');
  assert.equal(verifyInstallCertificate(valid, { deviceSha256: device, certKeyPem: publicKeyPem, now: () => Date.parse('2031-01-01') }).reason, 'install_certificate_expired');
  assert.equal(verifyInstallCertificate({ ...valid, sig: valid.sig.slice(0, -3) + 'abc' }, { deviceSha256: device, certKeyPem: publicKeyPem }).reason, 'bad_install_certificate_signature');
});

test('keychain handoff returns only independently verified local identity', () => {
  const valid = envelope({ installId: 'install-002', deviceSha256: device });
  const got = readInstallIdentity({ run: () => JSON.stringify(valid), deviceHash: () => device, certKeyPem: publicKeyPem });
  assert.deepEqual(got, { installId: 'install-002', deviceSha256: device });
  assert.equal(readInstallIdentity({ run: () => JSON.stringify(valid), deviceHash: () => 'b'.repeat(64), certKeyPem: publicKeyPem }), null);
});

test('dual docking requires Launcher and CRM to match the same fresh installation', async () => {
  let t = 10_000; const keyTypes = ['X25519', 'Ed25519', 'ML-KEM-768', 'ML-DSA-65'];
  const launcher = { ok: true, issuer: 'ronin-launcher', senderSignFp: 'launcher-fp', keyTypes, installId: 'install-003', deviceSha256: device };
  const crm = { ok: true, issuer: 'ronin-crm', senderSignFp: 'crm-fp', keyTypes, installId: 'install-003', deviceSha256: device };
  const gate = createDualDockGate({ now: () => t, verifyLauncher: async ({ proof }) => proof === 'launcher-ok' ? launcher : { ok: false }, verifyCrm: async ({ proof }) => proof === 'crm-ok' ? crm : { ok: false } });
  const request = { challenge: 'challenge_1234567890', issuedAt: t, launcherProof: 'launcher-ok', crmProof: 'crm-ok' };
  assert.equal((await gate({ ...request, launcherProof: 'wrong' })).reason, 'launcher_mismatch');
  assert.equal((await gate({ ...request, crmProof: 'wrong' })).reason, 'crm_mismatch');
  assert.equal((await gate(request)).ok, true);
  assert.equal((await gate(request)).reason, 'replayed_challenge');
  t += 120_001;
  assert.equal((await gate({ ...request, challenge: 'challenge_abcdefghijkl' })).reason, 'expired_challenge');
});

test('dual docking rejects Launcher and CRM identities that differ', async () => {
  const keyTypes = ['X25519', 'Ed25519', 'ML-KEM-768', 'ML-DSA-65'];
  const gate = createDualDockGate({ now: () => 5, verifyLauncher: async () => ({ ok: true, issuer: 'ronin-launcher', senderSignFp: 'launcher-fp', keyTypes, installId: 'install-A', deviceSha256: device }), verifyCrm: async () => ({ ok: true, issuer: 'ronin-crm', senderSignFp: 'crm-fp', keyTypes, installId: 'install-B', deviceSha256: device }) });
  assert.equal((await gate({ challenge: 'challenge_abcdefghijkl', issuedAt: 5 })).reason, 'dock_identity_mismatch');
});

test('dual docking rejects wrong issuer, Armor key type, and revoked identity', async () => {
  const keyTypes = ['X25519', 'Ed25519', 'ML-KEM-768', 'ML-DSA-65'];
  const base = { ok: true, installId: 'install-004', deviceSha256: device, keyTypes };
  const request = { challenge: 'challenge_armorproof1', issuedAt: 10 };
  let gate = createDualDockGate({ now: () => 10, verifyLauncher: async () => ({ ...base, issuer: 'wrong', senderSignFp: 'launcher-fp' }), verifyCrm: async () => ({ ...base, issuer: 'ronin-crm', senderSignFp: 'crm-fp' }) });
  assert.equal((await gate(request)).reason, 'launcher_mismatch');
  gate = createDualDockGate({ now: () => 10, verifyLauncher: async () => ({ ...base, issuer: 'ronin-launcher', senderSignFp: 'launcher-fp', keyTypes: ['Ed25519'] }), verifyCrm: async () => ({ ...base, issuer: 'ronin-crm', senderSignFp: 'crm-fp' }) });
  assert.equal((await gate(request)).reason, 'armor_key_type_mismatch');
  gate = createDualDockGate({ now: () => 10, verifyLauncher: async () => ({ ...base, issuer: 'ronin-launcher', senderSignFp: 'launcher-fp' }), verifyCrm: async () => ({ ...base, issuer: 'ronin-crm', senderSignFp: 'crm-fp' }), isRevoked: async ({ issuer }) => issuer === 'ronin-crm' });
  assert.equal((await gate(request)).reason, 'docking_identity_revoked');
});

test('device hashing matches installer newline semantics', () => assert.equal(hashDeviceIdentifier('ABC'), '8470d56547eea6236d7c81a644ce74670ca0bbda998e13c629ef6bb3f0d60b69'));
