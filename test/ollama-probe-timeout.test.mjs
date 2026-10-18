import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { OLLAMA_PROBE_TIMEOUT_MS } from '../lib/cli.mjs';

// From a recurring failure (doctor.ollama-probe.timeout, 3× in a week, up to 6100 ms) and the fleet's
// darwin-arm64-8gb baseline (p95 6000 ms over 3 instances).
test('the doctor waits long enough for Ollama on a swapping 8 GB Mac, and no longer than 30 s', () => {
  assert.ok(OLLAMA_PROBE_TIMEOUT_MS >= 6100, 'covers the slowest answer seen here and the fleet p95');
  assert.ok(OLLAMA_PROBE_TIMEOUT_MS <= 30_000, 'a really dead Ollama still fails fast');
});

test('both Ollama probes use the named timeout', () => {
  const probes = readFileSync(new URL('../lib/cli.mjs', import.meta.url), 'utf8').split('\n').filter((l) => l.includes('11434/api/tags'));
  assert.equal(probes.length, 2);
  assert.ok(probes.every((l) => l.includes('AbortSignal.timeout(OLLAMA_PROBE_TIMEOUT_MS)')));
});
