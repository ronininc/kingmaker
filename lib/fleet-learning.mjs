/**
 * Model ingestion pipeline — Stage 7: fleet learning contracts + runtime.
 *
 * PORTED from kingmaker-os (contracts/fleet-telemetry.ts +
 * runtime/fleet-learning.ts) for the app. Native .mjs; TypeScript types
 * stripped, logic identical.
 *
 * Opted-in nodes send back telemetry about how ingested models behave in the
 * wild. The diode is enforced at two levels: the CONTRACT (a sealed envelope
 * forces customerDataIncluded to false) and the RUNTIME (validateEnvelope
 * refuses anything that isn't false — defense in depth).
 *
 * Opt-in only: no telemetry without the node's explicit participation.
 * Carries only operational telemetry — no customer data, no prompts, no
 * outputs. Ever.
 *
 * Pure functions; no I/O, no network, no LLM judgment. Aggregation is
 * deterministic: the same reports in any order yield the same intelligence.
 *
 * Doctrine: "Service, function, power. To the people."
 * Source of truth: kingmaker-os.
 */

/** Satisfaction values: 'up' | 'down' | 'unrated'. */

/**
 * Seal a telemetry report into a diode envelope. customerDataIncluded is
 * hardcoded false — the diode is one-way by construction.
 */
export function sealEnvelope(report, now = new Date()) {
  return {
    payload: report,
    customerDataIncluded: false,
    sentAt: now.toISOString(),
  };
}

/**
 * Validate a diode envelope. Defense in depth: the contract says
 * customerDataIncluded is false, but the runtime checks it anyway — a
 * non-false value (or an empty modelId) fails validation even if the sender
 * bypassed the contract.
 */
export function validateEnvelope(env) {
  if (env.customerDataIncluded !== false) {
    return {
      valid: false,
      reason: 'diode violation: customerDataIncluded is not false — envelope refused',
    };
  }
  if (env.payload.modelId.trim() === '') {
    return { valid: false, reason: 'empty modelId — envelope refused' };
  }
  return { valid: true, reason: 'envelope valid: diode intact, modelId present' };
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
