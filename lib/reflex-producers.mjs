// lib/reflex-producers.mjs — the producer side of the reflex layer (lib/reflex-layer.mjs): how Kingmaker's own
// decision points ASK the System One decision model, instead of only decision-shaped turns arriving from outside.
//
// PR #115 wired the layer into the request path, but nothing inside the app emitted a decision payload — the
// layer sat armed and unused. A producer is the missing half:
//
//   buildDecisionRequest({ state, questions })  → a validated { decision: { state, questions } } payload. Every
//     question must declare a FIXED answer space (a choice: options [..], or a score) — the router contract
//     (lib/decision-router.mjs). A malformed spec is a programming error and throws here, at the call site,
//     never at the owner.
//   createReflexProducer({ router, audit, … }).decide(spec)  → the verdict mapped back into the caller's own
//     decision types: a disposition plus, per question, the top answer and its probability.
//
// The producer runs the SAME layer (createReflexLayer) with capture handlers in place of a brain turn: same
// router, same calibration bands, same audit sink — dispositions are written to the caller's chain by the
// layer itself (reflex.auto-proceed / reflex.route-to-reasoning / reflex.escalate / reflex.fallback), never a
// second audit path. The decision STATE rides to the router only; the audit entries carry verdicts, top
// probabilities, the model and the milliseconds, exactly as in #115 — the state is never logged.
//
// Bands (lib/decision-router.mjs DEFAULT_CALIBRATION):
//   every verdict >= 0.9   → 'auto-proceed'      the caller takes the top answers as its decision.
//   any verdict 0.6 .. 0.9 → 'route-to-reasoning' the caller runs its own reasoning path, verdicts attached.
//   any verdict < 0.6      → 'escalate'          the caller runs its deliberate/escalation path.
//   router down/slow/dead  → 'fallback'          the verdicts are absent; the caller proceeds exactly as it
//                                                did before producers existed, with reflexError attached.
//   layer off / no router  → 'legacy'            the router is never called (kill switch KINGMAKER_REFLEX=off).
//
// A producer must never make a caller LESS reliable: decide() rejects only on a malformed spec (the caller's
// bug). Every router-side failure resolves as a disposition.
import { DEFAULT_CALIBRATION } from './decision-router.mjs';
import { createReflexLayer, isDecisionQuestion, isDecisionRequest } from './reflex-layer.mjs';

/** The endpoint's per-call question cap (lib/decision-router.mjs DEFAULT_CALIBRATION). */
export const MAX_QUESTIONS_PER_CALL = DEFAULT_CALIBRATION.maxQuestionsPerCall;

/**
 * Pure: build (and validate) a decision payload from a caller's decision point: a typed state snapshot plus
 * questions whose answer spaces are fixed. Returns { decision: { state, questions } } — the envelope
 * lib/reflex-layer.mjs detects. Throws TypeError on anything malformed: a non-object state, no questions,
 * more than the endpoint cap, or a question without a fixed answer space.
 */
export function buildDecisionRequest({ state, questions } = {}) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new TypeError('reflex-producers: state must be a typed snapshot object');
  }
  if (!questions || typeof questions !== 'object' || Array.isArray(questions)) {
    throw new TypeError('reflex-producers: questions must be an object of named questions');
  }
  const entries = Object.entries(questions);
  if (entries.length === 0) throw new TypeError('reflex-producers: at least one question is required');
  if (entries.length > MAX_QUESTIONS_PER_CALL) {
    throw new TypeError(`reflex-producers: ${entries.length} questions exceeds the endpoint cap of ${MAX_QUESTIONS_PER_CALL} per call`);
  }
  for (const [name, q] of entries) {
    if (!name) throw new TypeError('reflex-producers: question names must be non-empty');
    if (!isDecisionQuestion(q)) {
      throw new TypeError(`reflex-producers: question "${name}" has no fixed answer space (declare options: [..] with at least two answers, or kind: 'score')`);
    }
  }
  const request = { decision: { state, questions } };
  if (!isDecisionRequest(request)) throw new TypeError('reflex-producers: built request is not decision-shaped (internal error)');
  return request;
}

