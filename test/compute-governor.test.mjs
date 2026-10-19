/**
 * Compute governor — tests. Injected fakes; no I/O, no network.
 * Run: node test/compute-governor.test.mjs
 */
import assert from 'node:assert';
import {
  assessDevice,
  planLoad,
  governLoad,
  KV_HEADROOM_BYTES,
} from '../lib/compute-governor.mjs';

const GB = 1024 ** 3;

function deps() {
  const audit = [];
  return {
    audit,
    appendAudit: (e) => audit.push(e),
    now: () => '2026-10-18T19:00:00.000Z',
  };
}

// Edge0-35B: 23GB weights, 2.9GB active set.
const edge0 = {
  id: 'edge0-35b-a3b-preview',
  estimatedSizeBytes: 23 * GB,
  activeMemoryBytes: 2.9 * GB,
};

const m3_8gb = { totalMemoryBytes: 8 * GB };
const m5pro_24gb = { totalMemoryBytes: 24 * GB };

// 1. 8GB M3 assesses to the 8gb tier with a 5GB usable budget.
{
  const d = assessDevice(m3_8gb);
  assert.equal(d.tier, '8gb');
  assert.equal(d.usableBytes, 5 * GB);
}

// 2. 24GB M5 Pro assesses to the 24gb tier with a 16GB usable budget.
{
  const d = assessDevice(m5pro_24gb);
  assert.equal(d.tier, '24gb');
  assert.equal(d.usableBytes, 16 * GB);
}

// 3. Edge0 on the 8GB M3 → stream: weights don't fit, active set does.
//    This is the flagship-on-a-mini path.
{
  const plan = planLoad(edge0, m3_8gb);
  assert.equal(plan.strategy, 'stream', 'Edge0 should stream on 8GB');
  assert.equal(plan.tier, '8gb');
  assert.ok(plan.warnings.length > 0, '8gb streaming should warn on throughput');
}

// 4. Edge0 on 24GB → stream with comfortable headroom, no thin warning.
{
  const plan = planLoad(edge0, m5pro_24gb);
  assert.equal(plan.strategy, 'stream');
  assert.equal(plan.tier, '24gb');
  assert.ok(
    plan.activeBytes + KV_HEADROOM_BYTES <= plan.usableBytes,
    'active set + KV headroom must fit',
  );
}

// 5. Small dense model (3GB) on 8GB → resident, no streaming needed.
{
  const plan = planLoad({ id: 'small', estimatedSizeBytes: 3 * GB }, m3_8gb);
  assert.equal(plan.strategy, 'resident');
}

// 6. 70B dense (40GB weights, no active set) on 8GB → refused.
{
  const plan = planLoad({ id: 'big', estimatedSizeBytes: 40 * GB }, m3_8gb);
  assert.equal(plan.strategy, 'refused');
}

// 7. Missing activeMemoryBytes → grades weight bytes, warns to measure.
{
  const plan = planLoad({ id: 'unmeasured', estimatedSizeBytes: 23 * GB }, m3_8gb);
  assert.equal(plan.strategy, 'refused', '23GB weights grade as refused without an active set');
  assert.ok(
    plan.warnings.some((w) => w.includes('activeMemoryBytes')),
    'should warn that the active set is unmeasured',
  );
}

// 8. governLoad audits the decision and returns it marked audited.
{
  const d = deps();
  const plan = planLoad(edge0, m5pro_24gb);
  const governed = governLoad(plan, edge0, d);
  assert.equal(governed.audited, true);
  assert.equal(governed.strategy, 'stream');
  assert.equal(d.audit.length, 1);
  assert.equal(d.audit[0].type, 'compute-governor/load-decision');
  assert.equal(d.audit[0].candidateId, edge0.id);
  assert.equal(d.audit[0].strategy, 'stream');
}

// 9. Unknown device memory → refused, never a guess.
{
  const plan = planLoad(edge0, { totalMemoryBytes: 0 });
  assert.equal(plan.strategy, 'refused');
  assert.equal(plan.tier, null);
}

console.log('compute-governor: 9/9 passed');
