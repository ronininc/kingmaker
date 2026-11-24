import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boundTaskRecord, executeTypedPlan, runLeanHarness } from '../lib/lean-harness.mjs';

const task = (patch = {}) => ({
  intent: 'fixture-export', inputReferences: ['catalog-a.json'], permittedWrites: ['result.json'],
  expectedOutput: { kind: 'json', path: 'result.json' }, acceptanceChecks: ['exact-bytes', 'originals-unchanged'],
  budget: { maxSteps: 8, maxObservations: 1, maxRepairs: 1, deadlineMs: 5000 }, ...patch,
});
const verify = async ({ outputs }) => outputs.write?.ok
  ? { ok: true, artifact: outputs.write, receipt: { sha256: 'a'.repeat(64) } }
  : { ok: false, reason: 'wrong-output' };

test('bounds the task record and rejects unknown authority', () => {
  assert.equal(boundTaskRecord(task()).intent, 'fixture-export');
  assert.throws(() => boundTaskRecord({ ...task(), connector: 'admin' }), /unknown field/);
  assert.throws(() => boundTaskRecord(task({ budget: { ...task().budget, maxRepairs: 2 } })), /invalid budget/);
});

test('reviewed replay uses zero generation calls and learning cannot revoke delivery', async () => {
  const result = await runLeanHarness(task(), {
    reviewedMethods: [{ intent: 'fixture-export', reviewed: true, digest: 'b'.repeat(64), run: async () => ({ ok: true, outputs: { write: { ok: true, path: 'result.json' } }, metrics: { modelCalls: 0, toolCalls: 1 } }) }],
    verify, learn: async () => { throw new Error('collective unavailable'); },
  });
  assert.equal(result.ok, true); assert.equal(result.lane, 'reviewed-replay');
  assert.equal(result.metrics.modelCalls, 0); assert.equal(result.learning.ok, false);
  assert.equal(result.artifact.path, 'result.json');
});

test('known replay refuses a hidden generation call', async () => {
  const result = await runLeanHarness(task(), {
    reviewedMethods: [{ intent: 'fixture-export', reviewed: true, digest: 'b'.repeat(64), run: async () => ({ ok: true, outputs: {}, metrics: { modelCalls: 1 } }) }], verify,
  });
  assert.equal(result.reason, 'reviewed-replay-used-generation');
});

test('typed plan executes ready dependencies once and verifies the artifact', async () => {
  const order = [];
  const result = await executeTypedPlan({ steps: [
    { id: 'read', operation: 'read', dependsOn: [], arguments: { path: 'catalog-a.json' } },
    { id: 'write', operation: 'write', dependsOn: ['read'], arguments: { path: 'result.json' } },
  ] }, { task: task(), operations: {
    read: async () => { order.push('read'); return { status: 'completed', value: ['a'], receipt: { bytes: 3 } }; },
    write: async ({ dependencies }) => { order.push('write'); return { status: 'completed', value: { ok: dependencies.read[0] === 'a', path: 'result.json' } }; },
  }, verify });
  assert.equal(result.ok, true); assert.deepEqual(order, ['read', 'write']);
  assert.deepEqual(result.metrics, { modelCalls: 0, toolCalls: 2, observations: 0, repairs: 0 });
});

test('unknown state observes once and a failed step repairs only itself', async () => {
  const calls = { inspect: 0, write: 0 };
  const result = await executeTypedPlan({ steps: [
    { id: 'inspect', operation: 'inspect', dependsOn: [], arguments: {} },
    { id: 'write', operation: 'write', dependsOn: ['inspect'], arguments: { path: 'wrong' } },
  ] }, { task: task(), operations: {
    inspect: async ({ arguments: args }) => (++calls.inspect === 1 && !args.answer) ? { status: 'unknown', observation: 'location' } : { status: 'completed', value: args.answer },
    write: async ({ arguments: args }) => { calls.write++; return args.path === 'result.json' ? { status: 'completed', value: { ok: true, path: args.path } } : { status: 'failed', reason: 'bad-path' }; },
  }, observe: async () => ({ progress: true, arguments: { answer: 'north' } }), repair: async () => ({ arguments: { path: 'result.json' } }), verify });
  assert.equal(result.ok, true); assert.deepEqual(calls, { inspect: 2, write: 2 });
  assert.equal(result.metrics.observations, 1); assert.equal(result.metrics.repairs, 1);
});

test('permission, decline, missing input, no progress and repeated state stop honestly', async () => {
  for (const reason of ['permission-denied', 'approval-declined', 'missing-input']) {
    const result = await executeTypedPlan({ steps: [{ id: 'write', operation: 'write', dependsOn: [], arguments: {} }] }, {
      task: task(), operations: { write: async () => ({ status: 'failed', reason }) }, verify,
    });
    assert.equal(result.reason, reason);
  }
  const noProgress = await executeTypedPlan({ steps: [{ id: 'inspect', operation: 'inspect', dependsOn: [], arguments: {} }] }, {
    task: task(), operations: { inspect: async () => ({ status: 'unknown' }) }, observe: async () => ({ progress: false }), verify,
  });
  assert.equal(noProgress.reason, 'no-progress');
  const repeated = await executeTypedPlan({ steps: [{ id: 'write', operation: 'write', dependsOn: [], arguments: {} }] }, {
    task: task(), operations: { write: async () => ({ status: 'failed', reason: 'retry' }) }, repair: async () => ({ arguments: {} }), verify,
  });
  assert.equal(repeated.reason, 'repeated-state');
});

test('cycles, unsafe operations and false completion never deliver', async () => {
  const cycle = await executeTypedPlan({ steps: [
    { id: 'a', operation: 'read', dependsOn: ['b'], arguments: {} },
    { id: 'b', operation: 'read', dependsOn: ['a'], arguments: {} },
  ] }, { task: task(), operations: { read: async () => ({ status: 'completed' }) }, verify });
  assert.match(cycle.reason, /cycle/);
  const unsafe = await executeTypedPlan({ steps: [{ id: 'x', operation: 'shell', dependsOn: [], arguments: {} }] }, { task: task(), operations: {}, verify });
  assert.match(unsafe.reason, /not allowed/);
  const falseDone = await executeTypedPlan({ steps: [{ id: 'write', operation: 'write', dependsOn: [], arguments: {} }] }, {
    task: task(), operations: { write: async () => ({ status: 'completed', value: { ok: false } }) }, verify,
  });
  assert.equal(falseDone.reason, 'wrong-output');
});
