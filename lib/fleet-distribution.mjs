/**
 * Model ingestion pipeline — Stage 6: distribution contracts + runtime.
 *
 * PORTED from kingmaker-os (contracts/fleet-distribution.ts +
 * runtime/model-distribution.ts) for the app. Native .mjs; TypeScript types
 * stripped, logic identical.
 *
 * After a model is ingested into the brain library, Stage 6 publishes a
 * signed snapshot and lets each node propose downloads for itself. Download
 * plans are PROPOSALS only: installs always need explicit user consent
 * (sovereignty), and the launcher's private hash pins are the final
 * anti-spoofing line — even a compromised library cannot install a bad hash.
 *
 * Pure functions; the caller supplies everything (snapshot, node state,
 * pins, consent). No I/O, no network, no LLM judgment. Everything
 * audit-loggable.
 *
 * Doctrine: "Service, function, power. To the people."
 * Source of truth: kingmaker-os.
 */

import { canonicalJson, sha256Hex } from './hash-util.mjs';
import { HARDWARE_TIERS, normalizeHash } from './model-candidate.mjs';

/**
 * Install results: 'verified' | 'hash-mismatch' | 'not-pinned' |
 * 'consent-withheld'.
 */

/** Commit to a snapshot's exact bytes: the integrity root of distribution. */
export function buildDistributionPackage(snapshot, signedBy, now = new Date()) {
  return {
    snapshot,
    packageHash: sha256Hex(canonicalJson(snapshot)),
    signedBy,
    signedAt: now.toISOString(),
  };
}

/**
 * Recompute the package hash from the snapshot and compare. True only when
 * the snapshot bytes are exactly what was signed — any tampering fails.
 */
export function verifyPackage(pkg) {
  return sha256Hex(canonicalJson(pkg.snapshot)) === pkg.packageHash;
}

function tierWeight(tier) {
  return HARDWARE_TIERS.indexOf(tier);
}

/**
 * Propose which library models this node should download. A proposal, not an
 * order: sovereignty means installs still need explicit user consent
 * (see verifyForInstall). Deterministic: snapshot order is preserved.
 *
 * node: { tier, installedIds } — installedIds is a Set of library ids.
 */
export function planNodeDownload(pkg, node) {
  const toDownload = [];
  const skipped = [];
  for (const model of pkg.snapshot.models) {
    if (node.installedIds.has(model.id)) {
      skipped.push({ id: model.id, reason: 'already installed' });
      continue;
    }
    if (model.tier === null) {
      skipped.push({ id: model.id, reason: 'no tier fit' });
      continue;
    }
    if (tierWeight(model.tier) > tierWeight(node.tier)) {
      skipped.push({
        id: model.id,
        reason: `heavier than node tier (${model.tier} > ${node.tier})`,
      });
      continue;
    }
    toDownload.push(model);
  }
  return { toDownload, skipped };
}

/**
 * Final install gate. Consent is checked first: without explicit user
 * consent nothing installs, full stop. The launcher's private hash pins are
 * the anti-spoofing line: even a compromised library cannot install weights
 * whose hash the launcher never pinned. Hash comparison is
 * case/whitespace-insensitive.
 */
export function verifyForInstall(model, launcherPins, userConsented) {
  if (!userConsented) {
    return {
      modelId: model.id,
      result: 'consent-withheld',
      detail: 'sovereignty: the user did not consent',
    };
  }
  const pinned = launcherPins.get(model.id);
  if (pinned === undefined) {
    return {
      modelId: model.id,
      result: 'not-pinned',
      detail: 'no launcher pin for this model — install refused',
    };
  }
  if (normalizeHash(pinned) !== normalizeHash(model.weightHash)) {
    return {
      modelId: model.id,
      result: 'hash-mismatch',
      detail: 'launcher hash mismatch — install refused',
    };
  }
  return {
    modelId: model.id,
    result: 'verified',
    detail: 'weight hash matches the launcher pin and consent was given',
  };
}
