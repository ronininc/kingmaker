// Tests for the reflex producers (lib/reflex-producers.mjs): payload well-formedness against the router contract,
// verdict→disposition mapping per band, fallback on off/error/timeout, audit through the shared #115 sink (state
// never logged), and the first wired call site — lane routing in lib/fast-route.mjs — exercised end to end with
// fakes: DecisionRouter (fake fetch) → producer → layer → routeLane. No live Ollama anywhere in this file.
// Run: node tests/reflex-producers.test.mjs
import assert from 'node:assert/strict';
import { DecisionRouter } from '../lib/decision-router.mjs';
import { chainAuditSink, isDecisionRequest } from '../lib/reflex-layer.mjs';
import { answersOf, buildDecisionRequest, createReflexProducer, topAnswerOf } from '../lib/reflex-producers.mjs';
import { routeLane } from '../lib/fast-route.mjs';
import { createChain, verifyChain } from '../lib/audit-chain.mjs';

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; console.log(`  ok - ${name}`); };
const throws = (name, fn, pattern) => { assert.throws(fn, pattern); passed += 1; console.log(`  ok - ${name}`); };

const mkRouter = (fetchImpl, calibration) => new DecisionRouter({ model: 'laya', baseUrl: 'http://127.0.0.1:11434', fetchImpl, ...(calibration ? { calibration } : {}) });
const fetchReturning = (answers) => async () => ({ ok: true, json: async () => ({ answers }) });
const GATE = { state: { candidate: 'some-model', publisher: 'someone' }, questions: { proceed: { options: ['proceed', 'hold'] } } };

/* ---------------- payload well-formedness against the router contract ---------------- */
{
  const req = buildDecisionRequest(GATE);
  ok('built request is decision-shaped', isDecisionRequest(req));
  ok('built request carries the envelope', req.decision.state === GATE.state && req.decision.questions === GATE.questions);
  ok('score question is accepted', isDecisionRequest(buildDecisionRequest({ state: { x: 1 }, questions: { risk: { kind: 'score' } } })));
  throws('non-object state is refused', () => buildDecisionRequest({ state: 'text', questions: GATE.questions }), /state must be a typed snapshot/);
  throws('array state is refused', () => buildDecisionRequest({ state: [], questions: GATE.questions }), /state must be a typed snapshot/);
  throws('missing questions are refused', () => buildDecisionRequest({ state: {} }), /questions must be an object/);
  throws('empty questions are refused', () => buildDecisionRequest({ state: {}, questions: {} }), /at least one question/);
  throws('one-option choice is refused', () => buildDecisionRequest({ state: {}, questions: { q: { options: ['only'] } } }), /no fixed answer space/);
  throws('open-ended question is refused', () => buildDecisionRequest({ state: {}, questions: { q: { prompt: 'what do you think?' } } }), /no fixed answer space/);
  throws('65 questions exceed the endpoint cap', () => buildDecisionRequest({ state: {}, questions: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`q${i}`, { options: ['a', 'b'] }])) }), /exceeds the endpoint cap/);
}

