// Direct reasoning for a self-contained prompt.
//
// A prompt that brings its own facts, rules, and numbers and asks for a plan, an answer, a
// calculation, or a decision is one local pass. It is not split, it does not search the web,
// and it does not ask the maturity gate. The pass uses a Brain Library method file
// (lib/method-conductor.mjs): an existing self-contained-reasoning method, or one written in
// that same format when the library has none. The weight hunter's model is the only model.

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMethodConductor, parseMethodFile } from './method-conductor.mjs';

export const REASONING_METHOD_ID = 'self-contained-reasoning';

export const REASONING_PREAMBLE = 'Think step by step. Quantify the options. Compute each total from the numbers in the prompt. Compare the totals. Then answer with the plan and the result. Use only the facts in the prompt. Do not look anything up and do not use tools.';

// A real action or lookup, including one that starts the sentence. "Open Notes" and
// "search the web" stay on their lanes. "Give me the plan" does not.
const LEAD_ACT = /^(?:please\s+)?(?:send|text|message|whatsapp|e-?mail|call|pay|charge|refund|open|launch|install|deploy|delete|remove|book|post|publish|search|google|look\s+up|find|probe|check|run|fetch|browse)\b/i;
const TOOL = /\b(?:search(?:\s+the\s+web)?|google|look\s+up|browse|wikipedia|https?:\/\/|www\.|whatsapp|e-?mail|pay|charge|refund|install|deploy|publish|probe|check\s+stripe|check\s+github|on\s+my\s+(?:mac|desktop|computer|laptop)|my\s+desktop)\b/i;
// "then email it" is a second action. "then your expected final score" is the same question.
const TOOL_THEN = /\bthen\s+(?:please\s+)?(?:probe|check|send|e-?mail|text|pay|open|run|fetch|search|install|deploy|post|book|delete|write|draft|find|look\s+up)\b/i;
const SYLLOGISM = /\ball\b[^.?!]{0,80}\bare\b/i;
// A closed puzzle: numbers plus a score, cost, or points, and a request to plan or answer.
// "Plan a 2 week vacation" and "a 500 word essay comparing two cities" are not this.
const PUZZLE_UNIT = /\b(?:points?|scores?|\$|costs?|priced?|targets?|percent|%)\b/i;
const PUZZLE_ASK = /\b(?:plans?|solve|decide|how\s+much|how\s+many|expected|which\s+option|answer)\b/i;

