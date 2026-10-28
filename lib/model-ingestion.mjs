/**
 * Model ingestion pipeline — Stage 5: Ingestion.
 *
 * PORTED from kingmaker-os (runtime/model-ingestion.ts) for the app.
 * Native .mjs; TypeScript types stripped, logic identical.
 *
 * The gate has been tapped. This stage turns a validated approval into a
 * concrete plan: pin the measured weight hash, write the library entry, the
 * weights manifest, and the auto-generated model card, then stage the commit
 * to the brain library repo.
 *
 * THE CAGE: `ingest()` calls validateApproval() FIRST, and recomputes the
 * packet hash itself before that. An invalid approval — tampered packet,
 * anyone but Robbie, missing signature, rejection without a reason, or
 * anything other than 'approved' — throws GateError and nothing ingests.
 * Pure builders below; the only I/O is the injected pin registry.
 *
 * Doctrine: "Service, function, power. To the people."
 * Source of truth: kingmaker-os.
 */

import { smallestFittingTier } from './model-candidate.mjs';
import { canonicalJson, sha256Hex } from './hash-util.mjs';
import { validateApproval } from './permission-gate.mjs';

/** The fixed ingestion sequence. Nothing ingests out of order. */
export const INGESTION_STEPS = [
  'pin-registry',
  'library.json',
  'weights.json',
  'model-card',
  'commit',
];

/**
 * Build the library entry from what was claimed (candidate), what was
 * measured (scan), and what was approved (approval). Pure.
 */
export function buildLibraryEntry(candidate, scan, approval) {
  return {
    id: candidate.id,
    name: candidate.name,
    publisher: candidate.publisher,
    license: candidate.license,
    baseModel: candidate.baseModel,
    method: candidate.method,
    quant: candidate.quant,
    claimedParamsB: candidate.claimedParamsB,
    tier: smallestFittingTier(candidate.estimatedSizeBytes),
    benchmarks: scan.capability.map((b) => ({
      suite: b.suite,
      score: b.score,
    })),
    scanDate: scan.scannedAt,
    approver: 'robbie',
    approvalSignature: approval.signature,
    weightHash: scan.integrity.sha256,
    gatePacketId: approval.packetId,
  };
}

function fileDownloadUrl(sourceUrl, fileName) {
  const base = sourceUrl.replace(/\/+$/, '');
  if (base.includes('huggingface.co')) {
    return `${base}/resolve/main/${fileName}`;
  }
  return `${base}/${fileName}`;
}

/**
 * Build the weights manifest. `fileHashes` maps file name -> measured sha256.
 * Sorted by file name so the manifest is deterministic.
 */
export function buildWeightsEntry(candidate, fileHashes) {
  const files = Object.keys(fileHashes)
    .sort()
    .map((fileName) => ({
      url: fileDownloadUrl(candidate.sourceUrl, fileName),
      sha256: fileHashes[fileName],
    }));
  return { id: candidate.id, files };
}

function escapeMd(cell) {
  return cell.replace(/\|/g, '\\|');
}

function formatParams(claimedParamsB) {
  return claimedParamsB > 0 ? `${claimedParamsB}B` : 'undeclared';
}

