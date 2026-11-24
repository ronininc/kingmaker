import { createHash } from 'node:crypto';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const plain = (value) => value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const blocked = (reason, extra = {}) => ({ ok: false, status: 'blocked', reason, ...extra });

export function boundTaskRecord(input) {
  if (!plain(input)) throw new Error('task-record: plain record required');
  const allowed = ['intent', 'inputReferences', 'permittedWrites', 'expectedOutput', 'acceptanceChecks', 'budget'];
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new Error('task-record: unknown field');
  if (typeof input.intent !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/.test(input.intent)) throw new Error('task-record: invalid intent');
  for (const key of ['inputReferences', 'permittedWrites', 'acceptanceChecks']) {
    if (!Array.isArray(input[key]) || input[key].some((item) => typeof item !== 'string' || !item || item.length > 256)) throw new Error(`task-record: invalid ${key}`);
  }
  if (!plain(input.expectedOutput) || typeof input.expectedOutput.kind !== 'string') throw new Error('task-record: invalid expected output');
  const b = input.budget;
  if (!plain(b) || !Number.isInteger(b.maxSteps) || b.maxSteps < 1 || b.maxSteps > 64
      || !Number.isInteger(b.maxObservations) || b.maxObservations < 0 || b.maxObservations > 8
      || !Number.isInteger(b.maxRepairs) || b.maxRepairs < 0 || b.maxRepairs > 1
      || !Number.isFinite(b.deadlineMs) || b.deadlineMs < 1 || b.deadlineMs > 300_000) throw new Error('task-record: invalid budget');
  return Object.freeze({ ...input, inputReferences: Object.freeze([...input.inputReferences]), permittedWrites: Object.freeze([...input.permittedWrites]), expectedOutput: Object.freeze({ ...input.expectedOutput }), acceptanceChecks: Object.freeze([...input.acceptanceChecks]), budget: Object.freeze({ ...b }) });
}

function validatePlan(plan, operations, maxSteps) {
  if (!plain(plan) || !Array.isArray(plan.steps) || !plan.steps.length || plan.steps.length > maxSteps) throw new Error('plan: invalid steps');
  const ids = new Set();
  for (const step of plan.steps) {
    if (!plain(step) || typeof step.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(step.id) || ids.has(step.id)) throw new Error('plan: invalid step id');
    ids.add(step.id);
    if (!Object.hasOwn(operations, step.operation)) throw new Error(`plan: operation ${step.operation} is not allowed`);
    if (!Array.isArray(step.dependsOn) || step.dependsOn.some((id) => typeof id !== 'string') || !plain(step.arguments)) throw new Error('plan: invalid step');
  }
  for (const step of plan.steps) if (step.dependsOn.some((id) => !ids.has(id) || id === step.id)) throw new Error('plan: invalid dependency');
  const byId = new Map(plan.steps.map((step) => [step.id, step])), visiting = new Set(), visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) throw new Error('plan: dependency cycle');
    if (visited.has(id)) return;
    visiting.add(id); for (const dep of byId.get(id).dependsOn) visit(dep); visiting.delete(id); visited.add(id);
  };
  for (const id of ids) visit(id);
  return plan.steps.map((step) => ({ id: step.id, operation: step.operation, dependsOn: [...step.dependsOn], arguments: { ...step.arguments } }));
}

/** Operations return completed, unknown, or a terminal failure. Only unknown
 * results may observe; only one failed step may receive a targeted repair. */
