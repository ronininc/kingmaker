// Hash-addressed task runtimes assembled from paid Brain Library components. Tools never gain ambient authority from
// one another: Kingmaker's broker carries shared task state and re-checks each invocation. A runtime may also serve as
// the teacher harness for a Weight Hunter forge plan.
import { canonicalJson, sha256Hex } from './hash-util.mjs';
import { selectWeightHunterReferences } from './weight-hunter-references.mjs';

const HASH = /^[a-f0-9]{64}$/;

export function verifyComponentPins(components, launcherPins) {
  for (const component of components) {
    if (!component?.id || !HASH.test(component.sha256 || '')) throw new Error('component manifest is missing its id or sha256');
    if (launcherPins.get(component.id) !== component.sha256) throw new Error(`launcher pin mismatch for ${component.id}`);
    for (const shard of component.shards || []) {
      if (!shard.url || !HASH.test(shard.sha256 || '') || !Number.isInteger(shard.size) || shard.size <= 0) throw new Error(`invalid stream shard for ${component.id}`);
    }
  }
  return true;
}

export function planTaskRuntime({ task, components, launcherPins, allowedCapabilities = [], forgePlan = null }) {
  const request = String(task || '').trim();
  if (!request) throw new Error('task runtime needs a task');
  if (!Array.isArray(components) || !components.length) throw new Error('task runtime needs components');
  verifyComponentPins(components, launcherPins);
  const allowed = new Set(allowedCapabilities);
  const planned = components.map((component) => {
    const requested = component.capabilities || [];
    const granted = requested.filter((capability) => allowed.has(capability));
    return {
      id: component.id, kind: component.kind, sha256: component.sha256,
      role: component.role || null, grantedCapabilities: granted,
      deniedCapabilities: requested.filter((capability) => !allowed.has(capability)),
      stream: (component.shards || []).map((shard) => ({ url: shard.url, sha256: shard.sha256, size: shard.size, onDemand: true })),
    };
  });
  const body = {
    schema: 'kingmaker.capability-runtime/1', task: request,
    referenceContext: selectWeightHunterReferences({ task: request, forModelCandidate: Boolean(forgePlan) }),
    components: planned,
    broker: {
      sharedTaskState: true,
      directComponentInvocation: false,
      reauthorizeEveryToolCall: true,
      oneKingmakerResult: true,
    },
    evolution: forgePlan ? { mode: 'composite-teacher-harness', forgePlanHash: forgePlan.planHash } : { mode: 'runtime-only' },
  };
  return { ...body, runtimeHash: sha256Hex(canonicalJson(body)) };
}
