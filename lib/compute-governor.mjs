/**
 * Kingmaker governance module: compute governor.
 *
 * The 10th module. Owns how a model is DELIVERED to a device: resident, or
 * metered in over the connection in verified portions. The pipeline triages
 * candidates statically; the governor plans at load time.
 *
 * METERED DOCTRINE (owner, 2026-11-14): the governor used to prohibit — a
 * model heavier than its tier's cap was refused, and streaming was the
 * exception that begged its way under the cap. That is inverted. Portions
 * are the safety mechanism: every model travels as 1 MiB pin-verified
 * portions (lib/brain-library-access.mjs), residency is cycled by the
 * eviction policy, and device memory is MEASURED for the plan (how much is
 * free, what the active set costs) — never used as a tier gate.
 *
 * PART C (owner ruling, 2026-11-14 01:44 — no GGUF limit): an active set
 * larger than the device's whole memory is not a local impossibility. It
 * takes the SANDBOX lane (lib/sandbox-lane.mjs): containerized, paged
 * execution under Kingmaker's own Docker control — Kingmaker's
 * device-level control of its Linux sandbox includes Docker, so the
 * sandbox is a local execution surface. ESCALATION is what remains when
 * the sandbox lane is absent or declined in the device's posture (or the
 * device is unmeasured): a policy routing through the existing lanes,
 * never a refusal and never a device-incapacity claim.
 *
 * The active-set rule survives intact: streaming architectures are graded
 * on their ACTIVE set, not their weight bytes. A 23GB-weight model with a
 * 2.9GB active set (Edge0) runs flagship work on a small machine. Grade the
 * weights and you buy hardware you don't need; grade the active set and a
 * $1,700 mini does flagship work. That gap is the moat.
 *
 * Pure functions + injected deps. No I/O, no network. Every load
 * decision is auditable through the injected audit sink.
 */

import { MAX_PORTION_BYTES } from './brain-library-access.mjs';
import { buildSandboxPlan, normalizeSandboxPosture } from './sandbox-lane.mjs';

/** Reserve for KV cache growth + runtime overhead when judging residency. */
export const KV_HEADROOM_BYTES = 2 * 1024 ** 3;

/**
 * Measure a device for planning: total memory, free memory when the
 * probe knows it, and the sandbox posture (Part C — a probe result, a
 * boolean, or a declared posture, normalized by lib/sandbox-lane.mjs).
 * Measurement only — nothing here gates anything.
 * Returns { totalBytes, freeBytes, usableBytes, reason, sandbox } where
 * usableBytes is the free memory when measured, else the total.
 */
export function assessDevice({ totalMemoryBytes, freeMemoryBytes = null, sandbox = null } = {}) {
  const posture = normalizeSandboxPosture(sandbox);
  if (!Number.isFinite(totalMemoryBytes) || totalMemoryBytes <= 0) {
    return { totalBytes: 0, freeBytes: null, usableBytes: 0, reason: 'unknown device memory', sandbox: posture };
  }
  const freeBytes = Number.isFinite(freeMemoryBytes) && freeMemoryBytes > 0 ? freeMemoryBytes : null;
  return { totalBytes: totalMemoryBytes, freeBytes, usableBytes: freeBytes ?? totalMemoryBytes, reason: 'ok', sandbox: posture };
}

/**
 * Plan how a candidate loads on a device.
 *
 * candidate: { id, estimatedSizeBytes, activeMemoryBytes? }
 *   activeMemoryBytes — the resident working set for streaming
 *   architectures (Edge0-style expert offload). Falls back to weight
 *   bytes when absent (with a warning: measure on device).
 *
 * Strategies, in lane order:
 *   resident      — the full weights + KV headroom fit the measured free
 *                   memory; delivered in portions, then resident.
 *   metered-stream — the delivery plan for everything else the host
 *                   runner serves: the weights arrive in 1 MiB
 *                   pin-verified portions and residency is cycled as
 *                   they materialize (for streaming architectures, the
 *                   inactive experts ride the same plan).
 *   sandbox       — the active set exceeds the device's whole memory and
 *                   the sandbox is in the device's posture: the model
 *                   executes locally anyway, containerized and paged
 *                   under Kingmaker's Docker control (lib/sandbox-lane.mjs
 *                   carries the concrete plan: runner image, memory
 *                   ceiling + disk-backed paging allowance, portion feed
 *                   into the sandbox store).
 *   escalate      — the active set exceeds the device's whole memory and
 *                   the sandbox lane is absent or declined (or the device
 *                   is unmeasured): by policy the caller escalates through
 *                   the existing lanes. Never a tier refusal, never a
 *                   claim that the device cannot run the model.
 */
