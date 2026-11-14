// Tests for the reflex layer wiring (lib/reflex-layer.mjs over lib/decision-router.mjs): decision-shaped requests
// are answered by the System One router first, confidence bands route/escalate, failures fall back, the kill
// switch restores the legacy flow, and every disposition is audit-chained.
// Run: node tests/reflex-layer.test.mjs
import assert from 'node:assert/strict';
import { DecisionRouter } from '../lib/decision-router.mjs';
import { chainAuditSink, createReflexLayer, decisionBriefText, decisionVerdictLine, isDecisionRequest, reflexEnabled } from '../lib/reflex-layer.mjs';
import { createChain, verifyChain } from '../lib/audit-chain.mjs';

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; console.log(`  ok - ${name}`); };

const REQ = {
  decision: {
    state: { text: 'Your invoice is ready to view' },
    questions: { is_scam: { options: ['scam', 'legit'] } },
  },
};
const fetchReturning = (probs) => async () => ({ ok: true, json: async () => ({ answers: { is_scam: { probabilities: probs } } }) });
const mkRouter = (fetchImpl, calibration) => new DecisionRouter({ model: 'laya', baseUrl: 'http://127.0.0.1:11434', fetchImpl, ...(calibration ? { calibration } : {}) });
const spy = () => { const f = async (...args) => { f.calls.push(args); return { answeredBy: 'spy' }; }; f.calls = []; return f };

/* ---------------- detector ---------------- */
{
  ok('envelope decision request detected', isDecisionRequest(REQ));
  ok('bare decision request detected', isDecisionRequest(REQ.decision));
  ok('score question detected', isDecisionRequest({ questions: { risk: { kind: 'score' } } }));
  ok('free text is not a decision request', !isDecisionRequest('send the invoice to the client'));
  ok('one-option choice is not decision-shaped', !isDecisionRequest({ questions: { q: { options: ['only'] } } }));
  ok('empty questions are not decision-shaped', !isDecisionRequest({ questions: {} }));
  ok('one bad question poisons the bundle', !isDecisionRequest({ questions: { a: { options: ['x', 'y'] }, b: { prompt: 'open-ended?' } } }));
  ok('null and arrays are not decision requests', !isDecisionRequest(null) && !isDecisionRequest([{ questions: {} }]));
}

/* ---------------- kill switch ---------------- */
{
  ok('kill switch: KINGMAKER_REFLEX=off disables', !reflexEnabled({ env: { KINGMAKER_REFLEX: 'off' } }));
  ok('kill switch: 0 and false disable', !reflexEnabled({ env: { KINGMAKER_REFLEX: '0' } }) && !reflexEnabled({ env: { KINGMAKER_REFLEX: 'false' } }));
  ok('kill switch: config on:false disables', !reflexEnabled({ env: {}, config: { on: false } }));
  ok('kill switch: env beats config', !reflexEnabled({ env: { KINGMAKER_REFLEX: 'off' }, config: { on: true } }));
  ok('default is on', reflexEnabled({ env: {} }) && reflexEnabled({ env: { KINGMAKER_REFLEX: 'on' } }));
}

/* ---------------- confidence bands ---------------- */
{
  // >= 0.9: the reflex answers; the reasoning brain is NEVER woken.
  const chain = createChain('test-reflex');
  const reasoning = spy(); const escalate = spy();
  const layer = createReflexLayer({ router: mkRouter(fetchReturning({ scam: 0.03, legit: 0.97 })), reasoning, escalate, audit: chainAuditSink(chain) });
  const r = await layer.handle(REQ);
  ok('high confidence answered by reflex', r.answeredBy === 'reflex' && r.via === 'reflex');
  ok('high confidence never wakes reasoning', reasoning.calls.length === 0 && escalate.calls.length === 0);
  ok('verdict attached to the reflex result', r.reflexVerdicts[0].kind === 'auto-proceed');
  ok('audit entry written for auto-proceed', chain.some((e) => e.action === 'reflex.auto-proceed'));
  ok('audit meta carries the top probability', chain.at(-1).meta.verdicts[0].top === 0.97);
  ok('verdict line names the top answer', decisionVerdictLine(r.reflexVerdicts).includes('legit (0.97)'));
  ok('chain verifies', verifyChain(chain).ok);
}
{
  // 0.6..0.9: reasoning runs WITH the verdict attached as context.
  const chain = createChain('test-reflex');
  const reasoning = spy(); const escalate = spy();
  const layer = createReflexLayer({ router: mkRouter(fetchReturning({ scam: 0.25, legit: 0.75 })), reasoning, escalate, audit: chainAuditSink(chain) });
  await layer.handle(REQ);
  ok('mid confidence routes to reasoning', reasoning.calls.length === 1 && escalate.calls.length === 0);
  const ctx = reasoning.calls[0][1];
  ok('route-to-reasoning carries the verdict as context', ctx.via === 'reflex' && ctx.reflexVerdicts[0].kind === 'route-to-reasoning');
  ok('the brief text carries the verdict', decisionBriefText(REQ, ctx).includes('route-to-reasoning') || decisionBriefText(REQ, ctx).includes('top answer legit at 0.750'));
  ok('audit entry written for route-to-reasoning', chain.some((e) => e.action === 'reflex.route-to-reasoning'));
}
{
  // < 0.6: the escalation path, not reasoning, not auto-proceed.
  const chain = createChain('test-reflex');
  const reasoning = spy(); const escalate = spy();
  const layer = createReflexLayer({ router: mkRouter(fetchReturning({ scam: 0.55, legit: 0.45 })), reasoning, escalate, audit: chainAuditSink(chain) });
  await layer.handle(REQ);
  ok('low confidence escalates', escalate.calls.length === 1 && reasoning.calls.length === 0);
  ok('escalation context carries the verdict', escalate.calls[0][1].via === 'reflex-escalate' && escalate.calls[0][1].reflexVerdicts[0].kind === 'escalate');
  ok('audit entry written for escalate', chain.some((e) => e.action === 'reflex.escalate'));
}
{
  // < 0.6 with NO escalation handler wired: reasoning takes it, flagged escalated. Never dropped.
  const reasoning = spy();
  const layer = createReflexLayer({ router: mkRouter(fetchReturning({ scam: 0.55, legit: 0.45 })), reasoning });
  await layer.handle(REQ);
  ok('escalation without a handler lands on reasoning, flagged', reasoning.calls.length === 1 && reasoning.calls[0][1].escalated === true);
}

