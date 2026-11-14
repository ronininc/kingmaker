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
// verdicts, their kinds, their FULL probability maps and top probabilities, the model and the milliseconds —
// the trail a background loop's iteration step reads to learn which decisions auto-proceeded, which escalated,
// and with what confidence. The decision STATE is never written to the audit log — verdicts only.
//
// The layer is also the typed-output seam: the router returns whatever the endpoint sent, so every answer is
// validated here against its question's declared answer space before any band is read from it. An answer that
// is not a typed probability map over exactly the declared options — prose in the probabilities, an invented
// option, numbers outside [0,1], a map that does not sum to 1 — becomes a NAMED transport failure
// ('malformed reflex answer for "<question>": …') and takes the fallback path. It is never passed through,
// never banded, never auto-proceeded on.
//
// The Evidence stage rides in through the optional `evidence` port (lib/fold-evidence.mjs): when wired, the
// active fold index — ingested material folded into tiered blocks over a byte-exact store — is attached to
// the decision state before the router scores, so the classifier scans the folds, not the raw ingest. A
// verdict that STANDS (auto-proceed) first pulls every surfaced block's receipt (the byte-exact originals,
// decompress full) and the result carries them; the audit records the blocks used and the receipts' SHA-256
// fingerprints, never the receipt text (state is not audited — verdicts and fingerprints only). The supply is
// fail-open, exactly like the router: evidence down, slow, or empty changes nothing but a log line and an
// audit entry — the decision proceeds on the caller's state, as before this port existed.
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

/** The outcome's probability map with values rounded for the audit trail (bounded entries), or null. */
const probabilityMapOf = (outcome) => {
  const probs = outcome?.answer?.probabilities;
  if (!probs || typeof probs !== 'object' || Array.isArray(probs)) return null;
  const map = {};
  for (const [k, v] of Object.entries(probs)) if (typeof v === 'number' && Number.isFinite(v)) map[k] = Math.round(v * 1e6) / 1e6;
  return Object.keys(map).length ? map : null;
};

/** A probability map must sum to 1 within this tolerance (the endpoints normalize; rounding rides along). */
export const PROB_SUM_TOLERANCE = 0.05;

/** Pure: the declared answer space of one question as a Set of allowed probability keys — a choice's
 *  options; a score's level labels (when its criteria are strings) plus the 'score' rating key the
 *  in-tree endpoint (lib/systemone-server.mjs) rides. Null when the space cannot be determined. */
export function declaredAnswerSpace(q) {
  if (!q || typeof q !== 'object') return null;
  if (Array.isArray(q.options) && q.options.length >= 2) return new Set(q.options);
  if ((q.kind ?? q.type) === 'score') {
    const keys = new Set(['score']);
    if (Array.isArray(q.criteria)) for (const c of q.criteria) if (typeof c === 'string' && c) keys.add(c);
    return keys;
  }
  return null;
}

/** Pure: why one router answer is not a typed decision, or null when it is one — an object carrying a
 *  probability map over exactly the declared answer space, every value a finite number in [0,1], the
 *  map summing to 1 (±PROB_SUM_TOLERANCE), and a stated winner (when the answer carries one) inside
 *  the space. Anything else — prose included — is malformed by shape, whatever it claims. */
export function decisionAnswerProblem(question, answer) {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return 'the answer is not an object';
  const probs = answer.probabilities;
  if (!probs || typeof probs !== 'object' || Array.isArray(probs)) return 'probabilities missing — not a typed probability map';
  const entries = Object.entries(probs);
  if (entries.length === 0) return 'the probabilities map is empty';
  const space = declaredAnswerSpace(question);
  let sum = 0;
  for (const [key, value] of entries) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return `the probability for "${key}" is not a number in [0,1]`;
    if (space && !space.has(key)) return `"${key}" is outside the declared answer space`;
    sum += value;
  }
  // A score question answered as a lone {'score': rating} (the in-tree endpoint's convention) carries
  // a rating, not a distribution — the sum rule does not apply to it. A map over level labels IS a
  // distribution and is held to it.
  const ratingShape = (question?.kind ?? question?.type) === 'score' && entries.length === 1 && entries[0][0] === 'score';
  if (!ratingShape && Math.abs(sum - 1) > PROB_SUM_TOLERANCE) return `the probabilities sum to ${sum.toFixed(3)}, not 1`;
  if (typeof answer.answer === 'string' && space && !space.has(answer.answer)) return `the stated answer "${answer.answer}" is outside the declared answer space`;
  return null;
}

/** Pure: outcomes with every malformed answer replaced by a named transport failure — the layer's
 *  existing fallback branch then carries the request to reasoning with the reason attached, exactly
 *  like a dead endpoint. Well-formed outcomes and transport failures pass through untouched. */