/** Kingmaker's own readiness. A score inside a puzzle is not this. */
export function isExplicitReadiness(t) {
  const kingmakerReadiness = /\bkingmaker\b/i.test(t) && /\b(ready|readiness|clon\w*|matur\w*|missing|how\s+close|when\s+can|exist\w*|gate)\b/i.test(t);
  const self = /\b(solomon|you|your|yourself|you're|youre)\b/i.test(t);
  const readiness = /\b(matur(?:e|ity)|readiness|clon(?:e|ed|ing)\s+(?:you|yourself|solomon))\b/i.test(t);
  const standing = /\byour\s+(?:own\s+)?(?:pass\s*rates?|benchmarks?|sbench|grades?)\b|\bhow\s+(?:good|well)\s+are\s+you\s+(?:doing|performing|scoring)\b/i.test(t);
  return kingmakerReadiness || (self && readiness) || standing;
}

/**
 * True when the prompt supplies the facts and asks for a plan, answer, calculation, or
 * decision, and does not ask Kingmaker to look something up or act on the machine.
 */
export function isSelfContainedReasoningPrompt(text) {
  const t = String(text ?? '').trim();
  if (t.length < 12) return false;
  if (isExplicitReadiness(t)) return false;
  if (LEAD_ACT.test(t) || TOOL.test(t) || TOOL_THEN.test(t)) return false;
  if (SYLLOGISM.test(t) && /\b(?:are\s+all|answer|so\b|therefore)\b/i.test(t)) return true;
  return /\d/.test(t) && PUZZLE_UNIT.test(t) && PUZZLE_ASK.test(t);
}

/** The reasoning method already in a conductor listing, highest quality first. */
export function pickReasoningMethod(methods) {
  const hits = (methods ?? []).filter((m) => m.kind === 'self-contained-reasoning' || m.id === REASONING_METHOD_ID);
  hits.sort((a, b) => (b.quality?.score ?? 0) - (a.quality?.score ?? 0) || String(a.id).localeCompare(String(b.id)));
  return hits[0] ?? null;
}

/** The method file Kingmaker writes when the library has none for this kind of problem. */
export function reasoningMethodDocument() {
  const spec = {
    id: REASONING_METHOD_ID,
    version: '1.0',
    title: 'Self-contained reasoning',
    domain: 'puzzle',
    kind: 'self-contained-reasoning',
    inputs: { prompt: '' },
    steps: [
      { n: 1, id: 'quantify', type: 'note', text: 'Quantify every option using only the numbers and rules in the prompt.' },
      { n: 2, id: 'compute', type: 'note', text: 'Compute a total for each option from those numbers.' },
      { n: 3, id: 'compare', type: 'note', text: 'Compare the totals.' },
      { n: 4, id: 'decide', type: 'reason', into: 'answer', preamble: REASONING_PREAMBLE, prompt: '{{inputs.prompt}}' },
    ],
  };
  return `# Method — Self-contained reasoning

A method file for a closed problem. The prompt supplies the facts, the rules, and the numbers, and asks for a plan, a total, or a decision. Nothing is looked up. The hunter-picked model runs the procedure once.

## Trigger

The owner pasted a self-contained problem (a score to maximize, a word problem, a syllogism) and asked for the plan or the answer.

## Steps

1. Quantify each option from the numbers in the prompt.
2. Compute each total.
3. Compare the totals.
4. Decide, and state the plan and the expected result.

## Executable block

\`\`\`kingmaker-method
${JSON.stringify(spec, null, 2)}
\`\`\`
`;
}

/** The one prompt the hunter-picked model sees: preamble, method, problem. */
export function buildDirectReasoningPrompt({ preamble, methodText, prompt }) {
  return [
    preamble || REASONING_PREAMBLE,
    '',
    'Follow this method in one pass. No tools, no web, no other model.',
    '',
    String(methodText ?? '').trim(),
    '',
    'Problem:',
    String(prompt ?? '').trim(),
  ].join('\n');
}

/** Write a method file plus its index. Returns the index URL the conductor reads. */
export async function writeReasoningMethod(dir) {
  await mkdir(dir, { recursive: true });
  const file = `${REASONING_METHOD_ID}.method.md`;
  const text = reasoningMethodDocument();
  parseMethodFile(text);
  await writeFile(join(dir, file), text);
  const index = {
    schema: 'kingmaker.methods/1',
    qualityTiers: ['draft', 'community', 'vetted', 'canonical'],
    methods: [{
      id: REASONING_METHOD_ID,
      title: 'Self-contained reasoning',
      domain: 'puzzle',
      file,
      quality: {
        tier: 'draft',
        score: 70,
        basis: 'Written locally for a self-contained reasoning problem: quantify, compute, compare, decide. No web.',
      },
    }],
  };
  const indexPath = join(dir, 'index.json');
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  return pathToFileURL(indexPath);
}

/**
 * Find or write the reasoning method, then conduct it. `complete(model, prompt)` is the one
 * local generation. `model` is the hunter's pick and is the only model passed to `complete`.
 */
export async function runDirectReasoning({ text, model, complete, workDir, localDir = null, conductor = null } = {}) {
  if (!model) throw new Error('direct-reasoning: the hunter-picked model is required');
  if (typeof complete !== 'function') throw new Error('direct-reasoning: complete() is required');
  let active = conductor ?? createMethodConductor();
  let picked = pickReasoningMethod(await active.listMethods());
  let wrote = false;
  if (!picked) {
    const methodDir = localDir ?? await mkdtemp(join(tmpdir(), 'kingmaker-method-'));
    const indexUrl = await writeReasoningMethod(methodDir);
    active = createMethodConductor({ indexUrl });
    picked = pickReasoningMethod(await active.listMethods());
    wrote = true;
  }
  if (!picked) throw new Error('direct-reasoning: no reasoning method');
  const scratch = workDir ?? await mkdtemp(join(tmpdir(), 'kingmaker-reason-'));
  let calls = 0;
  const result = await active.conduct(picked.id, {
    workDir: scratch,
    inputs: { prompt: text, model },
    reasoner: async ({ preamble, prompt, methodText }) => {
      calls += 1;
      if (calls !== 1) throw new Error('direct reasoning runs in one pass');
      return complete(model, buildDirectReasoningPrompt({ preamble, methodText, prompt }));
    },
  });
  if (calls !== 1) throw new Error('direct reasoning runs in one pass');
  if (result.status !== 'completed') throw new Error(result.reason || 'direct reasoning did not complete');
  const answer = String(result.outputs?.answer ?? '').trim();
  if (!answer) throw new Error('direct reasoning produced no answer');
  return { answer, methodId: picked.id, wrote, model, swap: false, calls };
}