function formatGigabytes(bytes) {
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/**
 * Auto-generate the model card from measured scan data and the approval
 * record. Documents behavior — never judges it. Deterministic: same entry +
 * scan yields the identical card.
 */
export function generateModelCard(entry, scan) {
  const lines = [
    `# ${escapeMd(entry.name)}`,
    '',
    '> Auto-generated from the Stage 3 scan report. Measurements and documented',
    '> behaviors only — no judgments.',
    '',
    '## Summary',
    '',
    '| Field | Value |',
    '|---|---|',
    `| Publisher | ${escapeMd(entry.publisher)} |`,
    `| License | ${escapeMd(entry.license)} |`,
    `| Base model | ${escapeMd(entry.baseModel)} |`,
    `| Method | ${escapeMd(entry.method)} |`,
    `| Quantization | ${escapeMd(entry.quant)} |`,
    `| Claimed parameters | ${escapeMd(formatParams(entry.claimedParamsB))} |`,
    `| Minimum tier | ${entry.tier ?? 'fits no known tier'} |`,
    `| Weight sha256 | \`${escapeMd(entry.weightHash)}\` |`,
    '',
    '## Benchmarks',
    '',
    '| Suite | Score | Unit | Samples | Notes |',
    '|---|---|---|---|---|',
  ];
  for (const b of scan.capability) {
    lines.push(
      `| ${escapeMd(b.suite)} | ${b.score} | ${escapeMd(b.unit)} | ${b.samples} | ${escapeMd(b.notes)} |`,
    );
  }
  if (scan.capability.length === 0) {
    lines.push('| _no benchmark results recorded_ |  |  |  |  |');
  }
  lines.push('', '## Performance', '', '| Tier | Decode tok/s | Prefill tok/s | Peak RAM | Context tokens |', '|---|---|---|---|---|');
  for (const p of scan.performance) {
    lines.push(
      `| ${escapeMd(p.tier)} | ${p.decodeTokPerSec} | ${p.prefillTokPerSec} | ${formatGigabytes(p.peakRamBytes)} | ${p.contextTokens} |`,
    );
  }
  if (scan.performance.length === 0) {
    lines.push('| _no performance measurements recorded_ |  |  |  |  |');
  }
  lines.push('', '## Documented behaviors', '', '> From the Stage 3 safety battery. What the model did, in plain words.');
  for (const s of scan.safety) {
    lines.push(`- ${escapeMd(s.promptClass)}: ${escapeMd(s.behavior)} — ${escapeMd(s.note)}`);
  }
  if (scan.safety.length === 0) {
    lines.push('- _no safety probes recorded_');
  }
  lines.push(
    '',
    '## Approval',
    '',
    `- Approver: ${entry.approver}`,
    `- Approval signature: \`${escapeMd(entry.approvalSignature)}\``,
    `- Gate packet: \`${escapeMd(entry.gatePacketId)}\``,
    `- Scan date: ${escapeMd(entry.scanDate)}`,
    '',
  );
  return lines.join('\n');
}

/**
 * Verify the packet's own integrity: recompute the sha256 over the canonical
 * packet body and compare it to the embedded packetHash. A packet edited
 * after the hash was computed — even if the approval record was built from
 * the original — fails here. Pure.
 */
export function verifyPacketIntegrity(packet) {
  const { packetHash, ...body } = packet;
  const recomputed = sha256Hex(canonicalJson(body));
  if (recomputed !== packet.packetHash) {
    return {
      valid: false,
      reason: 'packet hash mismatch — the packet was tampered with',
    };
  }
  return { valid: true, reason: 'packet integrity verified' };
}

/**
 * Build the full ingestion plan for a validated approval. Pure — no pinning
 * happens here; the registry pin runs in `ingest()` first and the plan
 * describes everything else, in order.
 */
export function buildIngestionPlan(candidate, scan, approval, fileHashes, branch) {
  const libraryEntry = buildLibraryEntry(candidate, scan, approval);
  const weightsEntry = buildWeightsEntry(candidate, fileHashes);
  const modelCard = generateModelCard(libraryEntry, scan);
  return {
    steps: [...INGESTION_STEPS],
    libraryEntry,
    weightsEntry,
    modelCard,
    commit: {
      repo: 'ronininc/kingmaker-brain-library', // private: pushes need a token that can write it (gh auth / KINGMAKER_LIBRARY_TOKEN)
      branch,
      files: [
        {
          path: `library/models/${candidate.id}.json`,
          content: JSON.stringify(libraryEntry, null, 2),
        },
        {
          path: `library/weights/${candidate.id}.json`,
          content: JSON.stringify(weightsEntry, null, 2),
        },
        { path: `library/cards/${candidate.id}.md`, content: modelCard },
      ],
      message: [
        `ingest model ${candidate.id}`,
        '',
        'The gate was tapped. Measurements are from the Stage 3 scan report;',
        'this commit only stages files — review the plan before merging.',
        '',
        `Approval signature: ${approval.signature}`,
        `Gate packet: ${approval.packetId}`,
        `Weight sha256: ${scan.integrity.sha256}`,
      ].join('\n'),
    },
  };
}

/** Thrown when the gate has not been validly tapped. The cage holds. */
export class GateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GateError';
  }
}

/**
 * Run Stage 5 ingestion. FIRST verifies the packet's own integrity and
 * validates the approval against the gate packet — anything short of
 * Robbie's valid tap throws GateError and NOTHING ingests. Then builds the
 * entries, the model card, and the plan, pins the measured weight hash in
 * the registry, and returns the plan plus receipt.
 *
 * opts: { candidate, scan, packet, approval, registry, fileHashes, branch, now? }
 * registry: { pin(candidateId, sha256) } — the only I/O, injected.
 */
export async function ingest(opts) {
  const { candidate, scan, packet, approval, registry, fileHashes, branch } = opts;
  // The packet must be intact before anything else is considered.
  const integrity = verifyPacketIntegrity(packet);
  if (!integrity.valid) {
    throw new GateError(
      `ingestion refused: ${integrity.reason} — the cage holds`,
    );
  }
  const check = validateApproval(approval, packet);
  if (!check.valid) {
    throw new GateError(`ingestion refused: ${check.reason} — the cage holds`);
  }
  if (approval.decision !== 'approved') {
    throw new GateError(
      'ingestion refused: the gate decision was not approved — the cage holds',
    );
  }
  const plan = buildIngestionPlan(candidate, scan, approval, fileHashes, branch);
  const receipt = await registry.pin(candidate.id, scan.integrity.sha256);
  return { plan, receipt };
}
