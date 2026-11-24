import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepareSkillContribution, SKILL_PACKAGE_SCHEMA, verifySkillPackage } from '../lib/skill-distill.mjs';
import { scanSourceText } from '../scripture-armor/scan.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const armor = (bytes) => scanSourceText(bytes.toString('utf8'), 'skill-package.json', hash(bytes));
const safeDraft = () => ({
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
});

const provenance = {
  originalPrompt: 'Fixture instruction that stays on the device',
  sourceFiles: ['synthetic-customer-internal.csv'],
  inputs: ['fixture-only original input'],
  outputs: ['fixture-only original output'],
  logs: ['fixture-only internal log entry'],
  clientId: 'fictional-private-client',
  customCode: 'fixture-only implementation text',
  context: 'fixture-only free-form notes',
};
const approvedReview = ({ digest }) => ({
  digest, provenance: 'verified', redistributionRights: 'authorized', confidentialKnowHow: 'absent',
});
const approvals = { provenance, reviewProvenance: approvedReview };

test('prepares a safe package with only versioned declarations and scans the exact reviewed bytes', async () => {
  let reviewed;
  let scanned;
  const draft = safeDraft();
  const prepared = await prepareSkillContribution(draft, {
    provenance,
    reviewProvenance: (request) => {
      assert.equal(request.provenance, provenance);
      reviewed = request.bytes;
      return approvedReview(request);
    },
    scanPackage: (bytes) => {
      scanned = bytes;
      return armor(bytes);
    },
  });
  assert.equal(prepared.ok, true);
  assert.deepEqual(prepared.bytes, reviewed);
  assert.deepEqual(prepared.bytes, scanned);
  assert.deepEqual(JSON.parse(prepared.bytes.toString('utf8')), { schema: SKILL_PACKAGE_SCHEMA, ...draft });
  const digest = hash(prepared.bytes);
  assert.deepEqual(prepared.manifest, {
    schema: SKILL_PACKAGE_SCHEMA, id: `skill-${digest.slice(0, 24)}`, version: '1', digest,
    syntheticChecks: draft.syntheticChecks, permissions: [],
  });
  assert.deepEqual(await verifySkillPackage(prepared.bytes, digest), { ok: true, manifest: prepared.manifest });
  assert.deepEqual(await prepareSkillContribution(Object.fromEntries(Object.entries(draft).reverse()), approvals), prepared);
});

test('closes the gate for ambiguous provenance, redistribution rights, and confidential know-how', async () => {
  const cases = [
    [{ provenance: undefined }, 'provenance-unverified'],
    [{ reviewProvenance: undefined }, 'provenance-unverified'],
    [{ reviewProvenance: () => { throw new Error('private evidence unavailable'); } }, 'provenance-unverified'],
    [{ reviewProvenance: (request) => ({ ...approvedReview(request), digest: '0'.repeat(64) }) }, 'provenance-unverified'],
    [{ reviewProvenance: (request) => ({ ...approvedReview(request), provenance: 'unknown' }) }, 'provenance-unverified'],
    [{ reviewProvenance: (request) => ({ ...approvedReview(request), redistributionRights: 'unknown' }) }, 'rights-unverified'],
    [{ reviewProvenance: (request) => ({ ...approvedReview(request), redistributionRights: 'denied' }) }, 'rights-unverified'],
    [{ reviewProvenance: (request) => ({ ...approvedReview(request), confidentialKnowHow: 'unknown' }) }, 'confidentiality-unverified'],
    [{ reviewProvenance: (request) => ({ ...approvedReview(request), confidentialKnowHow: 'present' }) }, 'confidentiality-unverified'],
  ];
  let scanCalls = 0;
  for (const [options, reason] of cases) {
    const result = await prepareSkillContribution(safeDraft(), {
      ...approvals, ...options, scanPackage: (bytes) => { scanCalls++; return armor(bytes); },
    });
    assert.deepEqual(result, { ok: false, reason });
  }
  assert.equal(scanCalls, 0);
});

test('rejects private fields, known secret material, and unsafe capabilities before approval', async () => {
  let reviewCalls = 0;
  const options = { ...approvals, reviewProvenance: (request) => { reviewCalls++; return approvedReview(request); } };
  for (const [field, value] of Object.entries(provenance)) {
    assert.deepEqual(await prepareSkillContribution({ ...safeDraft(), [field]: value }, options),
      { ok: false, reason: 'invalid-declaration' }, field);
  }
  const secret = safeDraft();
  secret.parameterSlots[0] = `sk-${'SYNTHETIC'.repeat(3)}`;
  assert.deepEqual(await prepareSkillContribution(secret, options), { ok: false, reason: 'secret-material' });
  for (const type of ['shell', 'network', 'read-file', 'send', 'pay', 'delete', 'custom-code']) {
    const draft = safeDraft();
    draft.steps[0].type = type;
    assert.deepEqual(await prepareSkillContribution(draft, options), { ok: false, reason: 'unsafe-capability' }, type);
  }
  assert.equal(reviewCalls, 0);
});