/* ---------------- failure falls back, never hard-fails ---------------- */
{
  const chain = createChain('test-reflex');
  const reasoning = spy();
  const down = async () => { throw new Error('connect ECONNREFUSED'); };
  const layer = createReflexLayer({ router: mkRouter(down), reasoning, audit: chainAuditSink(chain) });
  const r = await layer.handle(REQ);
  ok('router down falls back to reasoning', reasoning.calls.length === 1 && reasoning.calls[0][1].via === 'reflex-fallback');
  ok('fallback returns the reasoning result', r.answeredBy === 'spy');
  ok('audit entry written for fallback', chain.some((e) => e.action === 'reflex.fallback'));
}
{
  const reasoning = spy();
  const http500 = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const layer = createReflexLayer({ router: mkRouter(http500), reasoning });
  await layer.handle(REQ);
  ok('endpoint HTTP 500 falls back to reasoning', reasoning.calls.length === 1 && reasoning.calls[0][1].via === 'reflex-fallback');
}
{
  // A wedged endpoint: the layer's own timeout fires and the request still lands on reasoning, promptly.
  const reasoning = spy();
  const wedged = () => new Promise(() => {});
  const layer = createReflexLayer({ router: mkRouter(wedged), reasoning, timeoutMs: 50 });
  const t0 = Date.now();
  await layer.handle(REQ);
  ok('wedged router times out to reasoning', reasoning.calls.length === 1 && reasoning.calls[0][1].via === 'reflex-fallback');
  ok('timeout fallback is prompt', Date.now() - t0 < 1500);
  ok('timeout reason is attached', /timeout/.test(reasoning.calls[0][1].reflexError ?? ''));
}

/* ---------------- kill switch / legacy flow ---------------- */
{
  const chain = createChain('test-reflex');
  const reasoning = spy();
  let fetches = 0;
  const counting = async () => { fetches += 1; return { ok: true, json: async () => ({ answers: {} }) }; };
  const layer = createReflexLayer({ router: mkRouter(counting), reasoning, enabled: reflexEnabled({ env: { KINGMAKER_REFLEX: 'off' } }), audit: chainAuditSink(chain) });
  ok('layer reports inactive when switched off', layer.active === false);
  const r = await layer.handle(REQ);
  ok('kill switch: decision request takes the legacy path', reasoning.calls.length === 1 && reasoning.calls[0][1].via === 'legacy');
  ok('kill switch: the router is never called', fetches === 0);
  ok('kill switch: the request passes through by reference', reasoning.calls[0][0] === REQ);
  ok('kill switch: no reflex audit entries', chain.length === 1);
  ok('legacy result is returned untouched', r.answeredBy === 'spy');
}
{
  // Non-decision requests pass through untouched even with the layer live.
  const reasoning = spy();
  let fetches = 0;
  const counting = async () => { fetches += 1; return { ok: true, json: async () => ({ answers: {} }) }; };
  const layer = createReflexLayer({ router: mkRouter(counting), reasoning });
  const text = 'what is the capital of Japan';
  await layer.handle(text);
  ok('non-decision request passes to reasoning by reference', reasoning.calls.length === 1 && reasoning.calls[0][0] === text && reasoning.calls[0][1].via === 'legacy');
  ok('non-decision request never touches the router', fetches === 0);
}
{
  assert.throws(() => createReflexLayer({ router: mkRouter(fetchReturning({})) }), /reasoning handler is required/);
  passed += 1; console.log('  ok - a layer without a reasoning handler refuses to build');
}

console.log(`\nreflex-layer: ${passed} passed`);
