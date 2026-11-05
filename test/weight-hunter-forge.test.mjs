import assert from 'node:assert/strict';
import test from 'node:test';

import { donorCompatibility, forgeCandidate, planForge } from '../lib/weight-hunter-forge.mjs';

const hash = (character) => character.repeat(64);
const qwen = {
  id: 'qwen3.8-27b-abliterated', sha256: hash('a'), baseModel: 'qwen/qwen3.8-27b', license: 'apache-2.0',
  architecture: { family: 'qwen3.8', hiddenSize: 5120, layers: 64, expertSize: 2048 },
  tokenizer: { sha256: hash('b') }, contributions: ['tool use', 'coding'],
};
const deepseek = {
  id: 'deepseek-v4.1-flash', sha256: hash('c'), baseModel: 'deepseek/v4.1-flash', license: 'mit',
  architecture: { family: 'deepseek-v4.1', hiddenSize: 7168, layers: 61, expertSize: 2048 },
  tokenizer: { sha256: hash('d') }, contributions: ['reasoning', 'long context'],
};

test('incompatible Qwen and DeepSeek donors become teachers for a genuinely new model', () => {
  const compatibility = donorCompatibility(qwen, deepseek);
  assert.equal(compatibility.taskVector, false);
  assert.equal(compatibility.expertGraft, false);
  assert.equal(compatibility.distill, true);
  const plan = planForge({
    task: 'build a tool-using long-context research brain', donors: [qwen, deepseek],
    target: { family: 'kingmaker-moe-v1', parameterBudgetB: 32, license: 'LicenseRef-Ronin-Paid' },
  });
  assert.equal(plan.strategy, 'representation-graft');
  assert.ok(plan.stages.includes('learn-representation-projections'));
  assert.ok(plan.stages.includes('train-target'));
  assert.equal(plan.gates.publishOnlyIfBetterThanBestDonor, true);
  assert.match(plan.planHash, /^[a-f0-9]{64}$/);
});

test('unsafe raw weight merge is refused when donor fingerprints differ', () => {
  assert.throws(() => planForge({
    task: 'merge', donors: [qwen, deepseek], strategy: 'task-vector-merge',
    target: { family: 'kingmaker-moe-v1', parameterBudgetB: 32, license: 'LicenseRef-Ronin-Paid' },
  }), /incompatible/);
});

test('completed weights remain review-held with donor provenance', () => {
  const plan = planForge({
    task: 'research', donors: [qwen, deepseek], strategy: 'distill',
    target: { family: 'kingmaker-student-v1', parameterBudgetB: 14, license: 'LicenseRef-Ronin-Paid' },
  });
  const candidate = forgeCandidate(plan, {
    id: 'kingmaker-research-14b-v1', weightSha256: hash('e'), evaluationSha256: hash('f'), trainingReceiptSha256: hash('1'),
  });
  assert.equal(candidate.state, 'awaiting-owner-approval');
  assert.deepEqual(candidate.donorHashes, [hash('a'), hash('c')]);
});