export function validateDecisionOutcomes(payload, outcomes) {
  const questions = payload?.questions ?? {};
  return (Array.isArray(outcomes) ? outcomes : []).map((o) => {
    if (!o || o.kind === 'transport-failed' || !('answer' in o)) return o;
    const problem = decisionAnswerProblem(questions[o.questionName], o.answer);
    if (!problem) return o;
    return { kind: 'transport-failed', questionName: o.questionName, reason: `malformed reflex answer for "${o.questionName}": ${problem} — never passed through` };
  });
}

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
export function createReflexLayer({ router = null, audit = null, log = () => {}, enabled = true, reasoning, escalate = null, timeoutMs = null, evidence = null } = {}) {
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
    // Evidence stage: attach the fold index to the decision state before scoring (fail-open —
    // a supply failure is audited and the decision proceeds on the caller's state untouched).
    let decidePayload = payload;
    let evidenceSurface = null;
    if (evidence) {
      try {
        const surface = await evidence.gather(payload);
        if (surface && Array.isArray(surface.blocks) && surface.blocks.length) {
          const state = payload.state;
          if (state === undefined || (state && typeof state === 'object' && !Array.isArray(state))) {
            decidePayload = { ...payload, state: { ...(state ?? {}), evidence: { foldIndex: surface.blocks } } };
            evidenceSurface = surface.blocks;
          } else {
            log('reflex_evidence_skipped', { reason: 'decision state is not an object; fold surface not attached' });
          }
        }
      } catch (err) {
        const reason = String(err?.message ?? err).slice(0, 200);
        writeAudit('reflex.evidence-unavailable', `fold-evidence supply failed; decision proceeded without it: ${reason}`, { questions: names, reason });
        log('reflex_evidence_unavailable', { reason });
      }
    }
    let outcomes;
    try {
      outcomes = await withTimeout(Promise.resolve().then(() => router.decide(decidePayload)), limit);
    } catch (err) {
      const reason = String(err?.message ?? err).slice(0, 200);
      writeAudit('reflex.fallback', `decision request fell back to reasoning: ${reason}`, { questions: names, ms: Date.now() - started, reason });
      log('reflex_fallback', { reason });
      return reasoning(request, { via: 'reflex-fallback', reflexError: reason });
    }
    const ms = Date.now() - started;
    const list = validateDecisionOutcomes(payload, Array.isArray(outcomes) ? outcomes : []);
    const meta = {
      model: router.config?.model ?? null, ms,
      verdicts: list.map((o) => ({ question: o.questionName, kind: o.kind, top: topProbability(o), probabilities: probabilityMapOf(o) })),
    };
    if (evidenceSurface) meta.evidence = { blocks: evidenceSurface.map((b) => b.blockId), tiers: evidenceSurface.map((b) => b.tier) };
    const detail = list.map((o) => `${o.questionName}=${o.kind}`).join(', ') || 'no verdicts';
    if (list.length === 0 || list.some((o) => o.kind === 'transport-failed')) {
      const failed = list.find((o) => o.kind === 'transport-failed');
      writeAudit('reflex.fallback', `decision request fell back to reasoning: ${failed?.reason ?? 'no verdicts'}`, meta);
      log('reflex_fallback', { reason: failed?.reason ?? 'no verdicts' });
      return reasoning(request, { via: 'reflex-fallback', reflexError: failed?.reason ?? 'reflex returned no verdicts', reflexVerdicts: list });
    }
    if (list.some((o) => o.kind === 'escalate')) {
      writeAudit('reflex.escalate', `low-confidence decision escalated: ${detail}`, meta);
      const ctx = { via: 'reflex-escalate', reflexVerdicts: list, ...(evidenceSurface ? { evidenceSurface } : {}) };
      return escalate ? escalate(request, ctx) : reasoning(request, { ...ctx, escalated: true });
    }
    if (list.some((o) => o.kind === 'route-to-reasoning')) {
      writeAudit('reflex.route-to-reasoning', `mid-confidence decision routed to reasoning with verdicts: ${detail}`, meta);
      return reasoning(request, { via: 'reflex', reflexVerdicts: list, ...(evidenceSurface ? { evidenceSurface } : {}) });
    }
    // Auto-proceed: the verdict STANDS on the evidence it scanned, so every surfaced block's
    // receipt is pulled before the audit is written. The audit records fingerprints only; the
    // receipt texts ride the result. A receipt that fails to pull is named in both — the
    // verdict still stands on the router's answer (fail-open), never silently receipt-less.
    let evidenceReceipts = null;
    if (evidenceSurface) {
      evidenceReceipts = [];
      for (const b of evidenceSurface) {
        try {
          const r = await evidence.receipt(b.blockId);
          evidenceReceipts.push({ blockId: b.blockId, sha256: r.sha256, chars: r.chars, text: r.text });
        } catch (err) {
          evidenceReceipts.push({ blockId: b.blockId, error: String(err?.message ?? err).slice(0, 160) });
        }
      }
      meta.evidenceReceipts = evidenceReceipts.map(({ blockId, sha256, chars, error }) => (error ? { blockId, error } : { blockId, sha256, chars }));
    }
    writeAudit('reflex.auto-proceed', `decision answered by the reflex layer: ${detail}`, meta);
    const result = { via: 'reflex', answeredBy: 'reflex', reflexVerdicts: list };
    if (evidenceSurface) result.evidence = { blocks: evidenceSurface, receipts: evidenceReceipts };
    return result;
  }

  return { handle, active, timeoutMs: limit };
}
