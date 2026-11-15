import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdentity } from '../scripture-armor/armor.mjs';
import { createKingmakerInstallProof, createKingmakerArmorProofVerifier } from '../lib/install-docking-runtime.mjs';

test('bundled identity reports only actual keys, signs claims, and refuses unsupported PQ requirements', async () => {
  const state = mkdtempSync(join(tmpdir(), 'dock-keytypes-'));
  try {
    const dir = join(state, 'armor', 'identity');
    createIdentity(dir, 'synthetic-regression-only');
    const installIdentity = { installId: 'fixture', deviceSha256: 'a'.repeat(64), keySha: 'b'.repeat(64), releaseTag: 'fixture' };
    const input = { state, challenge: 'challenge_fixture_1234', issuedAt: 1000, now: () => 1000, installIdentity, checkRevocation: async () => false };
    const result = await createKingmakerInstallProof(input);
    assert.deepEqual(result.armorIdentity.keyTypes, ['X25519', 'Ed25519']);
    assert.deepEqual(result.proof.body.keyTypes, result.armorIdentity.keyTypes);
    const verify = createKingmakerArmorProofVerifier({ expectedArmorIdentity: result.armorIdentity, expectedInstallIdentity: installIdentity });
    assert.equal((await verify({ ...input, proof: result.proof })).ok, true);
    const tampered = structuredClone(result.proof); tampered.body.keyTypes.push('ML-KEM-768');
    assert.equal((await verify({ ...input, proof: tampered })).ok, false);
    assert.throws(() => createKingmakerArmorProofVerifier({ expectedArmorIdentity: { ...result.armorIdentity, keyTypes: ['X25519', 'Ed25519', 'ML-KEM-768', 'ML-DSA-65'] }, expectedInstallIdentity: installIdentity }), /ARMOR_REQUIRED_KEY_TYPES_UNSUPPORTED/);
    const other = createIdentity(join(state, 'other'), 'other-synthetic');
    const file = join(dir, 'identity.json'), json = JSON.parse(readFileSync(file, 'utf8'));
    json.seal_pub = other.seal_pub; writeFileSync(file, JSON.stringify(json));
    await assert.rejects(createKingmakerInstallProof(input), /ARMOR_KEY_MATERIAL_INVALID/);
  } finally { rmSync(state, { recursive: true, force: true }); }
});
