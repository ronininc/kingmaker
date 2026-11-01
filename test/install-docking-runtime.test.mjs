import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createIdentity, signPayload, signRevocation } from '../scripture-armor/armor.mjs';
import { createArmorRevocationChecker, createDockChallengeStore, createKingmakerArmorProofVerifier } from '../lib/install-docking-runtime.mjs';
import { createLauncherDockGate } from '../lib/install-docking.mjs';

const deviceSha256 = 'a'.repeat(64);
const expectedInstallIdentity = { installId: 'install-fixture', deviceSha256, keySha: 'b'.repeat(64), releaseTag: 'v4.4.2' };
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'kingmaker-dock-')); chmodSync(root, 0o700);
  const identity = createIdentity(join(root, 'identity'), 'Kingmaker fixture');
  const expectedArmorIdentity = { senderSignFp: identity.signFp, keyTypes: ['Ed25519'] };
  return { root, identity, expectedArmorIdentity };
};
const proof = (identity, challenge, issuedAt) => signPayload(identity, {
  type: 'kingmaker.install-proof/1', nonce: challenge, at: new Date(issuedAt).toISOString(),
  body: { schema: 'kingmaker.install-proof/1', challenge, issuedAt, ...expectedInstallIdentity },
});
const revocationSnapshot = (issuer, querySignFp, at, overrides = {}) => signPayload(issuer, {
  type: 'armor.revocation-query-response/1', at: new Date(at).toISOString(),
  body: { schema: 'armor.revocation-query-response/1', querySignFp, complete: true,
    generatedAt: new Date(at).toISOString(), validUntil: new Date(at + 60_000).toISOString(), records: [], ...overrides },
});

test('concrete Armor verifier binds signature, embedded fingerprint, challenge and install claims', async (t) => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const issuedAt = Date.parse('2026-11-01T00:00:00Z'); const challenge = 'challenge_concrete01';
  const verify = createKingmakerArmorProofVerifier({ expectedArmorIdentity: f.expectedArmorIdentity, expectedInstallIdentity });
  assert.equal((await verify({ challenge, issuedAt, proof: proof(f.identity, challenge, issuedAt) })).ok, true);
  const altered = proof(f.identity, challenge, issuedAt); altered.body.deviceSha256 = 'c'.repeat(64);
  assert.equal((await verify({ challenge, issuedAt, proof: altered })).ok, false);
  const other = fixture(); t.after(() => rmSync(other.root, { recursive: true, force: true }));
  assert.equal((await verify({ challenge, issuedAt, proof: proof(other.identity, challenge, issuedAt) })).ok, false);
});

test('durable challenge consumption survives restart and permits only one winner', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'kingmaker-replay-')); chmodSync(root, 0o700); t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'private', 'challenges.sqlite');
  let store = createDockChallengeStore({ path, now: () => 9 });
  const item = { challenge: 'challenge_durable01', issuedAt: 1, installId: 'install-fixture' };
  assert.equal(await store.consumeChallenge(item), true); store.close();
  store = createDockChallengeStore({ path, now: () => 10 });
  assert.equal(await store.consumeChallenge(item), false); store.close();
});

test('Launcher gate runs concrete Armor verification and durable replay refusal', async (t) => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const challenge = 'challenge_endtoend01'; const issuedAt = Date.parse('2026-11-01T00:00:00Z');
  const issuer = createIdentity(join(f.root, 'revocation-issuer'), 'Revocation fixture');
  const store = createDockChallengeStore({ path: join(f.root, 'state', 'challenges.sqlite') }); t.after(() => store.close());
  const gate = createLauncherDockGate({
    expectedInstallIdentity, expectedArmorIdentity: f.expectedArmorIdentity,
    verifyKingmaker: createKingmakerArmorProofVerifier({ expectedInstallIdentity, expectedArmorIdentity: f.expectedArmorIdentity }),
    checkRevocation: createArmorRevocationChecker({ trustedIssuerSignFp: issuer.signFp, now: () => issuedAt,
      fetchSnapshot: async (fp) => revocationSnapshot(issuer, fp, issuedAt), resolveSignPub: () => null }),
    consumeChallenge: store.consumeChallenge,
    reportToCrm: async ({ install }) => ({ ok: true, issuer: 'ronin-crm', installId: install.installId, deviceSha256: install.deviceSha256, keyTypes: install.keyTypes }),
    now: () => issuedAt,
  });
  const request = { challenge, issuedAt, kingmakerProof: proof(f.identity, challenge, issuedAt) };
  assert.equal((await gate(request)).ok, true);
  assert.equal((await gate(request)).reason, 'replayed_challenge');
});

test('revocation requires a fresh authenticated complete query-bound response', async (t) => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const issuer = createIdentity(join(f.root, 'issuer'), 'Revocation fixture');
  const other = createIdentity(join(f.root, 'other'), 'Other fixture');
  const fp = f.identity.signFp; const at = Date.parse('2026-11-01T00:00:00Z');
  assert.throws(() => createArmorRevocationChecker({}), /TRUSTED_REVOCATION_PROVIDER_REQUIRED/);
  const checker = (fetchSnapshot, extra = {}) => createArmorRevocationChecker({ trustedIssuerSignFp: issuer.signFp, fetchSnapshot, resolveSignPub: () => null, now: () => at, ...extra });
  assert.equal(await checker(async () => revocationSnapshot(issuer, fp, at))({ senderSignFp: fp }), false);
  await assert.rejects(() => checker(async () => null)({ senderSignFp: fp }), /UNAUTHENTICATED/);
  await assert.rejects(() => checker(async () => revocationSnapshot(other, fp, at))({ senderSignFp: fp }), /UNTRUSTED_ISSUER/);
  await assert.rejects(() => checker(async () => revocationSnapshot(issuer, 'a'.repeat(64), at))({ senderSignFp: fp }), /INCOMPLETE/);
  await assert.rejects(() => checker(async () => revocationSnapshot(issuer, fp, at - 600_000))({ senderSignFp: fp }), /STALE/);
  await assert.rejects(() => checker(async () => revocationSnapshot(issuer, fp, at, { complete: false }))({ senderSignFp: fp }), /INCOMPLETE/);
  const unsigned = revocationSnapshot(issuer, fp, at); unsigned.sig = '';
  await assert.rejects(() => checker(async () => unsigned)({ senderSignFp: fp }), /UNAUTHENTICATED/);
  const revoked = signRevocation(issuer, { label: 'fixture', seal_fp: f.identity.sealFp, sign_fp: fp, at: new Date(at).toISOString(), by_sign_fp: issuer.signFp, by_label: issuer.label, reason: 'fixture' });
  const resolveSignPub = (wanted) => wanted === issuer.signFp ? issuer.sign_pub : null;
  const checkRevoked = createArmorRevocationChecker({ trustedIssuerSignFp: issuer.signFp, fetchSnapshot: async () => revocationSnapshot(issuer, fp, at, { records: [revoked] }), resolveSignPub, now: () => at });
  assert.equal(await checkRevoked({ senderSignFp: fp }), true);
  const check = checker(async () => revocationSnapshot(issuer, fp, at));
  await assert.rejects(() => check({ senderSignFp: '' }), /REVOCATION_IDENTITY_INVALID/);
});
