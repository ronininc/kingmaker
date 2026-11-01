/**
 * Model ingestion pipeline — Stage 2: Triage.
 *
 * PORTED from kingmaker-os (runtime/model-triage.ts) for the app.
 * Native .mjs; TypeScript types stripped, logic identical.
 *
 * Deterministic filters over candidates. Pure functions: no I/O, no
 * network, no LLM judgment. The rules decide; the report is audit-logged;
 * a human (Robbie) decides ingestion at Stage 4. That is the cage.
 *
 * Verdict aggregation is order-independent: any reject wins, else any flag
 * wins, else pass.
 *
 * Source of truth: kingmaker-os.
 */

import {
  dedupKey,
  isBlockedLicense,
  isPermissiveLicense,
  normalizeHash,
  smallestFittingTier,
} from './model-candidate.mjs';

function finding(check, verdict, reason) {
  return { check, verdict, reason };
}

function checkLicense(c) {
  const license = c.license.trim();
  if (isPermissiveLicense(license)) {
    return finding('license', 'pass', `permissive license ${license}`);
  }
  if (license === '' || license.toLowerCase() === 'unknown') {
    return finding('license', 'flag', 'no declared license — needs human eyes');
  }
  if (isBlockedLicense(license)) {
    return finding('license', 'reject', `blocked license ${license} — never ingestible`);
  }
  return finding('license', 'flag', `unrecognized license ${license} — needs human eyes`);
}

function checkHash(c, ctx) {
  if (c.publishedHash.trim() === '') {
    return finding('hash', 'flag', 'no published hash — integrity cannot be verified');
  }
  const pinned = ctx.pinnedHashes.get(c.id);
  if (pinned !== undefined && normalizeHash(pinned) !== normalizeHash(c.publishedHash)) {
    return finding(
      'hash',
      'reject',
      'published hash differs from pinned hash — possible tampering',
    );
  }
  return finding('hash', 'pass', 'published hash present');
}

function checkSize(c) {
  if (!Number.isFinite(c.estimatedSizeBytes) || c.estimatedSizeBytes <= 0) {
    return finding('size', 'flag', 'size unknown — needs human eyes');
  }
  const tier = smallestFittingTier(c.estimatedSizeBytes);
  if (tier === null) {
    return finding(
      'size',
      'reject',
      `exceeds the 64gb tier cap — fits no known hardware`,
    );
  }
  return finding('size', 'pass', `fits the ${tier} tier`);
}

function checkPublisher(c, ctx) {
  const publisher = c.publisher.trim().toLowerCase();
  const flagged = new Set([...ctx.flaggedPublishers].map((p) => p.toLowerCase()));
  const known = new Set([...ctx.knownPublishers].map((p) => p.toLowerCase()));
  if (c.publisherReputation === 'flagged' || flagged.has(publisher)) {
    return finding('publisher', 'reject', `publisher ${c.publisher} is flagged`);
  }
  if (c.publisherReputation === 'first-time') {
    return finding('publisher', 'flag', `first-time publisher ${c.publisher} — needs human eyes`);
  }
  if (c.publisherReputation === 'known-good' || known.has(publisher)) {
    return finding('publisher', 'pass', `publisher ${c.publisher} recognized`);
  }
  return finding('publisher', 'flag', `unrecognized publisher ${c.publisher} — needs human eyes`);
}

function checkDuplicate(c, ctx) {
  if (ctx.libraryDedupKeys.has(dedupKey(c))) {
    return finding(
      'duplicate',
      'reject',
      `already in the library (${dedupKey(c)})`,
    );
  }
  return finding('duplicate', 'pass', 'not present in the library');
}

/**
 * Run all five checks and aggregate. Deterministic: the same candidate +
 * context + clock always yields the identical report.
 */
export function triageCandidate(candidate, ctx, now = new Date()) {
  const findings = [
    checkLicense(candidate),
    checkHash(candidate, ctx),
    checkSize(candidate),
    checkPublisher(candidate, ctx),
    checkDuplicate(candidate, ctx),
  ];
  const verdict = findings.some((f) => f.verdict === 'reject')
    ? 'reject'
    : findings.some((f) => f.verdict === 'flag')
      ? 'flag'
      : 'pass';
  return {
    candidateId: candidate.id,
    verdict,
    findings,
    decidedAt: now.toISOString(),
  };
}

/** Convenience: triage a whole queue with one shared context. */
export function triageQueue(candidates, ctx, now = new Date()) {
  return candidates.map((c) => triageCandidate(c, ctx, now));
}
