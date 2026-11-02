import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { createLauncherCrmIdentityClient, launcherIdentityCanonicalJson } from '../lib/launcher-crm-identity-client.mjs';

const keys = generateKeyPairSync('ed25519');
const install = { installId: '11111111-1111-4111-8111-111111111111', deviceSha256: 'a'.repeat(64), keySha: 'b'.repeat(64), releaseTag: 'v4.4.2' };
const cert = { payload: JSON.stringify({ installId: install.installId }), sig: 'fixture', alg: 'ES256' };
const keyTypes = ['X25519', 'Ed25519', 'ML-KEM-768', 'ML-DSA-65'];
const appSha256 = 'c'.repeat(64), manifestDigest = 'd'.repeat(64);

test('Launcher uses the canonical CRM challenge/report schema and validates receipt echoes', async () => {
  const calls = []; let reportPayload;
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body); calls.push({ url: String(url), init, body });
    if (String(url).endsWith('/challenge')) return new Response(JSON.stringify({ schema: 'ronin.launcher.identity-challenge/v1', challengeId: 'challenge-id', challenge: 'challenge-value', expiresAt: 1240, pairingId: 'pair-id', pairingInstallId: '0123456789abcdef0123456789abcdef' }), { status: 201, headers: { 'content-type': 'application/json' } });
    reportPayload = body.signedReport.payload;
    return new Response(JSON.stringify({ ok: true, eventId: 'event-id', state: reportPayload.state, certifiedInstallationId: reportPayload.certifiedInstallationId, deviceSha256: reportPayload.deviceSha256, verifiedAt: reportPayload.issuedAt }), { status: 201, headers: { 'content-type': 'application/json' } });
  };
  const client = createLauncherCrmIdentityClient({ baseUrl: 'https://crm.invalid', bearerToken: 'fixture-token', applicationId: 'app-1', memberId: 'member-1', providerRegistrationId: 'reg-1', provider: 'launcher-provider', providerPublicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'fixture' }, fetchImpl, now: () => 1000,
    signReport: async (payload) => ({ keyId: 'report-key', value: sign(null, Buffer.from(launcherIdentityCanonicalJson(payload)), keys.privateKey).toString('base64url') }) });
  const result = await client.report({ installCertificate: cert, verifiedInstallIdentity: install, providerAttestation: { local: 'verified' }, appSha256, manifestDigest });
  assert.equal(result.receipt.eventId, 'event-id');
  assert.equal(calls.length, 2); assert.match(calls[0].url, /\/challenge$/); assert.match(calls[1].url, /\/report$/);
  assert.equal(reportPayload.schema, 'ronin.launcher.identity-report/v1');
  assert.equal(reportPayload.certifiedInstallationId, install.installId);
  assert.equal(reportPayload.deviceSha256, install.deviceSha256);
  assert.equal(reportPayload.identityProfile, 'free');
  assert.equal(reportPayload.releaseTag, install.releaseTag);
  assert.equal(reportPayload.releaseKeySha, install.keySha);
  assert.equal(reportPayload.appSha256, appSha256);
  assert.equal(reportPayload.manifestDigest, manifestDigest);
  assert.deepEqual(reportPayload.armorKeyTypes, []);
  assert.equal('hostname' in reportPayload || 'serial' in reportPayload || 'inventory' in reportPayload, false);
  assert.equal(reportPayload.pairingInstallId, '0123456789abcdef0123456789abcdef');
  assert.equal(reportPayload.expiresAt, 1240);
  assert.equal(calls[1].body.providerRegistrationId, 'reg-1');
});

test('client refuses invalid challenges, receipt mismatch, and unsupported key-type claims', async () => {
  const base = { baseUrl: 'https://crm.invalid', bearerToken: 'fixture', applicationId: 'app', memberId: 'member', providerRegistrationId: 'reg', provider: 'provider', providerPublicJwk: { kty: 'OKP' }, now: () => 1000, signReport: async () => ({ keyId: 'k', value: 'sig' }) };
  let client = createLauncherCrmIdentityClient({ ...base, fetchImpl: async () => new Response('{}', { status: 201 }) });
  await assert.rejects(() => client.report({ installCertificate: cert, verifiedInstallIdentity: install, providerAttestation: {}, appSha256, manifestDigest }), /CHALLENGE_INVALID/);
  let n = 0; client = createLauncherCrmIdentityClient({ ...base, fetchImpl: async () => ++n === 1
    ? new Response(JSON.stringify({ schema: 'ronin.launcher.identity-challenge/v1', challengeId: 'c', challenge: 'x', expiresAt: 1200, pairingId: 'p', pairingInstallId: 'legacy' }), { status: 201 })
    : new Response(JSON.stringify({ ok: true, eventId: 'e', state: 'valid', certifiedInstallationId: 'wrong', deviceSha256: install.deviceSha256, verifiedAt: 1000 }), { status: 201 }) });
  await assert.rejects(() => client.report({ installCertificate: cert, verifiedInstallIdentity: install, providerAttestation: {}, appSha256, manifestDigest }), /REPORT_REJECTED/);
  await assert.rejects(() => client.report({ installCertificate: cert, verifiedInstallIdentity: install, providerAttestation: {}, appSha256, manifestDigest, armorKeyTypes: ['Ed25519'] }), /INPUT_REQUIRED/);
});

test('paid Armor is additive and never substitutes for Launcher install binding', async () => {
  let payload; let n = 0;
  const client = createLauncherCrmIdentityClient({ baseUrl: 'https://crm.invalid', bearerToken: 'fixture', applicationId: 'app', memberId: 'member', providerRegistrationId: 'reg', provider: 'provider', providerPublicJwk: { kty: 'OKP' }, now: () => 1000,
    signReport: async () => ({ keyId: 'k', value: 'sig' }), fetchImpl: async (_url, init) => {
      if (++n === 1) return new Response(JSON.stringify({ schema: 'ronin.launcher.identity-challenge/v1', challengeId: 'c', challenge: 'x', expiresAt: 1200, pairingId: 'p', pairingInstallId: 'legacy' }), { status: 201 });
      payload = JSON.parse(init.body).signedReport.payload;
      return new Response(JSON.stringify({ ok: true, eventId: 'e', state: 'valid', certifiedInstallationId: install.installId, deviceSha256: install.deviceSha256, verifiedAt: 1000 }), { status: 201 });
    } });
  await client.report({ installCertificate: cert, verifiedInstallIdentity: install, providerAttestation: { armor: 'verified' }, identityProfile: 'paid-armor', appSha256, manifestDigest, armorKeyTypes: keyTypes });
  assert.equal(payload.identityProfile, 'paid-armor'); assert.deepEqual(payload.armorKeyTypes, keyTypes);
  await assert.rejects(() => client.report({ installCertificate: cert, verifiedInstallIdentity: install, providerAttestation: {}, identityProfile: 'paid-armor', appSha256, manifestDigest, armorKeyTypes: [] }), /INPUT_REQUIRED/);
});