/** Pure: the top-scored answer of one router outcome ({ option, probability }), or null when it scored none. */
export function topAnswerOf(outcome) {
  const probs = outcome?.answer?.probabilities;
  if (!probs || typeof probs !== 'object') return null;
  let best = null;
  for (const [option, p] of Object.entries(probs)) if (typeof p === 'number' && (best === null || p > best.probability)) best = { option, probability: p };
  return best;
}

/**
 * Pure: the verdicts as the caller's answer map: { [questionName]: { option, probability, kind, answer } }.
 * `map` translates a top option into the caller's own decision type, either per question
 * ({ [questionName]: { [option]: value } }) or as one function (questionName, option, probability) → value;
 * the translation lands on the answer's `value` field. Unmapped answers carry no `value`.
 */
export function answersOf(outcomes, map = null) {
  const answers = {};
  for (const o of Array.isArray(outcomes) ? outcomes : []) {
    const top = topAnswerOf(o);
    const entry = { option: top?.option ?? null, probability: top?.probability ?? null, kind: o.kind, answer: o.answer ?? null };
    if (top && map) {
      if (typeof map === 'function') entry.value = map(o.questionName, top.option, top.probability);
      else if (map[o.questionName] && typeof map[o.questionName] === 'object' && top.option in map[o.questionName]) entry.value = map[o.questionName][top.option];
    }
    answers[o.questionName] = entry;
  }
  return answers;
}

/**
 * A producer over the shared reflex machinery. `router` is the same DecisionRouter the request-path layer
 * uses; `audit` is the same sink (chainAuditSink over the caller's chain) — dispositions audit through the
 * layer, so a producer adds no audit path of its own. `enabled` should be the same reflexEnabled() verdict
 * the layer got: off means decide() resolves 'legacy' without ever calling the router.
 */
export function createReflexProducer({ router = null, audit = null, log = () => {}, enabled = true, timeoutMs = null } = {}) {
  let captured = null;
  const layer = createReflexLayer({
    router, audit, log, enabled, timeoutMs,
    // Capture handlers: a producer's caller IS the reasoning/escalation path — the layer's job here is the
    // verdict and the band, not a brain turn. Whatever the layer would have handed a turn lands in `captured`.
    reasoning: async (request, ctx) => { captured = { handler: 'reasoning', ctx }; return { answeredBy: 'producer-capture' }; },
    escalate: async (request, ctx) => { captured = { handler: 'escalate', ctx }; return { answeredBy: 'producer-capture' }; },
  });

  /**
   * Ask one decision point. spec: { state, questions } (see buildDecisionRequest); opts.map translates top
   * options into the caller's decision types (see answersOf). Resolves
   * { disposition, via, answers, verdicts, reflexError? } — disposition is one of 'auto-proceed',
   * 'route-to-reasoning', 'escalate', 'fallback', 'legacy'. Rejects only on a malformed spec.
   */
  async function decide(spec, { map = null } = {}) {
    const request = buildDecisionRequest(spec);
    captured = null;
    const result = await layer.handle(request);
    if (result?.answeredBy === 'reflex') {
      const verdicts = result.reflexVerdicts ?? [];
      return { disposition: 'auto-proceed', via: 'reflex', answers: answersOf(verdicts, map), verdicts };
    }
    const ctx = captured?.ctx ?? {};
    const verdicts = ctx.reflexVerdicts ?? [];
    if (captured?.handler === 'escalate' || ctx.via === 'reflex-escalate') {
      return { disposition: 'escalate', via: ctx.via ?? 'reflex-escalate', answers: answersOf(verdicts, map), verdicts };
    }
    if (ctx.via === 'legacy') return { disposition: 'legacy', via: 'legacy', answers: {}, verdicts: [] };
    if (ctx.via === 'reflex-fallback') {
      return { disposition: 'fallback', via: 'reflex-fallback', answers: answersOf(verdicts, map), verdicts, reflexError: ctx.reflexError ?? 'reflex unavailable' };
    }
    // The remaining disposition the layer produces: mid-confidence, routed to reasoning with verdicts attached.
    return { disposition: 'route-to-reasoning', via: ctx.via ?? 'reflex', answers: answersOf(verdicts, map), verdicts };
  }

  return { decide, active: layer.active };
}
