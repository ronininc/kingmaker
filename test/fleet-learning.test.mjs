/**
 * Stage 7 fleet learning — tests. The diode is one-way: envelopes can never
 * carry customer data (contract-level false plus runtime defense in depth).
 * Aggregation is pure and deterministic.
 * PORTED from kingmaker-os (test/fleet-learning.test.ts) for the app.
 * Run: node test/fleet-learning.test.mjs
 */
import assert from 'node:assert/strict';
import {
  aggregateReports,
  sealEnvelope,
  validateEnvelope,
} from '../lib/fleet-learning.mjs';

const FIXED_NOW = new Date('2026-10-18T15:30:00.000Z');
const MODEL_ID = 'hf:dealignai/DeepSeek-V4.1-Flash-1017-uncensored';

function report(overrides = {}) {
  return {
    modelId: MODEL_ID,
    sessionNonce: 'nonce-1',
    decodeTokPerSec: 42.5,
    peakRamBytes: 8 * 1024 ** 3,
    failureModes: [],
    skillPairs: [],
    satisfaction: 'unrated',
    observedAt: '2026-10-18T12:00:00.000Z',
    ...overrides,
  };
}

// 1. sealEnvelope hardcodes customerDataIncluded to false.
{
  const env = sealEnvelope(report(), FIXED_NOW);
  assert.equal(env.customerDataIncluded, false);
  assert.equal(env.sentAt, FIXED_NOW.toISOString());
  assert.deepEqual(env.payload, report());
  console.log('ok 1 - sealed envelope hardcodes customerDataIncluded false');
}

// 2. sealEnvelope is deterministic for the same clock.
{
  assert.deepEqual(
    sealEnvelope(report(), FIXED_NOW),
    sealEnvelope(report(), FIXED_NOW),
  );
  console.log('ok 2 - sealing is deterministic for the same clock');
}

// 3. validateEnvelope accepts a sealed envelope.
{
  const env = sealEnvelope(report(), FIXED_NOW);
  const v = validateEnvelope(env);
  assert.equal(v.valid, true);
  assert.match(v.reason, /diode intact/);
  console.log('ok 3 - sealed envelope validates');
}

// 4. validateEnvelope rejects an envelope with customerDataIncluded true.
{
  const env = sealEnvelope(report(), FIXED_NOW);
  const poisoned = { ...env, customerDataIncluded: true };
  const v = validateEnvelope(poisoned);
  assert.equal(v.valid, false);
  assert.match(v.reason, /diode violation/);
  console.log('ok 4 - poisoned envelope rejected (diode violation)');
}

// 5. validateEnvelope rejects an empty modelId.
{
  const env = sealEnvelope(report({ modelId: '   ' }), FIXED_NOW);
  const v = validateEnvelope(env);
  assert.equal(v.valid, false);
  assert.match(v.reason, /modelId/);
  console.log('ok 5 - empty modelId rejected');
}

// 6. Aggregation counts failure modes, skill pairs, and satisfaction.
{
  const intel = aggregateReports(MODEL_ID, [
    report({
      failureModes: ['oom', 'decode-stall'],
      skillPairs: [['summarize', 'search']],
      satisfaction: 'up',
    }),
    report({
      failureModes: ['oom'],
      skillPairs: [
        ['search', 'summarize'],
        ['code', 'search'],
      ],
      satisfaction: 'down',
    }),
    report({ failureModes: [], skillPairs: [], satisfaction: 'unrated' }),
  ]);
  assert.equal(intel.modelId, MODEL_ID);
  assert.equal(intel.sampleCount, 3);
  assert.deepEqual(intel.failureModeCounts, { oom: 2, 'decode-stall': 1 });
  // skill pairs keyed sorted: ['search','summarize'] -> 'search+summarize'
  assert.deepEqual(intel.skillPairCounts, {
    'search+summarize': 2,
    'code+search': 1,
  });
  assert.deepEqual(intel.satisfaction, { up: 1, down: 1, unrated: 1 });
  console.log('ok 6 - failure modes, skill pairs, satisfaction counted');
}

// 7. Median tok/s is correct over non-null samples.
{
  const intel = aggregateReports(MODEL_ID, [
    report({ decodeTokPerSec: 30 }),
    report({ decodeTokPerSec: null }),
    report({ decodeTokPerSec: 50 }),
    report({ decodeTokPerSec: 40 }),
  ]);
  assert.equal(intel.medianDecodeTokPerSec, 40);
  console.log('ok 7 - median over non-null samples');
}

// 8. Median handles an even count by averaging the middle two.
{
  const intel = aggregateReports(MODEL_ID, [
    report({ decodeTokPerSec: 10 }),
    report({ decodeTokPerSec: 30 }),
  ]);
  assert.equal(intel.medianDecodeTokPerSec, 20);
  console.log('ok 8 - even-count median averages the middle two');
}

// 9. Empty input yields sampleCount 0 and null median.
{
  const intel = aggregateReports(MODEL_ID, []);
  assert.equal(intel.sampleCount, 0);
  assert.equal(intel.medianDecodeTokPerSec, null);
  assert.deepEqual(intel.failureModeCounts, {});
  assert.deepEqual(intel.skillPairCounts, {});
  assert.deepEqual(intel.satisfaction, { up: 0, down: 0, unrated: 0 });
  console.log('ok 9 - empty input gives zero counts and null median');
}

// 10. Deterministic: deepEqual across calls and across report order.
{
  const reports = [
    report({ sessionNonce: 'a', decodeTokPerSec: 30, satisfaction: 'up' }),
    report({
      sessionNonce: 'b',
      decodeTokPerSec: 50,
      failureModes: ['oom'],
      skillPairs: [['code', 'search']],
      satisfaction: 'down',
    }),
  ];
  assert.deepEqual(
    aggregateReports(MODEL_ID, reports),
    aggregateReports(MODEL_ID, reports),
  );
  assert.deepEqual(
    aggregateReports(MODEL_ID, reports),
    aggregateReports(MODEL_ID, [...reports].reverse()),
  );
  console.log('ok 10 - aggregation is order-insensitive');
}

// 11. Ignores non-finite tok/s samples.
{
  const intel = aggregateReports(MODEL_ID, [
    report({ decodeTokPerSec: Number.NaN }),
    report({ decodeTokPerSec: 60 }),
  ]);
  assert.equal(intel.medianDecodeTokPerSec, 60);
  assert.equal(intel.sampleCount, 2);
  console.log('ok 11 - non-finite tok/s samples ignored');
}

console.log('\n11/11 fleet-learning tests pass');
