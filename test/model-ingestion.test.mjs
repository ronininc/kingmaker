/**
 * Stage 5 ingestion — tests. The cage: nothing ingests without Robbie's valid
 * tap. The pin registry is the only I/O and it is mocked here.
 * PORTED from kingmaker-os (test/model-ingestion.test.ts) for the app.
 * Run: node test/model-ingestion.test.mjs
 */
import assert from 'node:assert/strict';
import {
  buildGatePacket,
} from '../lib/permission-gate.mjs';
import {
  STANDARD_SANDBOX,
} from '../lib/model-scan.mjs';
import {
  buildIngestionPlan,
  buildLibraryEntry,
  buildWeightsEntry,
  GateError,
  generateModelCard,
  ingest,
} from '../lib/model-ingestion.mjs';

const FIXED_NOW = new Date('2026-10-18T16:00:00.000Z');

const INTEGRITY_SHA256 =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function candidate(overrides = {}) {
  return {
    id: 'hf:dealignai/DeepSeek-V4.1-Flash-1017-uncensored',
    name: 'dealignai/DeepSeek-V4.1-Flash-1017-uncensored',
    source: 'huggingface',
    sourceUrl: 'https://huggingface.co/dealignai/DeepSeek-V4.1-Flash-1017-uncensored',
    publisher: 'dealignai',
    publisherReputation: 'known-good',
    license: 'Apache-2.0',
    baseModel: 'DeepSeek-V4.1-Flash',
    method: 'uncensored-fp8',
    quant: 'FP8',
    claimedParamsB: 0,
    estimatedSizeBytes: 20 * 1024 ** 3,
    publishedHash: INTEGRITY_SHA256,
    discoveredAt: '2026-10-18T00:00:00.000Z',
    notes: '',
    ...overrides,
  };
}

function scan(overrides = {}) {
  return {
    candidateId: 'hf:dealignai/DeepSeek-V4.1-Flash-1017-uncensored',
    triageVerdict: 'pass',
    integrity: { sha256: INTEGRITY_SHA256, pinned: false, weightFiles: 3 },
    capability: [
      {
        suite: 'MMLU',
        suiteVersion: '2024-11',
        score: 72.5,
        unit: 'accuracy',
        samples: 14042,
        notes: 'measured on flagship',
      },
      {
        suite: 'HumanEval',
        suiteVersion: '2023-07',
        score: 81.0,
        unit: 'pass@1',
        samples: 164,
        notes: 'measured on flagship',
      },
    ],
    safety: [
      {
        promptClass: 'disallowed-instructions',
        behavior: 'complied',
        note: 'answered the prompt in full',
      },
    ],
    performance: [
      {
        tier: '32gb',
        decodeTokPerSec: 45.2,
        prefillTokPerSec: 1200,
        peakRamBytes: 24 * 1024 ** 3,
        contextTokens: 32768,
      },
    ],
    comparison: [
      {
        tier: '32gb',
        bestInClassId: null,
        bestScore: null,
        candidateScore: 76.75,
        beats: true,
        metric: 'benchmark-mean',
      },
    ],
    errors: [],
    sandbox: STANDARD_SANDBOX,
    scannerId: 'flagship-scan-01',
    scannedAt: '2026-10-18T12:00:00.000Z',
    signature: {
      algorithm: 'sha256-canonical-json',
      digest: 'deadbeef',
      signedBy: 'scanner',
      signedAt: '2026-10-18T12:30:00.000Z',
    },
    ...overrides,
  };
}

function triage() {
  return {
    candidateId: 'hf:dealignai/DeepSeek-V4.1-Flash-1017-uncensored',
    verdict: 'pass',
    findings: [],
    decidedAt: '2026-10-18T06:00:00.000Z',
  };
}

function packetFor(c, s) {
  return buildGatePacket(c, triage(), s, FIXED_NOW);
}

function validApproval(p) {
  return {
    packetId: p.packetId,
    packetHash: p.packetHash,
    decision: 'approved',
    decidedBy: 'robbie',
    decidedAt: '2026-10-18T17:00:00.000Z',
    reason: '',
    signature: 'sig-robbie-tap-001',
  };
}

function registry() {
  const calls = [];
  return {
    calls,
    pin: async (candidateId, sha256) => {
      calls.push({ candidateId, sha256 });
      return {
        candidateId,
        sha256,
        pinnedAt: FIXED_NOW.toISOString(),
      };
    },
  };
}

const FILE_HASHES = {
  'model.safetensors': 'aaaa1111',
  'config.json': 'bbbb2222',
};

// 1. The cage refuses a tampered packet: hash mismatch → GateError.
{
  const c = candidate();
  const s = scan();
  const p = packetFor(c, s);
  const tampered = {
    ...p,
    flags: [...p.flags, 'injected by attacker'],
    // packetHash left alone — it no longer matches the packet body
  };
  const approval = validApproval(p);
  const reg = registry();
  await assert.rejects(
    () => ingest({ candidate: c, scan: s, packet: tampered, approval, registry: reg, fileHashes: FILE_HASHES, branch: 'ingest/x' }),
    (e) => {
      assert.ok(e instanceof GateError);
      assert.match(e.message, /ingestion refused: .*packet hash mismatch/);
      assert.match(e.message, /the cage holds/);
      return true;
    },
  );
  assert.equal(reg.calls.length, 0, 'registry must not be pinned on refusal');
  console.log('ok 1 - tampered packet refused, registry untouched');
}

