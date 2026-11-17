import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { armor, armorFns } from '../lib/armor-connection.mjs';
const { createIdentity } = armorFns(armor, ['createIdentity']);
import { createKingmakerInstallProof, createKingmakerArmorProofVerifier, verifiedKeyTypes } from '../lib/install-docking-runtime.mjs';
import { ARMOR_KEM_SKIP, ARMOR_SKIP } from './helpers/host-tool-skips.mjs';

const HYBRID = ['X25519', 'Ed25519', 'ML-KEM-768', 'ML-DSA-65'];

// 2026-11-17: Kingmaker now uses the INSTALLED Armor, whose identities are hybrid. Same property as before — report only the
// keys actually held, never advertise more — now checked against real hybrid identities and a classical-only key set.
test('installed-Armor identity reports only actual keys, signs claims, and refuses unsupported key requirements', { skip: ARMOR_KEM_SKIP || ARMOR_SKIP }, async () => {
  const state = mkdtempSync(join(tmpdir(), 'dock-keytypes-'));
  try {
    const dir = join(state, 'armor', 'identity');
    createIdentity(dir, 'synthetic-regression-only');
    const installIdentity = { installId: 'fixture', deviceSha256: 'a'.repeat(64), keySha: 'b'.repeat(64), releaseTag: 'fixture' };
    const input = { state, challenge: 'challenge_fixture_1234', issuedAt: 1000, now: () => 1000, installIdentity, checkRevocation: async () => false };
    const result = await createKingmakerInstallProof(input);
    assert.deepEqual(result.armorIdentity.keyTypes, HYBRID);
    assert.deepEqual(result.proof.body.keyTypes, result.armorIdentity.keyTypes);
    const verify = createKingmakerArmorProofVerifier({ expectedArmorIdentity: result.armorIdentity, expectedInstallIdentity: installIdentity });
    assert.equal((await verify({ ...input, proof: result.proof })).ok, true);
    const dropped = structuredClone(result.proof); dropped.body.keyTypes.pop();
    assert.equal((await verify({ ...input, proof: dropped })).ok, false);
    const added = structuredClone(result.proof); added.body.keyTypes.push('SLH-DSA');
    assert.equal((await verify({ ...input, proof: added })).ok, false);
    // A classical-only key set is reported as exactly that, and no verifier accepts it.
    const me = armor.loadIdentity(dir);
    const classical = { sealPub: me.sealPub, sealPriv: me.sealPriv, signPub: me.signPub, signPriv: me.signPriv };
    assert.deepEqual(verifiedKeyTypes(classical), ['X25519', 'Ed25519']);
    assert.throws(() => verifiedKeyTypes({ ...classical, kemPub: me.kemPub, kemPriv: me.kemPriv }), /ARMOR_KEY_MATERIAL_INVALID/);
    assert.throws(() => verifiedKeyTypes({ ...me, kemPriv: me.sealPriv }), /ARMOR_KEY_MATERIAL_INVALID/);
    assert.throws(() => createKingmakerArmorProofVerifier({ expectedArmorIdentity: { ...result.armorIdentity, keyTypes: ['X25519', 'Ed25519'] }, expectedInstallIdentity: installIdentity }), /ARMOR_REQUIRED_KEY_TYPES_UNSUPPORTED/);
    const other = createIdentity(join(state, 'other'), 'other-synthetic');
    const file = join(dir, 'identity.json'), json = JSON.parse(readFileSync(file, 'utf8'));
    json.seal_pub = other.seal_pub; writeFileSync(file, JSON.stringify(json));
    await assert.rejects(createKingmakerInstallProof(input), /ARMOR_KEY_MATERIAL_INVALID/);
  } finally { rmSync(state, { recursive: true, force: true }); }
});
