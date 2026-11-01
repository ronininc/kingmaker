/**
 * Model ingestion pipeline — candidate contracts.
 *
 * PORTED from kingmaker-os (contracts/model-candidate.ts) for the app.
 * Native .mjs; TypeScript types stripped, logic identical.
 *
 * Stage 1 (Discovery) produces candidates. Stage 2 (Triage) consumes them with
 * purely deterministic rules — no LLM judgment anywhere in the path.
 * The rules decide; a human (Robbie) decides ingestion. That is the cage.
 *
 * Doctrine: "Service, function, power. To the people."
 * Source of truth: kingmaker-os.
 */

/** Mac hardware tiers a model can target. */
export const HARDWARE_TIERS = ['8gb', '16gb', '24gb', '32gb', '64gb'];

/**
 * Max model weight size (bytes) that still leaves headroom for the runtime on
 * the tier's Mac. A model heavier than the 64gb cap fits no known tier.
 */
export const TIER_MODEL_CAPS_BYTES = {
  '8gb': 5 * 1024 ** 3,
  '16gb': 10 * 1024 ** 3,
  '24gb': 16 * 1024 ** 3,
  '32gb': 24 * 1024 ** 3,
  '64gb': 48 * 1024 ** 3,
};

/** Smallest tier whose cap holds sizeBytes, or null when it fits no known tier. */
export function smallestFittingTier(sizeBytes) {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return null;
  for (const tier of HARDWARE_TIERS) {
    if (sizeBytes <= TIER_MODEL_CAPS_BYTES[tier]) return tier;
  }
  return null;
}

/** Library dedup key: same base + same method + same quant = the same model. */
export function dedupKey(c) {
  return [c.baseModel, c.method, c.quant]
    .map((s) => s.trim().toLowerCase())
    .join('|');
}

/**
 * License gate — same doctrine as the decision-model registry: only permissive
 * licenses pass unattended. Non-commercial and proprietary licenses are never
 * ingestible; anything unrecognized is flagged for human eyes.
 */
export const PERMISSIVE_LICENSES = new Set([
  'Apache-2.0',
  'MIT',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
]);

const BLOCKED_LICENSE_HINTS = ['proprietary', 'non-commercial', 'by-nc'];

export function isPermissiveLicense(license) {
  return PERMISSIVE_LICENSES.has(license.trim());
}

export function isBlockedLicense(license) {
  const l = license.trim().toLowerCase();
  return BLOCKED_LICENSE_HINTS.some((h) => l.includes(h));
}

/** Normalize a hash for comparison (case/whitespace-insensitive). */
export function normalizeHash(hash) {
  return hash.trim().toLowerCase();
}