// 2. The cage refuses when decidedBy is not robbie.
{
  const c = candidate();
  const s = scan();
  const p = packetFor(c, s);
  const forged = { ...validApproval(p), decidedBy: 'mallory' };
  await assert.rejects(
    () => ingest({ candidate: c, scan: s, packet: p, approval: forged, registry: registry(), fileHashes: FILE_HASHES, branch: 'ingest/x' }),
    (e) => {
      assert.ok(e instanceof GateError);
      assert.match(e.message, /only Robbie/);
      assert.match(e.message, /the cage holds/);
      return true;
    },
  );
  console.log('ok 2 - non-Robbie tap refused');
}

// 3. The cage refuses when the tap signature is missing.
{
  const c = candidate();
  const s = scan();
  const p = packetFor(c, s);
  const unsigned = { ...validApproval(p), signature: '   ' };
  await assert.rejects(
    () => ingest({ candidate: c, scan: s, packet: p, approval: unsigned, registry: registry(), fileHashes: FILE_HASHES, branch: 'ingest/x' }),
    (e) => {
      assert.ok(e instanceof GateError);
      assert.match(e.message, /missing tap signature/);
      return true;
    },
  );
  console.log('ok 3 - unsigned tap refused');
}

// 4. The cage refuses a rejection without a reason.
{
  const c = candidate();
  const s = scan();
  const p = packetFor(c, s);
  const bad = { ...validApproval(p), decision: 'rejected', reason: '  ' };
  await assert.rejects(
    () => ingest({ candidate: c, scan: s, packet: p, approval: bad, registry: registry(), fileHashes: FILE_HASHES, branch: 'ingest/x' }),
    (e) => {
      assert.ok(e instanceof GateError);
      assert.match(e.message, /a rejection needs a reason/);
      return true;
    },
  );
  console.log('ok 4 - reasonless rejection refused');
}

// 5. The cage refuses a rejection even when a reason is given.
{
  const c = candidate();
  const s = scan();
  const p = packetFor(c, s);
  const bad = { ...validApproval(p), decision: 'rejected', reason: 'not convinced by the benchmarks' };
  const reg = registry();
  await assert.rejects(
    () => ingest({ candidate: c, scan: s, packet: p, approval: bad, registry: reg, fileHashes: FILE_HASHES, branch: 'ingest/x' }),
    (e) => {
      assert.ok(e instanceof GateError);
      assert.match(e.message, /not approved/);
      return true;
    },
  );
  assert.equal(reg.calls.length, 0, 'registry must not be pinned on refusal');
  console.log('ok 5 - even a reasoned rejection ingests nothing');
}

// 6. Valid approval builds a complete plan and pins the integrity sha256.
{
  const c = candidate();
  const s = scan();
  const p = packetFor(c, s);
  const approval = validApproval(p);
  const reg = registry();
  const { plan, receipt } = await ingest({
    candidate: c,
    scan: s,
    packet: p,
    approval,
    registry: reg,
    fileHashes: FILE_HASHES,
    branch: 'ingest/dealignai-deepseek-v41-flash',
  });

  assert.deepEqual([...plan.steps], [
    'pin-registry',
    'library.json',
    'weights.json',
    'model-card',
    'commit',
  ]);

  assert.equal(plan.libraryEntry.id, c.id);
  assert.equal(plan.libraryEntry.approver, 'robbie');
  assert.equal(plan.libraryEntry.approvalSignature, 'sig-robbie-tap-001');
  assert.equal(plan.libraryEntry.gatePacketId, p.packetId);
  assert.equal(plan.libraryEntry.weightHash, INTEGRITY_SHA256);
  assert.equal(plan.libraryEntry.scanDate, s.scannedAt);
  assert.equal(plan.libraryEntry.tier, '32gb'); // 20 GiB → smallest fitting tier
  assert.deepEqual(
    plan.libraryEntry.benchmarks,
    [
      { suite: 'MMLU', score: 72.5 },
      { suite: 'HumanEval', score: 81.0 },
    ],
  );

  assert.equal(plan.weightsEntry.id, c.id);
  assert.equal(plan.weightsEntry.files.length, 2);
  assert.deepEqual(
    plan.weightsEntry.files.map((f) => f.sha256).sort(),
    ['aaaa1111', 'bbbb2222'],
  );
  for (const f of plan.weightsEntry.files) {
    assert.ok(f.url.includes('huggingface.co'));
  }

  assert.equal(plan.commit.repo, 'ronininc/kingmaker-brain-library');
  assert.equal(plan.commit.branch, 'ingest/dealignai-deepseek-v41-flash');
  assert.deepEqual(
    plan.commit.files.map((f) => f.path),
    [
      `library/models/${c.id}.json`,
      `library/weights/${c.id}.json`,
      `library/cards/${c.id}.md`,
    ],
  );

  assert.equal(reg.calls.length, 1);
  assert.deepEqual(reg.calls[0], {
    candidateId: c.id,
    sha256: INTEGRITY_SHA256,
  });

  assert.equal(receipt.candidateId, c.id);
  assert.equal(receipt.sha256, INTEGRITY_SHA256);
  assert.equal(receipt.pinnedAt, FIXED_NOW.toISOString());
  console.log('ok 6 - valid approval builds the full plan and pins the weight hash');
}

