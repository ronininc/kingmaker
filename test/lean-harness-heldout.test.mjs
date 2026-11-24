import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runLeanHarness } from '../lib/lean-harness.mjs';

const cases = JSON.parse(await readFile(new URL('./fixtures/lean-harness-heldout.json', import.meta.url)));
const task = (entry) => ({
  intent: entry.lane === 'known' ? 'heldout-known' : `heldout-${entry.lane}`,
  inputReferences: [`fixture:${entry.id}`], permittedWrites: ['artifact.txt'],
  expectedOutput: { kind: 'text', path: 'artifact.txt' }, acceptanceChecks: ['exact-content'],
  budget: { maxSteps: 3, maxObservations: 1, maxRepairs: 1, deadlineMs: 5000 },
});
const verify = async ({ outputs }) => outputs.write?.text
  ? { ok: true, artifact: { text: outputs.write.text } }
  : { ok: false, reason: 'wrong-output' };

test('30 frozen held-out outcomes preserve completion and correct refusals', async () => {
  assert.equal(cases.length, 30);
  const outcomes = [];
  for (const entry of cases) {
    const known = entry.lane === 'known' ? [{
      intent: 'heldout-known', reviewed: true, digest: 'c'.repeat(64),
      run: async () => ({ ok: true, outputs: { write: { text: entry.input } }, metrics: { modelCalls: 0, toolCalls: 1 } }),
    }] : [];
    const result = await runLeanHarness(task(entry), {
      reviewedMethods: known,
      plan: known.length ? null : { steps: [{ id: 'write', operation: 'write', dependsOn: [], arguments: { input: entry.input } }] },
      operations: { write: async ({ arguments: args }) => {
        if (entry.lane === 'missing') return { status: 'failed', reason: 'missing-input' };
        if (entry.lane === 'decline') return { status: 'failed', reason: 'approval-declined' };
        if (entry.lane === 'observe' && !args.observed) return { status: 'unknown', observation: entry.id };
        return { status: 'completed', value: { text: args.input } };
      } },
      observe: async () => ({ progress: true, arguments: { observed: true } }), verify,
    });
    const actual = result.ok ? 'completed' : result.reason;
    outcomes.push({ id: entry.id, lane: entry.lane, actual, metrics: result.metrics ?? null });
    assert.equal(actual, entry.expect, entry.id);
    if (entry.lane === 'known') assert.equal(result.metrics.modelCalls, 0, entry.id);
  }
  assert.equal(outcomes.filter((row) => row.actual === 'completed').length, 26);
  assert.equal(outcomes.filter((row) => row.actual === 'missing-input').length, 2);
  assert.equal(outcomes.filter((row) => row.actual === 'approval-declined').length, 2);
});
