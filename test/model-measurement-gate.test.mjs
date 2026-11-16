import test from 'node:test';
import assert from 'node:assert/strict';
import { firstRunModelPlan, GRANITE_8GB } from '../lib/mac-profiles.mjs';
const device = { os: 'darwin', arch: 'arm64', cores: 8, ramGb: 8, freeDiskGb: 15, gpu: { kind: 'apple-unified', chip: 'M' } };
const installed = ['qwen3.5:4b', GRANITE_8GB, 'huihui_ai/qwen3-abliterated:1.7b'];
test('installing a bigger model does not make it the default without a passing device measurement', () => {
  assert.equal(firstRunModelPlan(device, { installed, measurements: {} }).use.tag, GRANITE_8GB);
  const fail = firstRunModelPlan(device, { installed, measurements: { 'qwen3.5:4b': { pass: false, note: 'swapped' } } });
  assert.equal(fail.use.tag, GRANITE_8GB);
  assert.ok(fail.why.some((w) => /not the default until measured.*FAIL — swapped/.test(w)));
  assert.equal(firstRunModelPlan(device, { installed, measurements: { 'qwen3.5:4b': { pass: true } } }).use.tag, 'qwen3.5:4b');
});
test('legacy callers (no measurements argument) keep the size-based pick', () => {
  assert.equal(firstRunModelPlan(device, { installed }).use.tag, 'qwen3.5:4b');
});