export function planLoad(candidate, deviceInfo) {
  const device = assessDevice(deviceInfo);
  const warnings = [];
  const weightsBytes = candidate.estimatedSizeBytes;
  let activeBytes = candidate.activeMemoryBytes;
  if (!Number.isFinite(activeBytes) || activeBytes <= 0) {
    activeBytes = weightsBytes;
    warnings.push(
      'no activeMemoryBytes declared — grading weight bytes; measure the active set on device',
    );
  }
  const portions = Number.isFinite(weightsBytes) && weightsBytes > 0
    ? Math.max(1, Math.ceil(weightsBytes / MAX_PORTION_BYTES))
    : null;
  const base = {
    totalBytes: device.totalBytes,
    freeBytes: device.freeBytes,
    usableBytes: device.usableBytes,
    weightsBytes,
    activeBytes,
    portions,
    portionBytes: MAX_PORTION_BYTES,
    warnings,
    sandboxPosture: device.sandbox,
  };

  if (device.totalBytes <= 0) {
    return { ...base, strategy: 'escalate', reason: `${device.reason} — the load cannot be planned against an unmeasured device; escalate rather than guess` };
  }
  if (Number.isFinite(activeBytes) && activeBytes > device.totalBytes) {
    if (device.sandbox.available) {
      const sandbox = buildSandboxPlan({ model: candidate.id, weightsBytes, activeBytes, ramBytes: device.totalBytes });
      return {
        ...base,
        strategy: 'sandbox',
        sandbox,
        reason: `active set ${activeBytes} exceeds this device's whole memory ${device.totalBytes}, so it serves locally through the sandbox lane: ${sandbox.runner.image} under Kingmaker's Docker control, answering at ${sandbox.runner.endpoint}, the model memory-mapped from the sandbox store and paged under a ${sandbox.paging.memoryBytes}-byte container ceiling with a ${sandbox.paging.swapAllowanceBytes}-byte disk-backed paging allowance; its ${portions ?? '?'} pin-verified portion(s) are fed into the sandbox store before the container starts`,
      };
    }
    return {
      ...base,
      strategy: 'escalate',
      reason: `active set ${activeBytes} exceeds this device's whole memory ${device.totalBytes}; local serving past the device's memory runs through the sandbox lane (containerized, paged execution under Kingmaker's Docker control), and that lane is ${device.sandbox.declined ? 'declined in' : 'absent from'} this device's posture (${device.sandbox.reason}) — by policy this load escalates through the existing lanes and is served elsewhere now, rather than sit unserved (it is not refused for its size)`,
    };
  }
  if (
    Number.isFinite(weightsBytes) &&
    weightsBytes > 0 &&
    weightsBytes + KV_HEADROOM_BYTES <= device.usableBytes
  ) {
    return { ...base, strategy: 'resident', reason: 'full weights fit the measured free memory with KV headroom — delivered in verified portions, then resident' };
  }
  return {
    ...base,
    strategy: 'metered-stream',
    reason: `delivered over the metered connection in ${portions ?? '?'} pin-verified portion(s) of ${MAX_PORTION_BYTES} bytes; residency is cycled by the eviction policy as it materializes (active set ${activeBytes} against ${device.usableBytes} usable)`,
  };
}

/**
 * Govern a load plan: audit the decision, return the governed plan.
 * deps: { appendAudit(event), now() }.
 */
export function governLoad(plan, candidate, deps) {
  const event = {
    type: 'compute-governor/load-decision',
    candidateId: candidate.id,
    strategy: plan.strategy,
    weightsBytes: plan.weightsBytes,
    activeBytes: plan.activeBytes,
    portions: plan.portions ?? null,
    sandbox: plan.sandbox ?? null,
    reason: plan.reason,
    at: deps.now(),
  };
  deps.appendAudit(event);
  return { ...plan, audited: true };
}