test('requires typed prior references and synthetic coverage of declared failure conditions', async () => {
  const invalidCases = [
    (draft) => { draft.steps[0].input = { from: 'step', index: 1 }; },
    (draft) => { draft.steps[1].type = 'count-records'; },
    (draft) => { draft.steps[0].customCode = 'synthetic'; },
    (draft) => { draft.steps.annotation = 'synthetic metadata'; },
    (draft) => { draft.syntheticChecks[0].fixture = 'sample-records'; },
    (draft) => { draft.syntheticChecks[1].expect = 'completed'; },
    (draft) => { draft.syntheticChecks.pop(); },
    (draft) => { draft.syntheticChecks.shift(); },
    (draft) => { draft.syntheticChecks[0].value = 'arbitrary test literal'; },
  ];
  for (const makeInvalid of invalidCases) {
    const draft = safeDraft();
    makeInvalid(draft);
    assert.deepEqual(await prepareSkillContribution(draft, approvals), { ok: false, reason: 'invalid-declaration' });
  }
  const records = {
    intent: 'count-records',
    parameterSlots: ['records'],
    steps: [
      { type: 'deduplicate-records', input: { from: 'slot', index: 0 } },
      { type: 'count-records', input: { from: 'step', index: 0 } },
    ],
    failureConditions: [{ type: 'empty-input', slot: 0 }],
    syntheticChecks: [
      { fixture: 'sample-records', slot: 0, expect: 'completed' },
      { fixture: 'empty-records', slot: 0, expect: 'empty-input' },
    ],
  };
  assert.equal((await prepareSkillContribution(records, approvals)).ok, true);
});

test('requires a clean, bound Armor scan after provenance review', async () => {
  const cases = [
    [() => { throw new Error('scanner unavailable'); }, 'armor-unavailable'],
    [(bytes) => ({ ...armor(bytes), target_sha256: hash(Buffer.from('different bytes')) }), 'armor-digest-mismatch'],
    [(bytes) => ({ ...armor(bytes), verdict: 'warn' }), 'armor-refused'],
    [(bytes) => ({ ...armor(bytes), findings: [{ severity: 'medium' }] }), 'armor-refused'],
    [(bytes) => ({ ...armor(bytes), analysis_confidence: 'low' }), 'armor-refused'],
    [(bytes) => ({ ...armor(bytes), override: { approved: true } }), 'armor-refused'],
    [(bytes) => ({ target_sha256: hash(bytes), verdict: 'pass' }), 'armor-refused'],
    [(bytes) => { const report = armor(bytes); bytes[0] = 0; return report; }, 'armor-digest-mismatch'],
  ];
  for (const [scanPackage, reason] of cases) {
    assert.deepEqual(await prepareSkillContribution(safeDraft(), { ...approvals, scanPackage }), { ok: false, reason });
  }
});

test('detects byte tampering and refuses noncanonical JSON even when given its matching digest', async () => {
  const prepared = await prepareSkillContribution(safeDraft(), approvals);
  assert.equal(prepared.ok, true);
  const altered = Buffer.concat([prepared.bytes, Buffer.from(' ')]);
  assert.deepEqual(await verifySkillPackage(altered, prepared.manifest.digest), { ok: false, reason: 'digest-mismatch' });
  assert.deepEqual(await verifySkillPackage(altered, hash(altered)), { ok: false, reason: 'noncanonical-package' });
  const duplicate = Buffer.from(prepared.bytes.toString('utf8').replace('"intent":', '"intent":"hidden", "intent":'));
  assert.deepEqual(await verifySkillPackage(duplicate, hash(duplicate)), { ok: false, reason: 'noncanonical-package' });
  const dangerous = Buffer.from(prepared.bytes.toString('utf8').replace('"trim-text"', '"network"'));
  assert.deepEqual(await verifySkillPackage(dangerous, hash(dangerous)), { ok: false, reason: 'unsafe-capability' });
});

test('leaves the completed local deliverable intact when contribution is refused', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'km-skill-distill-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const localPath = join(dir, 'synthetic-local-deliverable.txt');
  const deliverable = 'Synthetic result containing internal project details.\n';
  await writeFile(localPath, deliverable);
  const result = await prepareSkillContribution(safeDraft(), {
    ...approvals,
    reviewProvenance: (request) => ({ ...approvedReview(request), confidentialKnowHow: 'present' }),
  });
  assert.deepEqual(result, { ok: false, reason: 'confidentiality-unverified' });
  assert.equal(await readFile(localPath, 'utf8'), deliverable);
});
