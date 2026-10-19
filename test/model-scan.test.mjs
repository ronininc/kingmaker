/**
 * Stage 3 scan harness — tests. Injected fixtures; no I/O, no network.
 * PORTED from kingmaker-os (test/model-scan.test.ts) for the app.
 * Run: node test/model-scan.test.mjs
 */
import assert from 'node:assert/strict';
import {
  STANDARD_SANDBOX,
  runScan,
  signScanReport,
  verifySandbox,
} from '../lib/model-scan.mjs';

const FIXED_NOW = new Date('2026-10-18T15:30:00.000Z');
const LATER_NOW = new Date('2026-10-18T16:45:00.000Z');

function candidate() {
  return {
    id: 'hf:dealignai/DeepSeek-V4.1-Flash-1017-uncensored',
    name: 'dealignai/DeepSeek-V4.1-Flash-1017-uncensored',
    source: 'huggingface',
    sourceUrl: 'https://huggingface.co/dealignai/DeepSeek-V4.1-Flash-1017-uncensored',
    publisher: 'dealignai',
    publisherReputation: 'known',
    license: 'Apache-2.0',
    baseModel: 'DeepSeek-V4.1-Flash',
    method: 'uncensored-fp8',
    quant: 'FP8',
    claimedParamsB: 0,
    estimatedSizeBytes: 40 * 1024 ** 3,
    publishedHash: 'abc123',
    discoveredAt: '2026-10-18T00:00:00.000Z',
    notes: '',
  };
}

function triage() {
  return {
    candidateId: 'hf:dealignai/DeepSeek-V4.1-Flash-1017-uncensored',
    verdict: 'flag',
    findings: [],
    decidedAt: '2026-10-18T15:00:00.000Z',
  };
}

/** Healthy harness: every transport succeeds with fixed fixture data. */
function harness(overrides = {}) {
  return {
    hashWeights: async () => ({ sha256: 'pinned-sha256-of-weights', weightFiles: 12 }),
    runBenchmark: async (suite) => ({
      suite,
      suiteVersion: '1.0.0',
      score: 70,
      unit: 'percent',
      samples: 1000,
      notes: `fixture ${suite}`,
    }),
    probeBehavior: async (promptClass) => ({
      promptClass,
      behavior: 'complied',
      note: `fixture probe for ${promptClass}`,
    }),
    measurePerformance: async (tier) => ({
      tier,
      decodeTokPerSec: 42,
      prefillTokPerSec: 900,
      peakRamBytes: 3 * 1024 ** 3,
      contextTokens: 32768,
    }),
    getBestInClass: async (tier) => ({ id: `incumbent-${tier}`, score: 65 }),
    ...overrides,
  };
}

function opts(overrides = {}) {
  return {
    candidate: candidate(),
    triage: triage(),
    harness: harness(),
    modelRef: 'fixture/model',
    weightRef: 'fixture/weights',
    scannerId: 'scanner-fixture-01',
    benchmarkSuites: ['MMLU', 'HumanEval', 'GSM8K'],
    promptClasses: ['disallowed-instructions', 'sensitive-topics'],
    tiers: ['8gb', '16gb', '24gb'],
    now: FIXED_NOW,
    ...overrides,
  };
}

// 1. Integrity: pins the injected hash and weight-file count.
{
  const r = await runScan(opts());
  assert.equal(r.integrity.sha256, 'pinned-sha256-of-weights');
  assert.equal(r.integrity.pinned, true);
  assert.equal(r.integrity.weightFiles, 12);
  console.log('ok 1 - integrity pins the injected hash and weight-file count');
}

// 2. Integrity failure: sha256 empty, pinned false, error collected — scan continues.
{
  const r = await runScan(
    opts({
      harness: harness({
        hashWeights: async () => {
          throw new Error('weights not found');
        },
      }),
    }),
  );
  assert.equal(r.integrity.sha256, '');
  assert.equal(r.integrity.pinned, false);
  assert.equal(r.integrity.weightFiles, 0);
  const integrityErrors = r.errors.filter((e) => e.stage === 'integrity');
  assert.equal(integrityErrors.length, 1);
  assert.match(integrityErrors[0].message, /weights not found/);
  assert.equal(r.capability.length, 3);
  assert.equal(r.performance.length, 3);
  console.log('ok 2 - integrity failure is collected, scan continues');
}

// 3. Capability failure isolation: one failing suite does not kill the others.
{
  const r = await runScan(
    opts({
      harness: harness({
        runBenchmark: async (suite) => {
          if (suite === 'HumanEval') throw new Error('runner crashed');
          return {
            suite,
            suiteVersion: '1.0.0',
            score: 70,
            unit: 'percent',
            samples: 1000,
            notes: '',
          };
        },
      }),
    }),
  );
  assert.deepEqual(
    r.capability.map((b) => b.suite),
    ['MMLU', 'GSM8K'],
  );
  const capErrors = r.errors.filter((e) => e.stage === 'capability');
  assert.equal(capErrors.length, 1);
  assert.match(capErrors[0].message, /HumanEval/);
  assert.match(capErrors[0].message, /runner crashed/);
  console.log('ok 3 - failing benchmark suite is isolated, rest recorded');
}

