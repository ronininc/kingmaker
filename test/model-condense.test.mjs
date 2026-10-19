/**
 * Model condensation — tests. No I/O, no network.
 * Run: node test/model-condense.test.mjs
 */
import assert from 'node:assert';
import { condenseModel, QUANT_BYTES, DEFAULT_CONTEXT_TOKENS } from '../lib/model-condense.mjs';

const GB = 1024 ** 3;

// Synthetic MoE: 10B dense, 64 experts x 1B, 4 active, 1KB/tok KV.
const moe = {
  id: 'test-moe',
  denseParams: 10e9,
  expertParams: 1e9,
  totalExperts: 64,
  activeExperts: 4,
  kvBytesPerToken: 1024,
  contextTokens: 32768,
};

const m3_8gb = { totalMemoryBytes: 8 * GB };
const m5pro_24gb = { totalMemoryBytes: 24 * GB };

// 1. Memory math: FP8 dense (1B/param), MXFP4 experts (0.5B/param).
{
  const plan = condenseModel(moe, m5pro_24gb);
  assert.equal(plan.memory.denseBytes, 10e9);
  assert.equal(plan.memory.allExpertsBytes, 32e9); // 64 x 1B x 0.5
  assert.equal(plan.memory.activeExpertsBytes, 2e9); // 4 x 1B x 0.5
  assert.equal(plan.memory.kvBytes, 1024 * 32768);
  assert.equal(plan.memory.totalWeightBytes, 42e9);
  assert.equal(plan.quantization.dense, 'fp8');
  assert.equal(plan.quantization.experts, 'mxfp4');
}

// 2. 24GB: 42GB weights don't fit, ~12GB active set does → stream.
{
  const plan = condenseModel(moe, m5pro_24gb);
  assert.equal(plan.strategy, 'stream');
  assert.equal(plan.tier, '24gb');
  assert.deepEqual(plan.residency.streamed, ['inactive experts (SSD)']);
}

// 3. 8GB: even the active set exceeds budget → refused.
{
  const plan = condenseModel(moe, m3_8gb);
  assert.equal(plan.strategy, 'refused');
}

// 4. Small dense model on 8GB → resident.
{
  const plan = condenseModel(
    { id: 'small', denseParams: 3e9, expertParams: 0, totalExperts: 0, activeExperts: 0 },
    m3_8gb,
  );
  assert.equal(plan.strategy, 'resident');
  assert.equal(plan.quantization.experts, 'fp8');
}

// 5. Deterministic: same inputs → identical plan.
{
  const a = condenseModel(moe, m5pro_24gb);
  const b = condenseModel(moe, m5pro_24gb);
  assert.deepEqual(a, b);
}

// 6. Default context window applies when not specified.
{
  const plan = condenseModel({ ...moe, contextTokens: undefined }, m5pro_24gb);
  assert.equal(plan.memory.kvBytes, 1024 * DEFAULT_CONTEXT_TOKENS);
}

console.log('model-condense: 6/6 passed');
