/**
 * Compute governor — tests. Injected fakes; no I/O, no network.
 * Run: node test/compute-governor.test.mjs
 *
 * The governor under the metered doctrine (2026-11-14): it plans DELIVERY, it does not prohibit.
 * Device memory is measured (total, and free when known) — there are no tiers and no caps. A model
 * is resident when its weights fit the measured free memory, metered-stream in 1 MiB pin-verified
 * portions otherwise, and — Part C, owner ruling 2026-11-14 01:44 (no GGUF limit) — an active set
 * larger than the device's whole memory takes the SANDBOX lane (containerized, paged execution
 * under Kingmaker's Docker control) when the sandbox is in the device's posture. It escalates
 * only when the sandbox lane is absent or declined (or the device is unmeasured) — a policy
 * routing, never a refusal and never a device-incapacity claim.
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

// 1. Assessment is measurement only: total, and free when the probe knows it. No tier.
{
  const d = assessDevice(m3_8gb);
  assert.equal(d.totalBytes, 8 * GB);
  assert.equal(d.freeBytes, null);
  assert.equal(d.usableBytes, 8 * GB, 'unmeasured free memory plans against the total');
  assert.equal(d.tier, undefined, 'there is no tier anymore');
  const f = assessDevice({ totalMemoryBytes: 8 * GB, freeMemoryBytes: 5 * GB });
  assert.equal(f.usableBytes, 5 * GB, 'measured free memory is the planning figure');
}

// 2. Edge0 on the 8GB M3 → metered-stream: weights don't fit, the active set does.
//    This is the flagship-on-a-mini path.
{
  const plan = planLoad(edge0, m3_8gb);
  assert.equal(plan.strategy, 'metered-stream', 'Edge0 streams on 8GB — in verified portions, not refused');
  assert.equal(plan.portions, 23 * 1024, 'the 23 GB of weights are 23552 pin-verified 1 MiB portions');
  assert.equal(plan.portionBytes, 1_048_576);
}

// 3. Edge0 on 24GB → metered-stream with the active set comfortably inside the device.
{
  const plan = planLoad(edge0, m5pro_24gb);
  assert.equal(plan.strategy, 'metered-stream');
  assert.ok(
    plan.activeBytes + KV_HEADROOM_BYTES <= plan.usableBytes,
    'active set + KV headroom must fit',
  );
}

// 4. Small dense model (3GB) on 8GB → resident, no streaming needed.
{
  const plan = planLoad({ id: 'small', estimatedSizeBytes: 3 * GB }, m3_8gb);
  assert.equal(plan.strategy, 'resident');
}

// 5. 70B dense (40GB weights, no active set) on 8GB with no sandbox posture → escalate, and the
//    plan explains itself as a policy choice (the sandbox lane is absent), never a device
//    incapacity, and never a refusal for size.
{
  const plan = planLoad({ id: 'big', estimatedSizeBytes: 40 * GB }, m3_8gb);
  assert.equal(plan.strategy, 'escalate');
  assert.match(plan.reason, /sandbox lane/);
  assert.match(plan.reason, /absent from/);
  assert.match(plan.reason, /by policy this load escalates through the existing lanes/);
  assert.match(plan.reason, /not refused for its size/);
  assert.doesNotMatch(plan.reason, /materializes|cannot execute locally/);
}

// 5b. The same 70B dense on the same 8GB device WITH the sandbox in its posture → the sandbox
//     lane: a concrete local plan (runner image, memory ceiling + paging allowance, portion
//     feed), not an escalation.
{
  const plan = planLoad({ id: 'big', estimatedSizeBytes: 40 * GB }, { totalMemoryBytes: 8 * GB, sandbox: true });
  assert.equal(plan.strategy, 'sandbox');
  assert.equal(plan.sandbox.runner.image, 'ollama/ollama');
  assert.equal(plan.sandbox.runner.endpoint, 'http://127.0.0.1:11436');
  assert.equal(plan.sandbox.execution.type, 'docker-run');
  assert.equal(plan.sandbox.paging.memoryBytes, 8 * GB, 'the container ceiling is the device RAM');
  assert.equal(plan.sandbox.paging.swapAllowanceBytes, 40 * GB, 'the paging allowance is sized by the weights');
  assert.equal(plan.sandbox.paging.memorySwapBytes, 48 * GB);
  assert.equal(plan.sandbox.feed.portions, 40 * 1024);
  assert.equal(plan.sandbox.feed.verifiedBeforeStart, true);
  assert.equal(plan.portions, 40 * 1024);
}

// 5c. A declined sandbox posture still escalates — and says it was declined.
{
  const plan = planLoad({ id: 'big', estimatedSizeBytes: 40 * GB }, { totalMemoryBytes: 8 * GB, sandbox: { available: false, declined: true, reason: 'declined for this device (KINGMAKER_SANDBOX=off)' } });
  assert.equal(plan.strategy, 'escalate');
  assert.match(plan.reason, /declined in/);
  assert.match(plan.reason, /KINGMAKER_SANDBOX=off/);
}

// 6. Missing activeMemoryBytes → grades weight bytes, warns to measure; 23GB of weights on an 8GB
//    device escalates on the graded figure, with the warning attached.
{
  const plan = planLoad({ id: 'unmeasured', estimatedSizeBytes: 23 * GB }, m3_8gb);
  assert.equal(plan.strategy, 'escalate');
  assert.ok(
    plan.warnings.some((w) => w.includes('activeMemoryBytes')),
    'should warn that the active set is unmeasured',
  );
}

// 7. A streaming architecture is graded on its ACTIVE set: 23GB of weights with a 2.9GB active set
//    is a metered-stream plan on 8GB (test 2), never an escalation.
{
  const plan = planLoad(edge0, { totalMemoryBytes: 8 * GB, freeMemoryBytes: 1 * GB });
  assert.equal(plan.strategy, 'metered-stream', 'tight free memory changes the delivery, not the verdict');
}

// 8. governLoad audits the decision and returns it marked audited.
{
  const d = deps();
  const plan = planLoad(edge0, m5pro_24gb);
  const governed = governLoad(plan, edge0, d);
  assert.equal(governed.audited, true);
  assert.equal(governed.strategy, 'metered-stream');
  assert.equal(d.audit.length, 1);
  assert.equal(d.audit[0].type, 'compute-governor/load-decision');
  assert.equal(d.audit[0].candidateId, edge0.id);
  assert.equal(d.audit[0].strategy, 'metered-stream');
  assert.equal(d.audit[0].portions, 23 * 1024, 'the audit carries the portion count: metering is the record');
}

// 9. Unknown device memory → escalate, never a guess.
{
  const plan = planLoad(edge0, { totalMemoryBytes: 0 });
  assert.equal(plan.strategy, 'escalate');
  assert.match(plan.reason, /unmeasured device/);
}

// 10. governLoad audits a sandbox decision with the sandbox plan attached, and assessDevice
//     carries the normalized posture.
{
  const d = deps();
  const device = assessDevice({ totalMemoryBytes: 8 * GB, sandbox: true });
  assert.equal(device.sandbox.available, true);
  const plan = planLoad({ id: 'big', estimatedSizeBytes: 40 * GB }, { totalMemoryBytes: 8 * GB, sandbox: true });
  const governed = governLoad(plan, { id: 'big' }, d);
  assert.equal(governed.strategy, 'sandbox');
  assert.equal(d.audit[0].strategy, 'sandbox');
  assert.equal(d.audit[0].sandbox.runner.image, 'ollama/ollama', 'the audit records the concrete sandbox plan');
  const absent = assessDevice(m3_8gb);
  assert.equal(absent.sandbox.available, false, 'no posture declared: the lane is absent, with its reason');
  assert.match(absent.sandbox.reason, /no sandbox posture/);
}

console.log('compute-governor: 11/11 passed');
