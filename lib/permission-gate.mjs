/**
 * Model ingestion pipeline — Stage 4: the permission gate.
 *
 * PORTED from kingmaker-os (contracts/permission-gate.ts) for the app.
 * Native .mjs; TypeScript types stripped, logic identical.
 *
 * THIS IS THE CAGE. Nothing enters the brain library without Robbie's signed
 * tap. The system can discover, triage, and scan autonomously — ingestion
 * requires human permission. Always.
 *
 * This module is the GATE DATA CONTRACT: what Robbie sees (the packet), the
 * deterministic recommendation the rules produce, and the signed approval /
 * rejection record that the audit chain stores. The app UI comes later; the
 * contract is what the UI must honor.
 *
 * Doctrine: "Service, function, power. To the people."
 * Source of truth: kingmaker-os.
 */

import { smallestFittingTier } from './model-candidate.mjs';
import { canonicalJson, sha256Hex } from './hash-util.mjs';

/**
 * Gate recommendations: 'INGEST' | 'REJECT'.
 * Robbie's gate decisions: 'approved' | 'rejected'.
 * decidedBy is the literal 'robbie' — only Robbie can hold the gate.
 */

/**
 * Deterministic recommendation. The rules recommend; Robbie decides.
 * Flags never auto-reject — they are the reason the human looks.
 */
export function recommendIngestion(triage, scan) {
  if (triage.verdict === 'reject') {
    return {
      recommendation: 'REJECT',
      reason: 'triage rejected the candidate — the scan should not have run',
    };
  }
  const beaten = scan.comparison.filter((c) => c.beats).map((c) => c.tier);
  if (beaten.length > 0) {
    return {
      recommendation: 'INGEST',
      reason: `beats best-in-class in tier(s): ${beaten.join(', ')}`,
    };
  }
  const empty = scan.comparison
    .filter((c) => c.bestInClassId === null)
    .map((c) => c.tier);
  if (empty.length > 0) {
    return {
      recommendation: 'INGEST',
      reason: `fills empty tier(s): ${empty.join(', ')}`,
    };
  }
  return {
    recommendation: 'REJECT',
    reason:
      'does not beat best-in-class in any measured tier — no ingestion rationale',
  };
}

/**
 * Build the gate packet — everything Robbie reviews before tapping YES or
 * NO. Built deterministically from the candidate, the triage report, and the
 * scan report; the packet is hashed, and the approval record binds to that
 * hash. Deterministic: same candidate + triage + scan + clock yields the
 * identical packet, including the packet hash.
 */
export function buildGatePacket(candidate, triage, scan, now = new Date()) {
  const flagReasons = triage.findings
    .filter((f) => f.verdict === 'flag')
    .map((f) => `${f.check}: ${f.reason}`);
  const scanFlags = scan.errors.map((e) => `scan ${e.stage}: ${e.message}`);
  const { recommendation, reason } = recommendIngestion(triage, scan);

  const packetSansHash = {
    packetId: `gate:${candidate.id}:${scan.scannedAt}`,
    candidate: {
      name: candidate.name,
      publisher: candidate.publisher,
      license: candidate.license,
      baseModel: candidate.baseModel,
      method: candidate.method,
      quant: candidate.quant,
      claimedParamsB: candidate.claimedParamsB,
    },
    triage: { verdict: triage.verdict, flagReasons },
    benchmarks: scan.comparison.map((c, i) => ({
      suite: scan.capability[i]?.suite ?? c.metric,
      candidateScore: c.candidateScore,
      bestInClassScore: c.bestScore,
      bestInClassId: c.bestInClassId,
      beats: c.beats,
    })),
    tierFit: smallestFittingTier(candidate.estimatedSizeBytes),
    performance: scan.performance.map((p) => ({
      tier: p.tier,
      decodeTokPerSec: p.decodeTokPerSec,
      peakRamBytes: p.peakRamBytes,
    })),
    safetyNotes: scan.safety.map((s) => `${s.promptClass}: ${s.behavior} — ${s.note}`),
    flags: [...flagReasons, ...scanFlags],
    recommendation,
    recommendationReason: reason,
    builtAt: now.toISOString(),
  };
  return {
    ...packetSansHash,
    packetHash: sha256Hex(canonicalJson(packetSansHash)),
  };
}

/**
 * Validate an approval record against the packet it claims to approve.
 * The cage holds unless every check passes: packet id binds, packet hash
 * binds (no tampering), decidedBy is 'robbie', a tap signature is present,
 * decidedAt is a valid timestamp, and a rejection carries a reason.
 */
export function validateApproval(record, packet) {
  if (record.packetId !== packet.packetId) {
    return { valid: false, reason: 'packet id mismatch — approval is for a different packet' };
  }
  if (record.packetHash !== packet.packetHash) {
    return { valid: false, reason: 'packet hash mismatch — the packet was tampered with' };
  }
  if (record.decidedBy !== 'robbie') {
    return { valid: false, reason: 'only Robbie can tap the gate' };
  }
  if (record.signature.trim() === '') {
    return { valid: false, reason: 'missing tap signature' };
  }
  if (Number.isNaN(Date.parse(record.decidedAt))) {
    return { valid: false, reason: 'decidedAt is not a valid timestamp' };
  }
  if (record.decision === 'rejected' && record.reason.trim() === '') {
    return { valid: false, reason: 'a rejection needs a reason' };
  }
  return { valid: true, reason: 'approval binds to the packet and carries a tap signature' };
}