/* ---------------- verdict → disposition mapping, per band ---------------- */
{
  // >= 0.9: auto-proceed, the top answer mapped into the caller's own decision type.
  const p = createReflexProducer({ router: mkRouter(fetchReturning({ proceed: { probabilities: { proceed: 0.97, hold: 0.03 } } })) });
  const d = await p.decide(GATE, { map: { proceed: { proceed: true, hold: false } } });
  ok('high confidence is auto-proceed', d.disposition === 'auto-proceed' && d.via === 'reflex');
  ok('top answer is carried', d.answers.proceed.option === 'proceed' && d.answers.proceed.probability === 0.97);
  ok('option map lands as the caller value', d.answers.proceed.value === true);
  ok('verdict rides along', d.verdicts[0].kind === 'auto-proceed');
}
{
  // 0.6..0.9: route-to-reasoning, verdict attached for the caller's own reasoning path.
  const p = createReflexProducer({ router: mkRouter(fetchReturning({ proceed: { probabilities: { proceed: 0.75, hold: 0.25 } } })) });
  const d = await p.decide(GATE);
  ok('mid confidence routes to reasoning', d.disposition === 'route-to-reasoning');
  ok('mid verdict is attached', d.verdicts[0].kind === 'route-to-reasoning' && d.answers.proceed.option === 'proceed');
  ok('unmapped answers carry no value', !('value' in d.answers.proceed));
}
{
  // < 0.6: escalate — and one low question escalates a whole bundle, as the layer rules it.
  const p = createReflexProducer({ router: mkRouter(fetchReturning({ proceed: { probabilities: { proceed: 0.45, hold: 0.55 } }, second: { probabilities: { a: 0.99, b: 0.01 } } })) });
  const d = await p.decide({ state: { x: 1 }, questions: { proceed: { options: ['proceed', 'hold'] }, second: { options: ['a', 'b'] } } });
  ok('low confidence escalates', d.disposition === 'escalate' && d.via === 'reflex-escalate');
  ok('one low verdict escalates the bundle', d.verdicts.some((v) => v.kind === 'escalate'));
}
{
  // A function map translates every top answer.
  const p = createReflexProducer({ router: mkRouter(fetchReturning({ proceed: { probabilities: { proceed: 0.95, hold: 0.05 } } })) });
  const d = await p.decide(GATE, { map: (name, option) => `${name}:${option}` });
  ok('function map translates the answer', d.answers.proceed.value === 'proceed:proceed');
  ok('topAnswerOf reads an outcome', topAnswerOf({ answer: { probabilities: { a: 0.2, b: 0.8 } } })?.option === 'b');
  ok('answersOf tolerates no outcomes', Object.keys(answersOf([])).length === 0 && Object.keys(answersOf(null)).length === 0);
}

/* ---------------- fallback and legacy: a producer never makes a caller less reliable ---------------- */
{
  const down = async () => { throw new Error('connect ECONNREFUSED'); };
  const p = createReflexProducer({ router: mkRouter(down) });
  const d = await p.decide(GATE);
  ok('router down resolves as fallback', d.disposition === 'fallback' && d.via === 'reflex-fallback');
  ok('fallback carries the failure', /ECONNREFUSED/.test(d.reflexError ?? ''));
}
{
  const http500 = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const p = createReflexProducer({ router: mkRouter(http500) });
  const d = await p.decide(GATE);
  ok('endpoint HTTP 500 resolves as fallback', d.disposition === 'fallback');
}
{
  const wedged = () => new Promise(() => {});
  const p = createReflexProducer({ router: mkRouter(wedged), timeoutMs: 50 });
  const t0 = Date.now();
  const d = await p.decide(GATE);
  ok('wedged router times out to fallback', d.disposition === 'fallback' && /timeout/.test(d.reflexError ?? ''));
  ok('timeout fallback is prompt', Date.now() - t0 < 1500);
}
{
  // A malformed spec is the caller's bug: decide rejects, loudly, instead of guessing.
  const p = createReflexProducer({ router: mkRouter(fetchReturning({})) });
  await assert.rejects(() => p.decide({ state: {}, questions: { q: { prompt: 'open?' } } }), /no fixed answer space/);
  passed += 1; console.log('  ok - decide rejects a malformed spec');
}
{
  // Kill switch / no router: legacy, and the router is never called.
  let fetches = 0;
  const counting = async () => { fetches += 1; return { ok: true, json: async () => ({ answers: {} }) }; };
  const off = createReflexProducer({ router: mkRouter(counting), enabled: false });
  const d1 = await off.decide(GATE);
  ok('switched-off producer resolves legacy', d1.disposition === 'legacy' && off.active === false);
  const none = createReflexProducer({ router: null });
  const d2 = await none.decide(GATE);
  ok('routerless producer resolves legacy', d2.disposition === 'legacy' && none.active === false);
  ok('legacy never calls the router', fetches === 0);
}

/* ---------------- audit: through the shared #115 sink, the state never logged ---------------- */
{
  const chain = createChain('test-producers');
  const audit = chainAuditSink(chain);
  const good = createReflexProducer({ router: mkRouter(fetchReturning({ proceed: { probabilities: { proceed: 0.97, hold: 0.03 } } })), audit });
  await good.decide({ state: { secret: 'STATE-MARKER-7f3' }, questions: GATE.questions });
  const down = createReflexProducer({ router: mkRouter(async () => { throw new Error('down'); }), audit });
  await down.decide({ state: { secret: 'STATE-MARKER-7f3' }, questions: GATE.questions });
  ok('auto-proceed audited through the shared sink', chain.some((e) => e.action === 'reflex.auto-proceed' && e.actor === 'reflex-layer'));
  ok('fallback audited through the shared sink', chain.some((e) => e.action === 'reflex.fallback'));
  ok('audit meta carries the top probability', chain.find((e) => e.action === 'reflex.auto-proceed').meta.verdicts[0].top === 0.97);
  ok('the decision state is never in the audit chain', !JSON.stringify(chain).includes('STATE-MARKER-7f3'));
  ok('chain verifies', verifyChain(chain).ok);
}

