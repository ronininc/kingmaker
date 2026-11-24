import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  createCollectiveSkillPeer,
  createTestSkillCollective,
  publishTestedSkill,
} from '../lib/collective-skill-roundtrip.mjs';
import { prepareSkillContribution, verifySkillPackage } from '../lib/skill-distill.mjs';

const draft = {
  intent: 'normalize-text',
  parameterSlots: ['text'],
  steps: [
    { type: 'trim-text', input: { from: 'slot', index: 0 } },
    { type: 'collapse-whitespace', input: { from: 'step', index: 0 } },
  ],
  failureConditions: [{ type: 'empty-input', slot: 0 }],
  syntheticChecks: [
    { fixture: 'sample-text', slot: 0, expect: 'completed' },
    { fixture: 'empty-text', slot: 0, expect: 'empty-input' },
  ],
};

function runNormalized(input) {
  if (typeof input !== 'string' || !input.trim()) return { status: 'empty-input' };
  return { status: 'completed', text: input.trim().replace(/\s+/g, ' ') };
}

test('real distillate passes Armor, test collective, fresh peer use and revocation', async (t) => {
  const state = mkdtempSync(join(tmpdir(), 'kingmaker-real-skill-roundtrip-'));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const prepared = await prepareSkillContribution(draft, {
    provenance: { kind: 'synthetic-test-method' },
    reviewProvenance: async ({ digest }) => ({
      digest,
      provenance: 'verified',
      redistributionRights: 'authorized',
      confidentialKnowHow: 'absent',
    }),
  });
  assert.equal(prepared.ok, true);

  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const host = createTestSkillCollective({
    signingKey: privateKey,
    verifyPackage: verifySkillPackage,
    testPackage: async (bytes, pin) => {
      const verified = await verifySkillPackage(bytes, pin.digest);
      assert.equal(verified.ok, true);
      assert.deepEqual(runNormalized('  sample\ttext '), { status: 'completed', text: 'sample text' });
      assert.deepEqual(runNormalized(''), { status: 'empty-input' });
      return { ok: true, digest: pin.digest };
    },
  });
  const authorized = ({ operation }) => operation === 'publish' || operation === 'invoke';
  const published = await publishTestedSkill({
    state: join(state, 'author'),
    bytes: prepared.bytes,
    transport: host,
    publicKey,
    verifyPackage: verifySkillPackage,
    authorize: authorized,
  });
  assert.equal(published.ok, true);
  assert.equal(published.digest, prepared.manifest.digest);

  const peer = createCollectiveSkillPeer({
    state: join(state, 'peer'),
    transport: host,
    publicKey,
    verifyPackage: verifySkillPackage,
    authorize: authorized,
    run: ({ input }) => runNormalized(input),
  });
  assert.equal((await peer.importSkill(prepared.manifest)).ok, true);
  assert.deepEqual(await peer.invoke(prepared.manifest, '  new   catalog '), {
    ok: true,
    id: prepared.manifest.id,
    version: prepared.manifest.version,
    digest: prepared.manifest.digest,
    artifact: { status: 'completed', text: 'new catalog' },
  });
  assert.equal(host.revoke(prepared.manifest), true);
  assert.equal((await peer.invoke(prepared.manifest, 'again')).reason, 'package-revoked');
});
