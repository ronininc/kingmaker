// Weight Hunter model forge: plan new task-specific models from hash-pinned donor models. This never claims that
// incompatible tensors can simply be concatenated. It chooses direct weight operations only where fingerprints prove
// compatibility; otherwise donors teach a new target through distillation, representation alignment, or trained grafts.
import { canonicalJson, sha256Hex } from './hash-util.mjs';
import { selectWeightHunterReferences } from './weight-hunter-references.mjs';

const HASH = /^[a-f0-9]{64}$/;
const STRATEGIES = new Set(['task-vector-merge', 'adapter-blend', 'expert-graft', 'representation-graft', 'distill']);

function requireDonor(donor) {
  if (!donor?.id || !HASH.test(donor.sha256 || '')) throw new Error('every donor needs an id and measured sha256');
  if (!donor.architecture?.family || !donor.architecture?.hiddenSize || !donor.tokenizer?.sha256) throw new Error(`donor ${donor.id} lacks an architecture or tokenizer fingerprint`);
  return donor;
}

export function donorCompatibility(left, right) {
  requireDonor(left); requireDonor(right);
  const sameBase = left.baseModel && left.baseModel === right.baseModel;
  const sameTokenizer = left.tokenizer.sha256 === right.tokenizer.sha256;
  const sameShape = left.architecture.family === right.architecture.family
    && left.architecture.hiddenSize === right.architecture.hiddenSize
    && left.architecture.layers === right.architecture.layers;
  const sameExpertShape = sameShape
    && left.architecture.expertSize
    && left.architecture.expertSize === right.architecture.expertSize;
  return {
    taskVector: Boolean(sameBase && sameTokenizer && sameShape),
    adapterBlend: Boolean(sameBase && sameTokenizer && left.adapterBase === right.adapterBase),
    expertGraft: Boolean(sameTokenizer && sameExpertShape),
    representationGraft: Boolean(left.architecture.hiddenSize && right.architecture.hiddenSize),
    distill: true,
  };
}

function strategyFor(donors, requested) {
  if (requested && !STRATEGIES.has(requested)) throw new Error(`unknown forge strategy ${requested}`);
  const pairs = donors.slice(1).map((donor) => donorCompatibility(donors[0], donor));
  const possible = {
    'task-vector-merge': pairs.every((pair) => pair.taskVector),
    'adapter-blend': pairs.every((pair) => pair.adapterBlend),
    'expert-graft': pairs.every((pair) => pair.expertGraft),
    'representation-graft': pairs.every((pair) => pair.representationGraft),
    distill: true,
  };
  if (requested) {
    if (!possible[requested]) throw new Error(`${requested} is incompatible with these donor fingerprints`);
    return requested;
  }
  return ['task-vector-merge', 'adapter-blend', 'expert-graft', 'representation-graft', 'distill'].find((name) => possible[name]);
}

/** Build a deterministic, reviewable training plan. No weights move and no training starts here. */
export function planForge({ task, donors, target, strategy = null, ownerApprovalRequired = true }) {
  const cleanTask = String(task || '').trim();
  if (!cleanTask) throw new Error('a forge task is required');
  if (!Array.isArray(donors) || donors.length < 2) throw new Error('a forge needs at least two donors');
  donors = donors.map(requireDonor);
  if (!target?.family || !target?.parameterBudgetB || !target?.license) throw new Error('the target architecture, parameter budget, and license are required');
  const selected = strategyFor(donors, strategy);
  const stages = [
    'verify-launcher-pins',
    'extract-task-evidence',
    ...(selected === 'distill' ? ['build-teacher-consensus', 'synthesize-and-filter-curriculum'] : []),
    ...(selected === 'representation-graft' ? ['learn-representation-projections', 'graft-selected-blocks'] : []),
    ...(selected === 'expert-graft' ? ['score-experts', 'transplant-compatible-experts'] : []),
    ...(selected === 'adapter-blend' ? ['measure-adapter-interference', 'blend-adapters'] : []),
    ...(selected === 'task-vector-merge' ? ['measure-task-vectors', 'merge-compatible-vectors'] : []),
    'train-target',
    'benchmark-against-each-donor',
    'red-team-and-license-check',
    'hash-new-weights',
    'owner-approval',
    'launcher-pin',
    'publish-paid-library-entry',
  ];
  const body = {
    schema: 'kingmaker.weight-hunter-forge/1',
    task: cleanTask,
    strategy: selected,
    referenceContext: selectWeightHunterReferences({ task: cleanTask, strategy: selected, forModelCandidate: true }),
    donors: donors.map((donor) => ({
      id: donor.id, sha256: donor.sha256, baseModel: donor.baseModel || null,
      license: donor.license || null, architecture: donor.architecture, tokenizer: donor.tokenizer,
      contributions: donor.contributions || [],
    })),
    target: { ...target },
    stages,
    gates: {
      ownerApprovalRequired,
      publishOnlyIfBetterThanBestDonor: true,
      requireFreshWeightHash: true,
      requireLauncherPin: true,
      retainDonorProvenance: true,
      paidLibraryOnly: true,
    },
  };
  return { ...body, planHash: sha256Hex(canonicalJson(body)) };
}

/** Bind completed new weights to the exact reviewed plan; this is the candidate that re-enters ingestion Stage 3. */
export function forgeCandidate(plan, { id, weightSha256, evaluationSha256, trainingReceiptSha256 }) {
  if (!plan?.planHash || !id || ![weightSha256, evaluationSha256, trainingReceiptSha256].every((hash) => HASH.test(hash || ''))) throw new Error('forge candidate evidence is incomplete');
  return {
    schema: 'kingmaker.forged-model-candidate/1', id, forgePlanHash: plan.planHash,
    weightSha256, evaluationSha256, trainingReceiptSha256,
    strategy: plan.strategy, task: plan.task,
    donorHashes: plan.donors.map((donor) => donor.sha256),
    state: 'awaiting-owner-approval',
  };
}