const CMP_SUITES = ['MMLU', 'HumanEval'];
const CMP_TIERS = ['8gb', '16gb', '24gb'];

async function comparisonReport() {
  return runScan(
    opts({
      benchmarkSuites: CMP_SUITES,
      tiers: CMP_TIERS,
      harness: harness({
        runBenchmark: async (suite) => ({
          suite,
          suiteVersion: '1.0.0',
          score: 80, // candidateScore = benchmarkMean = 80
          unit: 'percent',
          samples: 1000,
          notes: '',
        }),
        getBestInClass: async (tier) => {
          if (tier === '8gb') return { id: 'incumbent-8gb', score: 75 }; // beats
          if (tier === '16gb') return { id: 'incumbent-16gb', score: 90 }; // not-beats
          return null; // empty tier
        },
      }),
    }),
  );
}

// 4. Comparison: beats when the candidate score strictly exceeds the incumbent.
{
  const r = await comparisonReport();
  const c = r.comparison.find((x) => x.tier === '8gb');
  assert.equal(c.beats, true);
  assert.equal(c.bestInClassId, 'incumbent-8gb');
  assert.equal(c.bestScore, 75);
  assert.equal(c.candidateScore, 80);
  assert.equal(c.metric, 'benchmark-mean');
  console.log('ok 4 - beats when candidate strictly exceeds incumbent');
}

// 5. Comparison: not-beats when the incumbent wins.
{
  const r = await comparisonReport();
  const c = r.comparison.find((x) => x.tier === '16gb');
  assert.equal(c.beats, false);
  assert.equal(c.bestInClassId, 'incumbent-16gb');
  assert.equal(c.candidateScore, 80);
  console.log('ok 5 - not-beats when incumbent wins');
}

// 6. Comparison: empty tier (null incumbent) → beats false, bestInClassId null.
{
  const r = await comparisonReport();
  const c = r.comparison.find((x) => x.tier === '24gb');
  assert.equal(c.bestInClassId, null);
  assert.equal(c.bestScore, null);
  assert.equal(c.beats, false);
  assert.equal(c.candidateScore, 80);
  console.log('ok 6 - empty tier is not a failure');
}

// 7. Comparison: best-in-class lookup failure collects an error and skips the tier.
{
  const r = await runScan(
    opts({
      tiers: CMP_TIERS,
      harness: harness({
        getBestInClass: async (tier) => {
          if (tier === '16gb') throw new Error('registry down');
          return { id: `incumbent-${tier}`, score: 65 };
        },
      }),
    }),
  );
  assert.deepEqual(
    r.comparison.map((c) => c.tier),
    ['8gb', '24gb'],
  );
  const cmpErrors = r.errors.filter((e) => e.stage === 'comparison');
  assert.equal(cmpErrors.length, 1);
  assert.match(cmpErrors[0].message, /16gb/);
  console.log('ok 7 - failed best-in-class lookup skips the tier');
}

// 8. Comparison: equal scores do not beat (strict comparison).
{
  const r = await runScan(
    opts({
      tiers: ['8gb'],
      harness: harness({
        runBenchmark: async (suite) => ({
          suite,
          suiteVersion: '1.0.0',
          score: 80,
          unit: 'percent',
          samples: 100,
          notes: '',
        }),
        getBestInClass: async () => ({ id: 'incumbent-8gb', score: 80 }),
      }),
    }),
  );
  assert.equal(r.comparison[0].beats, false);
  console.log('ok 8 - equal scores do not beat');
}

// 9. Safety: probes are recorded verbatim — behavior documented, never judged.
{
  const probeNotes = new Map([
    ['disallowed-instructions', 'produced instructions as requested'],
    ['sensitive-topics', 'refused the prompt'],
  ]);
  const r = await runScan(
    opts({
      harness: harness({
        probeBehavior: async (promptClass) => ({
          promptClass,
          behavior:
            promptClass === 'disallowed-instructions' ? 'complied' : 'refused',
          note: probeNotes.get(promptClass) ?? '',
        }),
      }),
    }),
  );
  assert.deepEqual(
    r.safety.map((p) => [p.promptClass, p.behavior, p.note]),
    [
      ['disallowed-instructions', 'complied', 'produced instructions as requested'],
      ['sensitive-topics', 'refused', 'refused the prompt'],
    ],
  );
  console.log('ok 9 - safety probes recorded verbatim, never judged');
}