// 7. Model card contains benchmark scores and the approval signature.
{
  const c = candidate();
  const s = scan();
  const p = packetFor(c, s);
  const { plan } = await ingest({
    candidate: c,
    scan: s,
    packet: p,
    approval: validApproval(p),
    registry: registry(),
    fileHashes: FILE_HASHES,
    branch: 'ingest/x',
  });
  const card = plan.modelCard;
  assert.match(card, /# dealignai\/DeepSeek-V4\.1-Flash-1017-uncensored/);
  assert.match(card, /72\.5/);
  assert.match(card, /81/);
  assert.match(card, /MMLU/);
  assert.match(card, /sig-robbie-tap-001/);
  assert.match(card, /## Documented behaviors/);
  assert.match(card, /disallowed-instructions/);
  assert.match(card, /45\.2/);
  assert.ok(
    !/\b(dangerous|malicious|evil|unsafe|should not|must not)\b/i.test(card),
    'the card documents behaviors — it never moralizes',
  );
  console.log('ok 7 - model card documents measurements, never moralizes');
}

// 8. Commit message contains the signature, packet id, and candidate id.
{
  const c = candidate();
  const s = scan();
  const p = packetFor(c, s);
  const { plan } = await ingest({
    candidate: c,
    scan: s,
    packet: p,
    approval: validApproval(p),
    registry: registry(),
    fileHashes: FILE_HASHES,
    branch: 'ingest/x',
  });
  assert.match(plan.commit.message, /sig-robbie-tap-001/);
  assert.match(plan.commit.message, new RegExp(escapeRegExp(p.packetId)));
  assert.match(plan.commit.message, new RegExp(escapeRegExp(c.id)));
  console.log('ok 8 - commit message carries signature, packet id, candidate id');
}

// 9. Branch passes through to the commit.
{
  const c = candidate();
  const s = scan();
  const p = packetFor(c, s);
  const { plan } = await ingest({
    candidate: c,
    scan: s,
    packet: p,
    approval: validApproval(p),
    registry: registry(),
    fileHashes: FILE_HASHES,
    branch: 'ingest/very-custom-branch',
  });
  assert.equal(plan.commit.branch, 'ingest/very-custom-branch');
  console.log('ok 9 - branch passes through to the commit');
}

// 10. buildLibraryEntry derives the tier from estimatedSizeBytes.
{
  const c = candidate();
  const s = scan();
  const approval = validApproval(packetFor(c, s));
  assert.equal(buildLibraryEntry(c, s, approval).tier, '32gb');
  assert.equal(buildLibraryEntry(candidate({ estimatedSizeBytes: 4 * 1024 ** 3 }), s, approval).tier, '8gb');
  console.log('ok 10 - library entry tier derives from size');
}

// 11. buildLibraryEntry yields null tier when the model fits no tier.
{
  const c = candidate({ estimatedSizeBytes: 200 * 1024 ** 3 });
  const s = scan();
  const approval = validApproval(packetFor(c, s));
  assert.equal(buildLibraryEntry(c, s, approval).tier, null);
  console.log('ok 11 - null tier when the model fits nothing');
}

// 12. buildWeightsEntry sorts files by name for determinism.
{
  const c = candidate();
  const entry = buildWeightsEntry(c, { 'z.bin': 'zz', 'a.bin': 'aa' });
  assert.deepEqual(
    entry.files.map((f) => f.sha256),
    ['aa', 'zz'],
  );
  console.log('ok 12 - weights manifest sorts files by name');
}

// 13. buildIngestionPlan is deterministic.
{
  const c = candidate();
  const s = scan();
  const approval = validApproval(packetFor(c, s));
  const a = buildIngestionPlan(c, s, approval, FILE_HASHES, 'ingest/x');
  const b = buildIngestionPlan(c, s, approval, FILE_HASHES, 'ingest/x');
  assert.deepEqual(a, b);
  console.log('ok 13 - ingestion plan is deterministic');
}

// 14. generateModelCard handles empty measurements without inventing content.
{
  const c = candidate();
  const s = scan({ capability: [], performance: [], safety: [] });
  const approval = validApproval(packetFor(c, s));
  const entry = buildLibraryEntry(c, s, approval);
  const card = generateModelCard(entry, s);
  assert.match(card, /no benchmark results recorded/);
  assert.match(card, /no performance measurements recorded/);
  assert.match(card, /no safety probes recorded/);
  console.log('ok 14 - empty measurements render honestly, nothing invented');
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

console.log('\n14/14 model-ingestion tests pass');
