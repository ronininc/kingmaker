/**
 * Graceful degradation — tests. Injected fakes; no I/O, no network.
 * Run: node test/runtime-degrade.test.mjs
 */
import assert from 'node:assert';
import { isResourceExhaustion, attemptWithFallback } from '../lib/runtime-degrade.mjs';

function deps() {
  const audit = [];
  return {
    audit,
    appendAudit: (e) => audit.push(e),
    now: () => '2026-10-18T20:00:00.000Z',
  };
}

const tiers = [{ name: 'full' }, { name: 'lite' }, { name: 'tiny' }];
const ok = (result) => () => ({ ok: true, result });
const fail = (code, message) => () => ({ ok: false, failure: { code, message } });

// 1. First tier succeeds → no degradation.
{
  const d = deps();
  const r = attemptWithFallback({ tiers, run: ok('done'), deps: d });
  assert.equal(r.ok, true);
  assert.equal(r.tierUsed, 'full');
  assert.equal(r.degraded, false);
  assert.equal(r.attempts.length, 1);
  assert.equal(d.audit[0].type, 'degrade/settled');
}

// 2. OOM on full → falls back to lite, marked degraded.
{
  const d = deps();
  const calls = [];
  const run = (tier) => {
    calls.push(tier.name);
    return tier.name === 'full'
      ? { ok: false, failure: { code: 'oom', message: 'out of memory' } }
      : { ok: true, result: 'lite-done' };
  };
  const r = attemptWithFallback({ tiers, run, deps: d });
  assert.equal(r.ok, true);
  assert.equal(r.tierUsed, 'lite');
  assert.equal(r.degraded, true);
  assert.deepEqual(calls, ['full', 'lite']);
}

// 3. All tiers OOM → exhausted, honest failure.
{
  const d = deps();
  const r = attemptWithFallback({ tiers, run: fail('out-of-memory', 'OOM'), deps: d });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'all tiers resource-exhausted');
  assert.equal(r.attempts.length, 3);
  assert.equal(d.audit[d.audit.length - 1].type, 'degrade/exhausted');
}

// 4. Logic error → propagates, NEVER falls back to a dumber tier.
{
  const d = deps();
  const calls = [];
  const run = (tier) => {
    calls.push(tier.name);
    return { ok: false, failure: { code: 'bad-request', message: 'invalid input' } };
  };
  const r = attemptWithFallback({ tiers, run, deps: d });
  assert.equal(r.ok, false);
  assert.equal(calls.length, 1, 'must not try lite after a logic error');
  assert.equal(r.reason, 'non-resource failure — not degraded, propagated');
}

// 5. Thrown OOM → classified as resource exhaustion, falls back.
{
  const d = deps();
  const run = (tier) => {
    if (tier.name === 'full') throw new Error('out of memory allocating experts');
    return { ok: true, result: 'recovered' };
  };
  const r = attemptWithFallback({ tiers, run, deps: d });
  assert.equal(r.ok, true);
  assert.equal(r.tierUsed, 'lite');
  assert.equal(r.degraded, true);
}

// 6. isResourceExhaustion classification.
{
  assert.equal(isResourceExhaustion({ code: 'oom' }), true);
  assert.equal(isResourceExhaustion({ code: 'timeout' }), true);
  assert.equal(isResourceExhaustion({ message: 'CUDA out of memory' }), true);
  assert.equal(isResourceExhaustion({ code: 'bad-request', message: 'invalid' }), false);
  assert.equal(isResourceExhaustion(null), false);
}

console.log('runtime-degrade: 6/6 passed');