// 10. Safety: a failing probe is collected, not thrown — the battery continues.
{
  const r = await runScan(
    opts({
      harness: harness({
        probeBehavior: async (promptClass) => {
          if (promptClass === 'disallowed-instructions') throw new Error('timeout');
          return { promptClass, behavior: 'refused', note: 'fixture' };
        },
      }),
    }),
  );
  assert.equal(r.safety.length, 1);
  const safetyErrors = r.errors.filter((e) => e.stage === 'safety');
  assert.equal(safetyErrors.length, 1);
  assert.match(safetyErrors[0].message, /disallowed-instructions/);
  console.log('ok 10 - failing probe is collected, battery continues');
}

// 11. Performance failure isolation: a failing tier does not kill the others.
{
  const r = await runScan(
    opts({
      harness: harness({
        measurePerformance: async (tier) => {
          if (tier === '16gb') throw new Error('out of memory');
          return {
            tier,
            decodeTokPerSec: 42,
            prefillTokPerSec: 900,
            peakRamBytes: 3 * 1024 ** 3,
            contextTokens: 32768,
          };
        },
      }),
    }),
  );
  assert.deepEqual(
    r.performance.map((p) => p.tier),
    ['8gb', '24gb'],
  );
  const perfErrors = r.errors.filter((e) => e.stage === 'performance');
  assert.equal(perfErrors.length, 1);
  assert.match(perfErrors[0].message, /16gb/);
  // Comparison follows the measured tiers only.
  assert.deepEqual(
    r.comparison.map((c) => c.tier),
    ['8gb', '24gb'],
  );
  console.log('ok 11 - failing performance tier is isolated');
}

// 12. Sandbox: the report carries the standard declaration and scanner metadata.
{
  const r = await runScan(opts());
  assert.deepEqual(r.sandbox, STANDARD_SANDBOX);
  assert.equal(r.scannerId, 'scanner-fixture-01');
  assert.equal(r.scannedAt, FIXED_NOW.toISOString());
  assert.equal(r.candidateId, candidate().id);
  assert.equal(r.triageVerdict, 'flag');
  console.log('ok 12 - report carries standard sandbox + scanner metadata');
}

// 13. verifySandbox: true for the standard declaration.
{
  assert.equal(verifySandbox(STANDARD_SANDBOX), true);
  console.log('ok 13 - verifySandbox accepts the standard declaration');
}

// 14. verifySandbox: false for a tampered declaration.
{
  const tampered = (patch) => ({ ...STANDARD_SANDBOX, ...patch });
  assert.equal(verifySandbox(tampered({ network: 'allowed' })), false);
  assert.equal(verifySandbox(tampered({ filesystem: 'read-write-everything' })), false);
  assert.equal(verifySandbox(tampered({ subprocess: 'unrestricted' })), false);
  console.log('ok 14 - verifySandbox rejects tampered declarations');
}

// 15. Signature: same inputs + same clock → identical digest.
{
  const a = await runScan(opts());
  const b = await runScan(opts());
  assert.equal(a.signature.algorithm, 'sha256-canonical-json');
  assert.equal(a.signature.signedBy, 'scanner-fixture-01');
  assert.equal(a.signature.signedAt, FIXED_NOW.toISOString());
  assert.equal(a.signature.digest, b.signature.digest);
  console.log('ok 15 - identical inputs + clock give identical digest');
}

// 16. Signature: different clock → different digest (scannedAt is signed).
{
  const a = await runScan(opts({ now: FIXED_NOW }));
  const b = await runScan(opts({ now: LATER_NOW }));
  assert.notEqual(a.signature.digest, b.signature.digest);
  console.log('ok 16 - different clock gives different digest');
}

// 17. Signature: signScanReport covers the report body, not the signature itself.
{
  const r = await runScan(opts());
  const { signature: _ignored, ...body } = r;
  const signed = signScanReport(body, 'scanner-fixture-01', FIXED_NOW);
  assert.equal(signed.digest, r.signature.digest);
  assert.equal(signed.algorithm, 'sha256-canonical-json');
  console.log('ok 17 - signature covers the body, not itself');
}

// 18. Determinism: two identical runs yield deeply equal reports.
{
  const a = await runScan(opts());
  const b = await runScan(opts());
  assert.deepEqual(a, b);
  console.log('ok 18 - identical runs are deeply equal');
}

// 19. Determinism: no errors on the healthy path.
{
  const r = await runScan(opts());
  assert.deepEqual(r.errors, []);
  assert.equal(r.capability.length, 3);
  assert.equal(r.safety.length, 2);
  assert.equal(r.performance.length, 3);
  assert.equal(r.comparison.length, 3);
  console.log('ok 19 - healthy path has no errors');
}

console.log('\n19/19 model-scan tests pass');
