// Tests for the 2026-11-13 wire-up seam (lib/reflex-layer.mjs validation + lib/systemone-server.mjs routing):
// the router's raw answers are validated against each question's declared answer space before any band is
// read — a malformed or prose-carrying answer is a NAMED transport failure and falls back, never passed
// through — the audit trail carries each verdict's FULL probability map, and the system-one route defaults
// to the in-tree adapter (the only route Ollama can actually serve for the registry models), with
// KINGMAKER_SYSTEMONE=ollama/off restoring the direct route byte for byte.
// Run: node tests/reflex-seam.test.mjs
import assert from 'node:assert/strict';
import { DecisionRouter } from '../lib/decision-router.mjs';
import { chainAuditSink, createReflexLayer, decisionAnswerProblem, validateDecisionOutcomes } from '../lib/reflex-layer.mjs';
import { createChain, verifyChain } from '../lib/audit-chain.mjs';
import { resolveSystemOneRoute, systemOneShimEnabled } from '../lib/systemone-server.mjs';

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; console.log(`  ok - ${name}`); };

const REQ = {
  decision: {
    state: { text: 'Your invoice is ready to view' },
    questions: { is_scam: { options: ['scam', 'legit'] } },
  },
};
const fetchReturning = (answers) => async () => ({ ok: true, json: async () => ({ answers }) });
const mkRouter = (fetchImpl) => new DecisionRouter({ model: 'laya', baseUrl: 'http://127.0.0.1:11434', fetchImpl });
const spy = () => { const f = async (...args) => { f.calls.push(args); return { answeredBy: 'spy' }; }; f.calls = []; return f };

/* ---------------- the route: local adapter by default, direct on the named opt-out ---------------- */
{
  ok('route: unset env starts the in-tree adapter', resolveSystemOneRoute({ env: {} }).shim === true);
  ok('route: the adapter route points at the loopback shim port', resolveSystemOneRoute({ env: {} }).baseUrl === 'http://127.0.0.1:11435');
  ok('route: KINGMAKER_SYSTEMONE=local still names the adapter', resolveSystemOneRoute({ env: { KINGMAKER_SYSTEMONE: 'local' } }).shim === true);
  ok('route: KINGMAKER_SYSTEMONE=ollama restores the direct route', resolveSystemOneRoute({ env: { KINGMAKER_SYSTEMONE: 'ollama' } }).shim === false
    && resolveSystemOneRoute({ env: { KINGMAKER_SYSTEMONE: 'ollama' } }).baseUrl === 'http://127.0.0.1:11434');
  ok('route: an off word restores the direct route', resolveSystemOneRoute({ env: { KINGMAKER_SYSTEMONE: 'off' } }).shim === false);
  ok('route: the port override still rides', resolveSystemOneRoute({ env: { KINGMAKER_SYSTEMONE_PORT: '12345' } }).baseUrl === 'http://127.0.0.1:12345');
  ok('shimEnabled: default on, opt-outs off', systemOneShimEnabled({ env: {} }) === true
    && systemOneShimEnabled({ env: { KINGMAKER_SYSTEMONE: 'ollama' } }) === false
    && systemOneShimEnabled({ env: { KINGMAKER_SYSTEMONE: '0' } }) === false);
}

