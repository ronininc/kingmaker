/**
 * Model condensation — tests. No I/O, no network.
 * Run: node test/model-condense.test.mjs
 *
 * Strategies come from the compute governor's metered doctrine (2026-11-14): resident,
 * metered-stream (inactive experts arrive as verified portions), the sandbox lane (Part C —
 * an over-memory active set executes locally, containerized and paged, when the device's
 * posture carries the sandbox), or escalate when the sandbox lane is absent or declined.
 * There are no tiers in a plan anymore.
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

// 2. 24GB: 42GB weights don't fit, ~12GB active set does → metered-stream, portions counted.
{
  const plan = condenseModel(moe, m5pro_24gb);
  assert.equal(plan.strategy, 'metered-stream');
  assert.equal(plan.tier, undefined, 'a plan carries no tier');
  assert.deepEqual(plan.residency.streamed, ['inactive experts (metered in as verified portions)']);
  assert.equal(plan.portions, Math.ceil(42e9 / 1_048_576), 'the full weights, counted in 1 MiB portions');
}

// 3. 8GB with no sandbox posture: even the active set exceeds the device's whole memory →
//    escalate, never refused — and the reason is the policy framing (the sandbox lane is the
//    local route past the device's memory, and it is absent here), not a device incapacity.
{
  const plan = condenseModel(moe, m3_8gb);
  assert.equal(plan.strategy, 'escalate');
  assert.match(plan.reason, /sandbox lane/);
  assert.match(plan.reason, /not refused for its size/);
  assert.doesNotMatch(plan.reason, /materializes|cannot execute locally/);
  assert.equal(plan.sandbox, null);
}

// 3b. The same MoE on the same 8GB device WITH the sandbox in its posture → the condensed
//     plan composes the sandbox lane: the working set resides inside the sandbox, inactive
//     experts meter into the sandbox store, and the concrete sandbox plan rides along.
{
  const plan = condenseModel(moe, { totalMemoryBytes: 8 * GB, sandbox: true });
  assert.equal(plan.strategy, 'sandbox');
  assert.equal(plan.residency.inSandbox, true);
  assert.deepEqual(plan.residency.streamed, ['inactive experts (metered in as verified portions into the sandbox model store)']);
  assert.equal(plan.sandbox.runner.image, 'ollama/ollama');
  assert.equal(plan.sandbox.paging.memoryBytes, 8 * GB);
  assert.equal(plan.sandbox.feed.portions, plan.portions, 'the condensed weights are the portions fed into the sandbox');
}

// 4. Small dense model on 8GB → resident.
{
  const plan = condenseModel(
    { id: 'small', denseParams: 3e9, expertParams: 0, totalExperts: 0, activeExperts: 0 },
    m3_8gb,
  );
  assert.equal(plan.strategy, 'resident');
  assert.equal(plan.quantization.experts, 'fp8');
  assert.deepEqual(plan.residency.streamed, []);
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

console.log('model-condense: 7/7 passed');
