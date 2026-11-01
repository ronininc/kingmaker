/**
 * Kingmaker governance module: compute governor.
 *
 * The 10th module. Owns the device's compute budget: how a model loads
 * against real memory — resident, streamed, or refused. The pipeline
 * triages candidates statically; the governor decides at load time.
 *
 * The key rule: streaming architectures are graded on their ACTIVE set,
 * not their weight bytes. A 23GB-weight model with a 2.9GB active set
 * (Edge0) is an 8gb-tier model, not a 32gb-tier one. Grade the weights
 * and you buy hardware you don't need; grade the active set and a
 * $1,700 mini does flagship work. That gap is the moat.
 *
 * Pure functions + injected deps. No I/O, no network. Every load
 * decision is auditable through the injected audit sink.
 */

import {
  HARDWARE_TIERS,
  TIER_MODEL_CAPS_BYTES,
} from './model-candidate.mjs';

/** Reserve for KV cache growth + runtime overhead, beyond the tier cap. */
export const KV_HEADROOM_BYTES = 2 * 1024 ** 3;

const TIER_NOMINAL_BYTES = {
  '8gb': 8 * 1024 ** 3,
  '16gb': 16 * 1024 ** 3,
  '24gb': 24 * 1024 ** 3,
  '32gb': 32 * 1024 ** 3,
  '64gb': 64 * 1024 ** 3,
};

/**
 * Map a device's total RAM to a hardware tier and usable model budget.
 * usableBytes comes from the pipeline's tier caps (already headroom-aware).
 */
export function assessDevice({ totalMemoryBytes }) {
  if (!Number.isFinite(totalMemoryBytes) || totalMemoryBytes <= 0) {
    return { tier: null, usableBytes: 0, reason: 'unknown device memory' };
  }
  let tier = '64gb';
  for (const t of HARDWARE_TIERS) {
    if (TIER_NOMINAL_BYTES[t] >= totalMemoryBytes) {
      tier = t;
      break;
    }
  }
  return { tier, usableBytes: TIER_MODEL_CAPS_BYTES[tier], reason: 'ok' };
}

/**
 * Decide how a candidate loads on a device.
 *
 * candidate: { id, estimatedSizeBytes, activeMemoryBytes? }
 *   activeMemoryBytes — the resident working set for streaming
 *   architectures (Edge0-style expert offload). Falls back to weight
 *   bytes when absent (with a warning: measure on device).
 *
 * Strategies:
 *   resident — full weights + KV headroom fit; no streaming needed.
 *   stream   — weights exceed budget but the ACTIVE set fits; the
 *              offload engine streams experts from SSD per the
 *              prerouter. This is the flagship-on-a-mini path.
 *   refused  — even the active set doesn't fit; bigger tier required.
 */
export function planLoad(candidate, deviceInfo) {
  const device = assessDevice(deviceInfo);
  const warnings = [];
  if (device.tier === null) {
    return { strategy: 'refused', tier: null, reason: device.reason, warnings };
  }

  const weightsBytes = candidate.estimatedSizeBytes;
  let activeBytes = candidate.activeMemoryBytes;
  if (!Number.isFinite(activeBytes) || activeBytes <= 0) {
    activeBytes = weightsBytes;
    warnings.push(
      'no activeMemoryBytes declared — grading weight bytes; measure the active set on device',
    );
  }

  const usable = device.usableBytes;
  const base = {
    tier: device.tier,
    usableBytes: usable,
    weightsBytes,
    activeBytes,
    warnings,
  };

  if (
    Number.isFinite(weightsBytes) &&
    weightsBytes > 0 &&
    weightsBytes + KV_HEADROOM_BYTES <= usable
  ) {
    return { ...base, strategy: 'resident', reason: 'full weights fit with KV headroom' };
  }
  if (activeBytes + KV_HEADROOM_BYTES <= usable) {
    if (device.tier === '8gb') {
      warnings.push(
        '8gb tier streaming: expect reduced throughput vs larger tiers — KV headroom is thin',
      );
    }
    return {
      ...base,
      strategy: 'stream',
      reason: `weights exceed ${device.tier} budget; active set ${activeBytes} fits — stream experts from SSD`,
    };
  }
  return {
    ...base,
    strategy: 'refused',
    reason: `active set ${activeBytes} exceeds ${device.tier} budget even with streaming — bigger tier required`,
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
    tier: plan.tier,
    weightsBytes: plan.weightsBytes,
    activeBytes: plan.activeBytes,
    reason: plan.reason,
    at: deps.now(),
  };
  deps.appendAudit(event);
  return { ...plan, audited: true };
}