/* ---------------- the wired call site: lane routing, end to end with fakes ---------------- */
const CHAT = (lane) => async () => ({ ok: true, json: async () => ({ message: { content: `{"lane":"${lane}"}` } }) });
const RULE_MISS = 'tell me a story about the sea';   // no rule claims it: the routers decide
{
  // Reflex confident → the lane, and the generative router is never woken.
  let chatCalls = 0;
  const chatSpy = async (...a) => { chatCalls += 1; return CHAT('act')(...a); };
  const chain = createChain('test-lane');
  const producer = createReflexProducer({
    router: mkRouter(fetchReturning({ lane: { probabilities: { write: 0.95, act: 0.02, open: 0.01, image: 0.01, lookup: 0.01 } } })),
    audit: chainAuditSink(chain),
  });
  const r = await routeLane(RULE_MISS, { fetchImpl: chatSpy, reflex: (spec) => producer.decide(spec) });
  ok('reflex answers the lane', r.lane === 'write' && r.by === 'reflex');
  ok('generative router never woken', chatCalls === 0);
  ok('the lane verdict is in the shared audit chain', chain.some((e) => e.action === 'reflex.auto-proceed' && e.meta.verdicts[0].question === 'lane'));
}
{
  // Reflex unsure (< 0.6) → escalation for a lane is 'act', the governed brain.
  const producer = createReflexProducer({ router: mkRouter(fetchReturning({ lane: { probabilities: { write: 0.5, act: 0.3, open: 0.1, image: 0.05, lookup: 0.05 } } })) });
  const r = await routeLane(RULE_MISS, { fetchImpl: CHAT('write'), reflex: (spec) => producer.decide(spec) });
  ok('reflex escalation lands on act', r.lane === 'act' && r.by === 'reflex-escalate');
}
{
  // Reflex mid confidence → the generative router (this call site's reasoning path) decides.
  const producer = createReflexProducer({ router: mkRouter(fetchReturning({ lane: { probabilities: { write: 0.2, act: 0.05, open: 0.05, image: 0.0, lookup: 0.75 } } })) });
  const r = await routeLane(RULE_MISS, { fetchImpl: CHAT('lookup'), reflex: (spec) => producer.decide(spec) });
  ok('mid confidence falls through to the generative router', r.lane === 'lookup' && r.by === 'router');
}
{
  // Reflex down → the generative router decides, exactly as before producers existed.
  const producer = createReflexProducer({ router: mkRouter(async () => { throw new Error('down'); }) });
  const r = await routeLane(RULE_MISS, { fetchImpl: CHAT('image'), reflex: (spec) => producer.decide(spec) });
  ok('reflex failure falls through to the generative router', r.lane === 'image' && r.by === 'router');
}
{
  // A producer that throws (a bug, a bad spec) never breaks routing.
  const r = await routeLane(RULE_MISS, { fetchImpl: CHAT('open'), reflex: async () => { throw new Error('producer bug'); } });
  ok('a throwing producer never breaks routing', r.lane === 'open' && r.by === 'router');
}
{
  // Rules still run first with a producer wired (they carry the gates), and no reflex is no change at all.
  let reflexCalls = 0;
  const counting = async (spec) => { reflexCalls += 1; return createReflexProducer({ router: mkRouter(fetchReturning({ lane: { probabilities: { write: 0.99, act: 0.01 } } })) }).decide(spec); };
  const gated = await routeLane('send the invoice to the client', { fetchImpl: CHAT('write'), reflex: counting });
  ok('a rule still wins over the reflex', gated.lane === 'act' && gated.by === 'rule' && reflexCalls === 0);
  const legacy = await routeLane(RULE_MISS, { fetchImpl: CHAT('lookup') });
  ok('no producer wired is the legacy flow', legacy.lane === 'lookup' && legacy.by === 'router');
}

console.log(`\nreflex-producers: ${passed} passed`);
