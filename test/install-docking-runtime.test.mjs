import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createIdentity, signPayload } from '../scripture-armor/armor.mjs';
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
  const store = createDockChallengeStore({ path: join(f.root, 'state', 'challenges.sqlite') }); t.after(() => store.close());
  const gate = createLauncherDockGate({
    expectedInstallIdentity, expectedArmorIdentity: f.expectedArmorIdentity,
    verifyKingmaker: createKingmakerArmorProofVerifier({ expectedInstallIdentity, expectedArmorIdentity: f.expectedArmorIdentity }),
    checkRevocation: createArmorRevocationChecker({ records: { v: 1, records: [] }, resolveSignPub: () => null }),
    consumeChallenge: store.consumeChallenge,
    reportToCrm: async ({ install }) => ({ ok: true, issuer: 'ronin-crm', installId: install.installId, deviceSha256: install.deviceSha256, keyTypes: install.keyTypes }),
    now: () => issuedAt,
  });
  const request = { challenge, issuedAt, kingmakerProof: proof(f.identity, challenge, issuedAt) };
  assert.equal((await gate(request)).ok, true);
  assert.equal((await gate(request)).reason, 'replayed_challenge');
});

test('revocation configuration fails closed when missing or malformed', async () => {
  assert.throws(() => createArmorRevocationChecker({}), /TRUSTED_REVOCATION_PROVIDER_REQUIRED/);
  const check = createArmorRevocationChecker({ records: { v: 1, records: [] }, resolveSignPub: () => null });
  assert.equal(await check({ senderSignFp: 'a'.repeat(64) }), false);
  await assert.rejects(() => check({ senderSignFp: '' }), /REVOCATION_IDENTITY_INVALID/);
  const untrusted = createArmorRevocationChecker({ records: { v: 1, records: [{ sign_fp: 'a'.repeat(64) }] }, resolveSignPub: () => null });
  await assert.rejects(() => untrusted({ senderSignFp: 'a'.repeat(64) }), /REVOCATION_RECORD_UNVERIFIABLE/);
});
