// lib/reflex-layer.mjs — the reflex layer wired into the request path: typed decision requests (a situation plus a
// fixed set of answers, scored in one forward pass by a System One decision model, lib/decision-router.mjs) are
// answered BEFORE any reasoning brain wakes.
//
//   confidence >= autoProceedThreshold (0.9)  → the verdict stands; no reasoning model is woken.
//   escalateThreshold (0.6) .. 0.9             → the existing reasoning path, with the verdict attached as context.
//   below 0.6                                 → the escalation path (or the reasoning path, flagged escalated,
//                                               when no escalation handler is wired — a request is never dropped).
//   router down / slow / transport-failed     → the reasoning path, with the failure attached. Never a hard fail.
//
// A request is decision-shaped when it carries { decision: { state, questions } } (or the bare
// { state, questions }) and EVERY question declares its answer space: a choice (options: [..]) or a score.
// Anything else — every free-text command included — passes through untouched, exactly as before this layer
// existed. The kill switch is the env KINGMAKER_REFLEX=off (also 0/false/no) or a config { reflex: { on: false } }:
// off means the legacy flow, byte for byte.
//
// Every reflex disposition writes an audit-chain entry (lib/audit-chain.mjs) through the injected sink: the
// verdicts, their kinds and top probabilities, the model and the milliseconds. The decision STATE is never
// written to the audit log — verdicts only.
import { appendEntry } from './audit-chain.mjs';

const OFF_WORDS = new Set(['0', 'off', 'false', 'no']);

/** Pure: is this value a typed decision question (fixed answer space)? */
export function isDecisionQuestion(q) {
  if (!q || typeof q !== 'object' || Array.isArray(q)) return false;
  if (Array.isArray(q.options) && q.options.length >= 2 && q.options.every((o) => typeof o === 'string' && o.length > 0)) return true;
  return (q.kind ?? q.type) === 'score';
}

/** Pure: does this request carry a decision payload, and is every question in it decision-shaped? */
export function isDecisionRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const payload = value.decision && typeof value.decision === 'object' && !Array.isArray(value.decision) ? value.decision : value;
  const questions = payload.questions;
  if (!questions || typeof questions !== 'object' || Array.isArray(questions)) return false;
  const entries = Object.entries(questions);
  return entries.length > 0 && entries.every(([, q]) => isDecisionQuestion(q));
}

/** Pure: the { state, questions } payload inside a decision request (envelope or bare). */
export function decisionPayload(value) {
  return value.decision && typeof value.decision === 'object' ? value.decision : value;
}

/** Pure: the kill switch. Env beats config; either one off disables the layer. Default on. */
export function reflexEnabled({ env = process.env, config = null } = {}) {
  const raw = env?.KINGMAKER_REFLEX;
  if (raw !== undefined && OFF_WORDS.has(String(raw).trim().toLowerCase())) return false;
  if (config === false) return false;
  if (config && typeof config === 'object' && config.on === false) return false;
  return true;
}

/** An audit sink over a live audit chain (lib/audit-chain.mjs appendEntry). */
export const chainAuditSink = (chain) => (fields) => appendEntry(chain, fields);

const topProbability = (outcome) => {
  const probs = outcome?.answer?.probabilities;
  if (!probs || typeof probs !== 'object') return null;
  const values = Object.values(probs).filter((v) => typeof v === 'number');
  return values.length ? Math.max(...values) : null;
};

const topOption = (outcome) => {
  const probs = outcome?.answer?.probabilities;
  if (!probs || typeof probs !== 'object') return null;
  let best = null;
  for (const [option, p] of Object.entries(probs)) if (typeof p === 'number' && (best === null || p > best.p)) best = { option, p };
  return best;
};

/** Pure: the one line the owner hears when the reflex layer answers outright. */
export function decisionVerdictLine(outcomes) {
  const parts = (outcomes ?? []).map((o) => {
    const best = topOption(o);
    return best ? `${o.questionName}: ${best.option} (${best.p.toFixed(2)})` : `${o.questionName}: no scored answer`;
  });
  return `Decided locally, no big model woken. ${parts.join('; ')}.`;
}

