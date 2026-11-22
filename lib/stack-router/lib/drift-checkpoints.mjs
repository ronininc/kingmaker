/**
 * lib/drift-checkpoints.mjs (router-phase2)
 *
 * Plan-vs-output drift checkpointing — BUILD-NEW. RuFlow has ZERO drift
 * control anywhere in its swarm code (behavior spec §2.6): no checkpoints,
 * no state snapshots, nothing compares a worker's output against the plan;
 * "anti-drift" exists only as prompt prose asking the model to behave.
 * This module is the code version.
 *
 * A task declares a plan (a list of steps) up front. Outputs are recorded
 * as they arrive. At a checkpoint, declared steps are compared against
 * observed outputs:
 *   - a declared step with no matching observed output = missing work;
 *   - an observed output matching no declared step = unplanned work.
 * The divergence score — (missing + orphan) / (declared + observed) —
 * beyond the threshold flags the task, and the flag is written to the
 * hash-chained audit log. The monitor never corrects or re-dispatches —
 * flagging is its whole remit; Kingmaker decides what to do with a flag.
 *
 * $0 spend, local-only, no telemetry.
 */

function tokenize(text) {
  return new Set(String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3));
}

/** Overlap similarity: |A ∩ B| / |A ∪ B| over token sets. */
function overlap(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export const DEFAULT_DIVERGENCE_THRESHOLD = 0.4;
export const DEFAULT_MATCH_THRESHOLD = 0.25;

/**
 * Create the drift monitor. Required: auditLog (hash-chained).
 * Options: divergenceThreshold — score above which a task is flagged
 * (default 0.4); matchThreshold — token-overlap needed for an output to
 * count as a step's evidence (default 0.25); `now` clock seam for tests.
 */
export function createDriftMonitor({
  auditLog,
  divergenceThreshold = DEFAULT_DIVERGENCE_THRESHOLD,
  matchThreshold = DEFAULT_MATCH_THRESHOLD,
  now = () => Date.now(),
} = {}) {
  if (!auditLog) throw new Error('drift-checkpoints: an auditLog is required — an unaudited drift flag is not shipped');

  /** taskId → { steps: [{ id, description }], outputs: [{ stepId, output, ts }] } */
  const tasks = new Map();
  const actor = 'drift-monitor';
  const log = (action, detail, meta) => auditLog.append({ actor, action, detail, meta: meta ?? {} });

  /** Declare (or redeclare) a task's plan. Steps: [{ id, description }]. */
  function declarePlan(taskId, steps) {
    if (!taskId) throw new Error('drift-checkpoints: taskId is required');
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new Error('drift-checkpoints: a plan needs at least one declared step');
    }
    const normalized = steps.map((s, i) => ({
      id: s.id ?? `step-${i + 1}`,
      description: String(s.description ?? s ?? ''),
    }));
    const existing = tasks.get(taskId);
    tasks.set(taskId, { steps: normalized, outputs: existing?.outputs ?? [], declaredAt: now() });
    return { ok: true, taskId, steps: normalized.length };
  }

  /** Record an observed output. `stepId` ties it to a declared step when known. */
  function recordOutput(taskId, { stepId = null, output } = {}) {
    const task = tasks.get(taskId);
    if (!task) return { ok: false, reason: 'no-plan-declared' };
    if (typeof output !== 'string' || output.trim() === '') {
      return { ok: false, reason: 'output is required and must be non-empty text' };
    }
    task.outputs.push({ stepId, output, ts: now() });
    return { ok: true, taskId, outputs: task.outputs.length };
  }

  /**
   * Compare the declared plan against observed outputs. Returns
   * { ok: true, flagged, divergence, missingSteps, orphanOutputs }.
   * When flagged, the flag is written to the audit chain (action
   * 'drift.flagged') — this is the only write the monitor makes.
   */
  function checkpoint(taskId) {
    const task = tasks.get(taskId);
    if (!task) return { ok: false, reason: 'no-plan-declared' };
    const { steps, outputs } = task;

    const outputMatched = outputs.map(() => false);
    const missingSteps = [];
    for (const step of steps) {
      let matched = false;
      outputs.forEach((o, idx) => {
        if (matched) return;
        const byId = o.stepId !== null && o.stepId === step.id;
        const byText = overlap(tokenize(step.description), tokenize(o.output)) >= matchThreshold;
        if (byId || byText) {
          matched = true;
          outputMatched[idx] = true;
        }
      });
      if (!matched) missingSteps.push(step.id);
    }
    const orphanOutputs = outputs.filter((_, idx) => !outputMatched[idx]).length;

    const total = steps.length + outputs.length;
    const divergence = total === 0 ? 0 : (missingSteps.length + orphanOutputs) / total;
    const flagged = divergence > divergenceThreshold;

    if (flagged) {
      log('drift.flagged', `task ${taskId}: divergence ${divergence.toFixed(2)} over threshold ${divergenceThreshold} — ${missingSteps.length} step(s) without output, ${orphanOutputs} unplanned output(s)`, {
        taskId, divergence: Math.round(divergence * 1000) / 1000,
        threshold: divergenceThreshold, missingSteps, orphanOutputs,
      });
    }
    return {
      ok: true, taskId, flagged,
      divergence: Math.round(divergence * 1000) / 1000,
      missingSteps, orphanOutputs,
      declared: steps.length, observed: outputs.length,
    };
  }

  return { declarePlan, recordOutput, checkpoint };
}
