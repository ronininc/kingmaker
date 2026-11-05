// Original task-selection metadata. No upstream imports, prompt injection, network, models or execution.
import catalog from './weight-hunter-references.json' with { type: 'json' };
import { canonicalJson, sha256Hex } from './hash-util.mjs';

const freeze = (value) => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
export const WEIGHT_HUNTER_REFERENCES = freeze(catalog.entries);

/** Select locally authored context, never runnable components or new authority. No model inference needed. */
export function selectWeightHunterReferences({ task = '', strategy = null, forModelCandidate = false } = {}) {
  if (typeof task !== 'string' || task.length > 16_384) throw new Error('bounded task text required');
  const categories = new Set();
  if (/\b(?:rout(?:e|er|ers|ing)|classif(?:y|ier|ication)|cost|budget|latency|cheap|cheaper)\b/i.test(task)) categories.add('routing');
  if (/\b(?:cod(?:e|er|ing)|bash|sql|programming|tool[ -]use|interactive)\b/i.test(task)) categories.add('coding');
  if (strategy === 'distill' || /\b(?:ensembl(?:e|ing)|rank.*answers?|fuse|fusion|distill(?:ation)?|teacher|consensus|best.of.n)\b/i.test(task)) categories.add('ensemble');
  if (forModelCandidate || /\b(?:weight hunter|model|models|checkpoint|checkpoints|benchmark|evaluation|evaluate|leaderboard)\b/i.test(task)) {
    categories.add('evaluation'); categories.add('ranking');
  }
  const references = WEIGHT_HUNTER_REFERENCES.filter((entry) => entry.evidenceEligible && categories.has(entry.category));
  const exclusions = WEIGHT_HUNTER_REFERENCES.filter((entry) => !entry.evidenceEligible).map(({ id, limitation }) => ({ id, reason: limitation }));
  const body = {
    schema: 'kingmaker.weight-hunter-reference-context/1',
    references,
    exclusions: references.length ? exclusions : [],
    retrieval: 'cached-pinned-reference',
    executable: false,
    authorityGranted: false,
    assessment: references.length ? {
      objective: 'Improve measured task outcomes within memory, latency, cost and license limits.',
      requiredEvidence: ['held-out task outcomes', 'best-donor baseline', 'peak memory and latency', 'cost and provider privacy', 'judge bias and uncertainty', 'dataset overlap and license review', 'regression and Armor checks'],
      adoption: 'References alone cannot approve downloads, execution, training, adoption or publication.',
      concurrency: 1,
    } : null,
  };
  return freeze({ ...body, contextSha256: sha256Hex(canonicalJson(body)) });
}

/** Include context in the existing Brain Library knowledge lane; never selectable as a tool/model/skill. */
export function weightHunterLibraryReferences() {
  return WEIGHT_HUNTER_REFERENCES.map((entry) => {
    const content = canonicalJson({ purpose: entry.purpose, limitation: entry.limitation, evidenceEligible: entry.evidenceEligible });
    return {
      id: entry.id, type: 'knowledge-reference', trust: 'untrusted-reference', executionDisabled: true,
      selectableAs: [], capabilities: [], excludedCapabilities: ['execution', 'network', 'credentials', 'training', 'model-adoption'],
      title: entry.repository, content, contentSha256: sha256Hex(content),
      provenance: { source: `https://github.com/${entry.repository}`, commit: entry.commit, tree: entry.tree, license: entry.license,
        licenseNoticeSha256: entry.licenseNoticeSha256, riskReportSha256: entry.riskReportSha256 },
    };
  });
}
