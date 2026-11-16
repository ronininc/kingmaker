/**
 * Model ingestion pipeline — Stage 7: fleet learning contracts + runtime.
 *
 * PORTED from kingmaker-os (contracts/fleet-telemetry.ts +
 * runtime/fleet-learning.ts) for the app. Native .mjs; TypeScript types
 * stripped; outbound boundary now requires the closed fleet packet schema.
 *
 * Opted-in nodes send back telemetry about how ingested models behave in the
 * wild. The diode is enforced at two levels: the CONTRACT (a sealed envelope
 * requires a closed packet schema) and the RUNTIME (validateEnvelope
 * validates the same closed schema).
 *
 * Opt-in only: no telemetry without the node's explicit participation.
 * Raw reports are local-only. The closed schema limits outbound fields; this
 * is not a claim that all telemetry is anonymous or that metadata cannot identify a user.
 *
 * Pure functions; no I/O, no network, no LLM judgment. Aggregation is
 * deterministic: the same reports in any order yield the same intelligence.
 *
 * Doctrine: "Service, function, power. To the people."
 * Source of truth: kingmaker-os.
 */

import { validatePacket } from '../vendor/fleet/fleet-packet.mjs';

// Raw model reports are local aggregation inputs, never outbound data. A boolean
// customerDataIncluded flag is not a privacy filter; only the closed packet schema
// produced by sanitizeForFleet can cross this boundary.
export function sealEnvelope(packet, now = new Date()) {
  const payload = structuredClone(packet);
  if (!validatePacket(payload).ok) throw new Error('FLEET_CLOSED_PACKET_REQUIRED');
  return { payload, customerDataIncluded: false, sentAt: now.toISOString() };
}
export function validateEnvelope(env) {
  try {
    if (!env || env.customerDataIncluded !== false) return { valid: false, reason: 'diode violation: customerDataIncluded must be false' };
    if (Object.keys(env).some(k => !['payload','customerDataIncluded','sentAt'].includes(k))
      || typeof env.sentAt !== 'string' || !Number.isFinite(Date.parse(env.sentAt))
      || !validatePacket(env.payload).ok) return { valid:false, reason:'closed fleet packet required; raw modelId reports are local only' };
    return {valid:true,reason:'closed packet schema valid; not a blanket privacy guarantee'};
  } catch { return {valid:false,reason:'malformed fleet envelope'}; }
}

/** Median of a non-empty sorted numeric array. */
function medianOf(sorted) {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** skill-pair key: the two ids sorted, joined with '+'. */
function skillPairKey(pair) {
  const [a, b] = [pair[0], pair[1]].sort();
  return `${a}+${b}`;
}

/**
 * Aggregate opt-in telemetry into per-model fleet intelligence. Pure and
 * deterministic: counts are order-insensitive, the median is computed over
 * sorted values, and the satisfaction buckets are fixed.
 */
export function aggregateReports(modelId, reports) {
  const tokPerSec = [];
  const failureModeCounts = {};
  const skillPairCounts = {};
  const satisfaction = { up: 0, down: 0, unrated: 0 };

  for (const report of reports) {
    if (report.decodeTokPerSec !== null && Number.isFinite(report.decodeTokPerSec)) {
      tokPerSec.push(report.decodeTokPerSec);
    }
    for (const mode of report.failureModes) {
      failureModeCounts[mode] = (failureModeCounts[mode] ?? 0) + 1;
    }
    for (const pair of report.skillPairs) {
      const key = skillPairKey(pair);
      skillPairCounts[key] = (skillPairCounts[key] ?? 0) + 1;
    }
    satisfaction[report.satisfaction] += 1;
  }

  tokPerSec.sort((a, b) => a - b);
  const medianDecodeTokPerSec =
    tokPerSec.length === 0 ? null : medianOf(tokPerSec);

  return {
    modelId,
    sampleCount: reports.length,
    medianDecodeTokPerSec,
    failureModeCounts,
    skillPairCounts,
    satisfaction,
  };
}