/* ---------------- the answer validator, pure ---------------- */
{
  const q = { options: ['scam', 'legit'] };
  ok('a clean probability map passes', decisionAnswerProblem(q, { probabilities: { scam: 0.03, legit: 0.97 } }) === null);
  ok('prose instead of a map is malformed', /not a typed probability map/.test(decisionAnswerProblem(q, { answer: 'it looks legit to me' }) ?? ''));
  ok('a string probability is malformed', /not a number in \[0,1\]/.test(decisionAnswerProblem(q, { probabilities: { scam: 'low', legit: 0.97 } }) ?? ''));
  ok('an invented option is malformed', /outside the declared answer space/.test(decisionAnswerProblem(q, { probabilities: { scam: 0.03, legit: 0.9, maybe: 0.07 } }) ?? ''));
  ok('a map that does not sum to 1 is malformed', /sum to 0\.400, not 1/.test(decisionAnswerProblem(q, { probabilities: { scam: 0.2, legit: 0.2 } }) ?? ''));
  ok('a stated winner outside the space is malformed', /stated answer/.test(decisionAnswerProblem(q, { answer: 'maybe', probabilities: { scam: 0.03, legit: 0.97 } }) ?? ''));
  ok('a score rating passes', decisionAnswerProblem({ kind: 'score' }, { probabilities: { score: 0.93 } }) === null);
  ok('a score over level labels passes', decisionAnswerProblem({ kind: 'score', criteria: ['low', 'high'] }, { probabilities: { low: 0.25, high: 0.75 } }) === null);
  const outs = validateDecisionOutcomes(REQ.decision, [
    { kind: 'auto-proceed', questionName: 'is_scam', answer: { probabilities: { scam: 0.5, legit: 0.5, bogus: 0.5 } } },
    { kind: 'transport-failed', questionName: 'other', reason: 'endpoint returned HTTP 500' },
  ]);
  ok('validation rewrites only the malformed outcome', outs[0].kind === 'transport-failed' && /malformed reflex answer for "is_scam"/.test(outs[0].reason) && outs[1].reason === 'endpoint returned HTTP 500');
}

/* ---------------- the seam in the layer: malformed never bands, never auto-proceeds ---------------- */
{
  const chain = createChain('test-seam');
  const reasoning = spy(); const escalate = spy();
  const layer = createReflexLayer({ router: mkRouter(fetchReturning({ is_scam: { probabilities: { scam: 0.03, legit: 0.97, unsure: 0.5 } } })), reasoning, escalate, audit: chainAuditSink(chain) });
  const r = await layer.handle(REQ);
  ok('an invented option falls back to reasoning', reasoning.calls.length === 1 && escalate.calls.length === 0 && r.answeredBy === 'spy');
  ok('the fallback names the malformation', /malformed reflex answer for "is_scam"/.test(reasoning.calls[0][1].reflexError ?? ''));
  ok('the fallback is audited as a fallback', chain.some((e) => e.action === 'reflex.fallback'));
  ok('chain verifies', verifyChain(chain).ok);
}
{
  // Prose in place of probabilities: the exact leak the seam exists to stop.
  const reasoning = spy();
  const layer = createReflexLayer({ router: mkRouter(fetchReturning({ is_scam: { answer: 'legit', note: 'the sender looks fine' } })), reasoning });
  await layer.handle(REQ);
  ok('a prose-carrying answer falls back, never auto-proceeds', reasoning.calls.length === 1 && reasoning.calls[0][1].via === 'reflex-fallback');
}
{
  // A well-formed answer still bands exactly as before — and the audit now carries the full map.
  const chain = createChain('test-seam');
  const reasoning = spy();
  const layer = createReflexLayer({ router: mkRouter(fetchReturning({ is_scam: { probabilities: { scam: 0.03, legit: 0.97 } } })), reasoning, audit: chainAuditSink(chain) });
  const r = await layer.handle(REQ);
  ok('a clean map still auto-proceeds', r.answeredBy === 'reflex' && reasoning.calls.length === 0);
  const entry = chain.find((e) => e.action === 'reflex.auto-proceed');
  ok('audit verdict carries the top probability', entry.meta.verdicts[0].top === 0.97);
  assert.deepEqual(entry.meta.verdicts[0].probabilities, { scam: 0.03, legit: 0.97 });
  passed += 1; console.log('  ok - audit verdict carries the FULL probability map');
}
{
  // Score questions ride the same seam (the in-tree endpoint's {'score': rating} convention).
  const chain = createChain('test-seam');
  const reasoning = spy();
  const layer = createReflexLayer({ router: mkRouter(fetchReturning({ risk: { probabilities: { score: 0.93 } } })), reasoning, audit: chainAuditSink(chain) });
  const r = await layer.handle({ decision: { state: { text: 'x' }, questions: { risk: { kind: 'score' } } } });
  ok('a confident score rating auto-proceeds', r.answeredBy === 'reflex');
  ok('the score map is in the audit trail', chain.find((e) => e.action === 'reflex.auto-proceed').meta.verdicts[0].probabilities.score === 0.93);
}

console.log(`\nreflex-seam: ${passed} passed`);