/** Pure: the brief a reasoning/escalation turn hears, with the reflex verdicts attached as context. */
export function decisionBriefText(request, ctx = {}) {
  const payload = decisionPayload(request);
  const lines = [];
  if (ctx.escalated || ctx.via === 'reflex-escalate') lines.push('ESCALATED: the local decision model was not confident enough to proceed or route this. The owner should see it decided deliberately, not by reflex.');
  else if (ctx.via === 'reflex-fallback') lines.push(`The local decision model could not answer (${ctx.reflexError ?? 'transport failed'}), so this decision is yours from scratch.`);
  else lines.push('The local decision model scored this but was not confident enough to proceed on its own; its verdicts ride along as context, the decision is yours.');
  lines.push(`State: ${JSON.stringify(payload.state ?? null)}`);
  lines.push(`Questions: ${JSON.stringify(payload.questions ?? {})}`);
  if (Array.isArray(ctx.reflexVerdicts) && ctx.reflexVerdicts.length) {
    lines.push('Reflex verdicts:');
    for (const o of ctx.reflexVerdicts) {
      const best = topOption(o);
      lines.push(`- ${o.questionName}: ${o.kind}${best ? ` — top answer ${best.option} at ${best.p.toFixed(3)}` : ''}${o.reason ? ` (${o.reason})` : ''}`);
    }
  }
  return lines.join('\n');
}

const withTimeout = (promise, ms) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`reflex timeout after ${ms}ms`)), ms);
  promise.then(
    (v) => { clearTimeout(timer); resolve(v); },
    (e) => { clearTimeout(timer); reject(e); },
  );
});

/**
 * The layer. `router` is a DecisionRouter (or any object with decide() + calibration); `reasoning(request, ctx)`
 * is the existing brain path and is REQUIRED — it is also the legacy path when the layer is off, has no router,
 * or the request is not decision-shaped. `escalate(request, ctx)` is the existing escalation path; when absent,
 * escalations go to reasoning flagged escalated. `audit(fields)` receives audit-chain entries.
 */
export function createReflexLayer({ router = null, audit = null, log = () => {}, enabled = true, reasoning, escalate = null, timeoutMs = null } = {}) {
  if (typeof reasoning !== 'function') throw new Error('reflex-layer: a reasoning handler is required (it is the legacy path)');
  const limit = timeoutMs ?? router?.calibration?.timeoutMs ?? 2000;
  const active = Boolean(enabled && router);
  const writeAudit = (action, detail, meta) => {
    if (!audit) return;
    try { audit({ actor: 'reflex-layer', action, detail, meta }); }
    catch (err) { log('reflex_audit_failed', { error: String(err?.message ?? err).slice(0, 160) }); }
  };

  async function handle(request) {
    if (!active || !isDecisionRequest(request)) return reasoning(request, { via: 'legacy' });
    const payload = decisionPayload(request);
    const names = Object.keys(payload.questions ?? {});
    const started = Date.now();
    let outcomes;
    try {
      outcomes = await withTimeout(Promise.resolve().then(() => router.decide(payload)), limit);
    } catch (err) {
      const reason = String(err?.message ?? err).slice(0, 200);
      writeAudit('reflex.fallback', `decision request fell back to reasoning: ${reason}`, { questions: names, ms: Date.now() - started, reason });
      log('reflex_fallback', { reason });
      return reasoning(request, { via: 'reflex-fallback', reflexError: reason });
    }
    const ms = Date.now() - started;
    const list = Array.isArray(outcomes) ? outcomes : [];
    const meta = {
      model: router.config?.model ?? null, ms,
      verdicts: list.map((o) => ({ question: o.questionName, kind: o.kind, top: topProbability(o) })),
    };
    const detail = list.map((o) => `${o.questionName}=${o.kind}`).join(', ') || 'no verdicts';
    if (list.length === 0 || list.some((o) => o.kind === 'transport-failed')) {
      const failed = list.find((o) => o.kind === 'transport-failed');
      writeAudit('reflex.fallback', `decision request fell back to reasoning: ${failed?.reason ?? 'no verdicts'}`, meta);
      log('reflex_fallback', { reason: failed?.reason ?? 'no verdicts' });
      return reasoning(request, { via: 'reflex-fallback', reflexError: failed?.reason ?? 'reflex returned no verdicts', reflexVerdicts: list });
    }
    if (list.some((o) => o.kind === 'escalate')) {
      writeAudit('reflex.escalate', `low-confidence decision escalated: ${detail}`, meta);
      const ctx = { via: 'reflex-escalate', reflexVerdicts: list };
      return escalate ? escalate(request, ctx) : reasoning(request, { ...ctx, escalated: true });
    }
    if (list.some((o) => o.kind === 'route-to-reasoning')) {
      writeAudit('reflex.route-to-reasoning', `mid-confidence decision routed to reasoning with verdicts: ${detail}`, meta);
      return reasoning(request, { via: 'reflex', reflexVerdicts: list });
    }
    writeAudit('reflex.auto-proceed', `decision answered by the reflex layer: ${detail}`, meta);
    return { via: 'reflex', answeredBy: 'reflex', reflexVerdicts: list };
  }

  return { handle, active, timeoutMs: limit };
}
