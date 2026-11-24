import assert from 'node:assert/strict';
import test from 'node:test';
import { assessPairedBench, parseJsonl } from '../lib/paired-bench-outcome.mjs';

const rows = Array.from({ length: 6 }, (_, step) => step % 2 === 0 ? {
  step, arm: 'median', model: 'median:1.7b', elapsed_s: 1, peak_memory_mb: 1600,
  swap_delta_mb: 0, model_calls: 1, response: 'grounded answer', loaded_after: ['median:1.7b'],
} : {
  step, arm: 'jev', model: 'open-jev:q4', elapsed_s: 2, peak_memory_mb: 2100,
  swap_delta_mb: 1, model_calls: 2, score: 0.73, scored_through_head: true,
  loaded_after: ['open-jev:q4'],
});

test('accepts six alternating successful turns and totals child calls', () => {
  const result = assessPairedBench(rows, { expectedMedian: 'median:1.7b', expectedJev: 'open-jev:q4' });
  assert.equal(result.pass, true);
  assert.equal(result.totals.modelCalls, 9);
});

test('fails a status-only JEV result without a numeric head score', () => {
  const bad = structuredClone(rows);
  delete bad[1].score;
  bad[1].status = 'PASS';
  const result = assessPairedBench(bad);
  assert.equal(result.pass, false);
  assert.match(result.failures.join('\n'), /numeric JEV head score missing/);
});

test('fails errors, missing telemetry, and bad alternation', () => {
  const bad = structuredClone(rows);
  bad[0].arm = 'jev'; bad[2].error = 'HTTP 500'; delete bad[4].loaded_after;
  const result = assessPairedBench(bad);
  assert.equal(result.pass, false);
  assert.match(result.failures.join('\n'), /expected median arm/);
  assert.match(result.failures.join('\n'), /HTTP 500/);
  assert.match(result.failures.join('\n'), /loaded_after inventory missing/);
  assert.equal(assessPairedBench(bad.slice(0, 5)).pass, false);
});

test('parses JSONL and names malformed rows', () => {
  assert.deepEqual(parseJsonl('{"a":1}\n\n{"b":2}\n'), [{ a: 1 }, { b: 2 }]);
  assert.throws(() => parseJsonl('{"a":1}\nnope'), /row 2/);
});

test('the real runner carries a disk safety gate and ephemeral JEV residency', async () => {
  const source = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('../scripts/run-8gb-pair.mjs', import.meta.url), 'utf8'));
  assert.match(source, /disk safety gate/);
  assert.match(source, /ephemeral: true/);
});