export async function executeTypedPlan(plan, { task, operations, verify, observe = null, repair = null, now = Date.now } = {}) {
  if (!plain(operations) || typeof verify !== 'function') throw new Error('typed-plan: operations and verifier required');
  const record = boundTaskRecord(task), metrics = { modelCalls: 0, toolCalls: 0, observations: 0, repairs: 0 }, trace = [];
  let steps;
  try { steps = validatePlan(plan, operations, record.budget.maxSteps); } catch (error) { return blocked(error.message, { trace, metrics }); }
  const started = now(), completed = new Map(), remaining = new Map(steps.map((step) => [step.id, step])), seen = new Set();
  while (remaining.size) {
    if (now() - started > record.budget.deadlineMs) return blocked('budget-exhausted', { trace, metrics });
    const step = steps.find((candidate) => remaining.has(candidate.id) && candidate.dependsOn.every((id) => completed.has(id)));
    if (!step) return blocked('no-progress', { trace, metrics });
    let args = { ...step.arguments }, repaired = false;
    for (;;) {
      let result;
      try {
        metrics.toolCalls++;
        result = await operations[step.operation]({ task: record, arguments: args, dependencies: Object.fromEntries(step.dependsOn.map((id) => [id, completed.get(id)])) });
      } catch (error) { result = { status: 'failed', reason: ['EACCES', 'EPERM'].includes(error?.code) ? 'permission-denied' : String(error?.message || error) }; }
      const signature = hash({ step: step.id, args, status: result?.status, value: result?.value, reason: result?.reason, observation: result?.observation });
      if (seen.has(signature)) return blocked('repeated-state', { trace, metrics });
      seen.add(signature); trace.push({ step: step.id, operation: step.operation, status: result?.status ?? 'invalid', receipt: result?.receipt ?? null });
      if (result?.status === 'completed') { completed.set(step.id, result.value); remaining.delete(step.id); break; }
      if (result?.status === 'unknown') {
        if (!observe || metrics.observations >= record.budget.maxObservations) return blocked('observation-budget-exhausted', { trace, metrics });
        metrics.observations++;
        const observation = await observe({ task: record, step, result });
        if (!observation?.progress || !plain(observation.arguments)) return blocked('no-progress', { trace, metrics });
        args = { ...args, ...observation.arguments }; continue;
      }
      if (['permission-denied', 'approval-declined', 'missing-input'].includes(result?.reason)) return blocked(result.reason, { trace, metrics });
      if (repaired || !repair || metrics.repairs >= record.budget.maxRepairs) return blocked(result?.reason || 'step-failed', { trace, metrics });
      metrics.repairs++; repaired = true;
      const patch = await repair({ task: record, step, result, completed: Object.fromEntries(completed) });
      if (!plain(patch?.arguments)) return blocked('repair-refused', { trace, metrics });
      args = { ...args, ...patch.arguments };
    }
  }
  let checked;
  try { checked = await verify({ task: record, outputs: Object.fromEntries(completed), trace }); } catch (error) { return blocked(`verification-failed: ${error.message}`, { trace, metrics }); }
  return checked?.ok === true ? { ok: true, status: 'completed', artifact: checked.artifact, verification: checked.receipt ?? null, trace, metrics } : blocked(checked?.reason || 'verification-failed', { trace, metrics });
}

/** Reviewed replay is generation-free. Learning is post-delivery and cannot
 * change a verified result when distillation or contribution fails. */
export async function runLeanHarness(task, { reviewedMethods = [], plan = null, operations = {}, verify, observe, repair, learn = null } = {}) {
  const record = boundTaskRecord(task);
  const reviewed = reviewedMethods.find((method) => method.intent === record.intent && method.reviewed === true && /^[a-f0-9]{64}$/.test(method.digest));
  let result;
  if (reviewed) {
    result = await reviewed.run(record);
    if (result?.metrics?.modelCalls !== 0) return blocked('reviewed-replay-used-generation', { lane: 'reviewed-replay', metrics: result.metrics });
    if (result?.ok !== true) return { ...result, lane: 'reviewed-replay' };
    const checked = await verify({ task: record, outputs: result.outputs, trace: result.trace ?? [] });
    result = checked?.ok === true ? { ...result, ok: true, status: 'completed', artifact: checked.artifact, verification: checked.receipt ?? null, lane: 'reviewed-replay' }
      : blocked(checked?.reason || 'verification-failed', { lane: 'reviewed-replay', metrics: result.metrics });
  } else {
    if (!plan) return blocked('no-reviewed-method-or-plan', { lane: 'new-plan' });
    result = { ...(await executeTypedPlan(plan, { task: record, operations, verify, observe, repair })), lane: 'new-plan' };
  }
  if (!result.ok || typeof learn !== 'function') return result;
  try { return { ...result, learning: await learn({ task: record, result }) }; }
  catch (error) { return { ...result, learning: { ok: false, reason: String(error?.message || error) } }; }
}
