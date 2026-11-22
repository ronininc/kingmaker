/**
 * lib/governed-router.mjs
 *
 * The governed router: Kingmaker's per-task model choice, with every
 * decision traveling the governed chain —
 *   Intent → Evidence → Governance → Decision → Authorization → Audit.
 * Patterns studied from RuFlow's model router (behavior spec §1, mapping
 * §8) and re-implemented clean-room under governance RuFlow does not have
 * (spec §7.1: upstream has no authorization-before-action anywhere, its
 * decision logging is opt-in and lossy, and its bandit learns from
 * self-reported success). Here:
 *   - the pre-filter (§1.2) resolves mechanical edits at $0,
 *   - the bandit (§1.2) picks within ROBBIE-APPROVED providers only,
 *   - the structural verifier (output-verifier.mjs) — never the model —
 *     decides success, and failure climbs the tier ladder,
 *   - every stage appends to the hash-chained audit log. Not behind a flag.
 *
 * Authorization is task-scoped: routing within approved providers needs no
 * re-approval. A task naming a provider (or model) outside the approved
 * set is REFUSED with status 'needs-tap' and flagged in the chain — the
 * founder's tap adds providers; the router never widens its own remit.
 */

import { prefilter } from './codemod-prefilter.mjs';
import { createBandit, TIER_RANK } from './routing-bandit.mjs';
import { verifyOutput } from './output-verifier.mjs';
import { openAuditLog } from './audit-chain.mjs';
import { screenTaskText, buildSandboxEnv } from './guardrails.mjs';

/**
 * Default catalog. Prices are USD per million tokens (in / out), the shape
 * of the canonical price table in the spec (§1.3). Callers override with
 * their own providers and models — the router is catalog-agnostic.
 */
export const DEFAULT_MODELS = [
  { id: 'km-cheap', provider: 'frontier-api', tier: 'cheap', priceIn: 1, priceOut: 5 },
  { id: 'km-standard', provider: 'frontier-api', tier: 'standard', priceIn: 3, priceOut: 15 },
  { id: 'km-frontier', provider: 'frontier-api', tier: 'frontier', priceIn: 15, priceOut: 75 },
];

const HIGH_WORDS = ['architect', 'refactor', 'security', 'debug', 'distributed', 'design', 'algorithm', 'optimize', 'migration', 'concurrency', 'cryptograph', 'kernel'];
const MED_WORDS = ['implement', 'fix', 'test', 'build', 'create', 'update', 'add', 'write', 'parse', 'convert', 'generate'];
const LOW_WORDS = ['typo', 'format', 'rename', 'comment', 'lint', 'spacing', 'indent', 'whitespace'];

/**
 * Pure lexical complexity — the port of the spec's classifier (§1.1):
 * word count, keyword depth, multi-file scope, hedging. No model call.
 * Score 0–1; buckets at the tier caps: low ≤ 0.4, med ≤ 0.7, high > 0.7.
 */
export function classifyComplexity(text) {
  const t = String(text || '').toLowerCase();
  const words = t.split(/\s+/).filter(Boolean);
  const wordScore = Math.min(words.length / 50, 1);
  const hits = (list) => list.reduce((n, w) => n + (t.includes(w) ? 1 : 0), 0);
  const semantic = Math.min(0.25 * hits(HIGH_WORDS) + 0.1 * hits(MED_WORDS) - 0.15 * hits(LOW_WORDS) + 0.3, 1);
  const scope = /across (modules|files|the codebase)|multiple files|everywhere|throughout/.test(t) ? 1 : Math.min(words.length / 80, 0.6);
  const uncertainty = Math.min((t.match(/not sure|maybe|bug|error|broken|unclear/g) || []).length * 0.2, 1);
  const score = Math.max(0, Math.min(1, 0.15 * wordScore + 0.45 * semantic + 0.25 * scope + 0.15 * uncertainty));
  const bucket = score <= 0.4 ? 'low' : score <= 0.7 ? 'med' : 'high';
  return { score: Math.round(score * 1000) / 1000, bucket };
}

const costOf = (model, usage) =>
  (usage.inputTokens * model.priceIn + usage.outputTokens * model.priceOut) / 1_000_000;

const estimateUsage = (taskText, output) => ({
  inputTokens: Math.max(1, Math.ceil(String(taskText).length / 4)),
  outputTokens: Math.max(1, Math.ceil(String(output ?? '').length / 4)),
  estimated: true,
});

/**
 * Create the router. Required: runner — the injected execution hand,
 *   async ({ task, model, provider, attempt, env }) => { output, usage? }
 * `env` is the secret-scoped sandbox environment for this task (built by
 * guardrails.buildSandboxEnv from envScope) — the runner must use it
 * instead of the host environment when it executes anything.
 * No model is ever called except through it, so tests run at $0 with a fake.
 * Options: models, approvedProviders (default: every provider in `models`),
 * bandit, auditLog, auditPath, maxEscalations (default: whole ladder),
 * envScope (env var names the runner's task may receive — the runner is
 * handed a sandbox env containing ONLY those, never the host environment),
 * envBase (default process.env).
 */
export function createGovernedRouter({
  models = DEFAULT_MODELS,
  approvedProviders = null,
  runner,
  bandit = null,
  auditLog = null,
  auditPath = null,
  maxEscalations = 2,
  envScope = [],
  envBase = process.env,
} = {}) {
  if (typeof runner !== 'function') {
    throw new Error('governed-router: an injected runner is required — execution never happens inside the router');
  }
  const approved = new Set(approvedProviders ?? [...new Set(models.map((m) => m.provider))]);
  const band = bandit ?? createBandit();
  const audit = auditLog ?? openAuditLog(auditPath, 'governed-router-audit');
  const actor = 'governed-router';

  /** Next untried candidate one tier up, cheapest first; null at the top of the ladder. */
  function nextRung(currentTier, tried) {
    const higher = models
      .filter((m) => approved.has(m.provider) && TIER_RANK[m.tier] > TIER_RANK[currentTier] && !tried.has(m.id))
      .sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || a.priceIn - b.priceIn);
    return higher[0] ?? null;
  }

  async function route(task) {
    const text = String(task?.text ?? '');
    const taskId = task?.id ?? `task-${audit.entries.length}`;
    const log = (action, detail, meta) => audit.append({ actor, action, detail, meta: { taskId, ...meta } });

    // INTENT — what was asked, recorded before anything is decided.
    log('route.intent', text.slice(0, 200), {});

    // EVIDENCE — classification + the $0 pre-filter's verdict.
    const { score: complexity, bucket } = classifyComplexity(text);
    const pre = prefilter(task);
    log('route.evidence', `complexity ${complexity} (${bucket}); prefilter ${pre.handled ? `handled: ${pre.kind}` : pre.reason}`, {
      complexity, bucket, prefilter: pre.handled ? pre.kind : null,
    });

    // GUARDRAIL SCREEN (Evidence signal, per spec §8 ADAPT on AIDefence):
    // a flagged task is never fast-laned — no codemod, no cheap tier; it
    // goes to the FRONTIER tier of the governed chain, and the flag rides
    // the audit trail. The screen never authorizes and never vetoes; the
    // governed brain makes the call. Screened on the raw text so the
    // pre-filter cannot coincidentally codemod a hostile instruction.
    const screen = screenTaskText(text, { auditLog: audit });
    if (screen.flagged) {
      log('route.guardrail', `injection screen flagged (${[...new Set(screen.hits.map((h) => h.family))].join(', ')}) — fast lanes closed, frontier tier only`, {
        families: [...new Set(screen.hits.map((h) => h.family))], hitCount: screen.hits.length,
      });
    }

    // GOVERNANCE — approved providers only; a named outsider stops here.
    const namedModel = task?.model ? models.find((m) => m.id === task.model) : null;
    const namedProvider = task?.provider ?? namedModel?.provider ?? null;
    if (namedProvider && !approved.has(namedProvider)) {
      log('route.governance', `REFUSED: provider '${namedProvider}' is not approved`, { namedProvider, approved: [...approved] });
      log('route.authorization', 'needs-tap: new provider requires the founder\u2019s tap', { namedProvider });
      return { status: 'needs-tap', reason: `provider '${namedProvider}' is not approved`, taskId, bucket, complexity, costUsd: 0 };
    }
    log('route.governance', `approved providers: ${[...approved].join(', ')}`, { approved: [...approved] });

    // Pre-filter hit: Decision + Authorization are the codemod itself — $0, no provider.
    // A flagged task never reaches this branch: the guardrail screen closed the fast lane.
    if (pre.handled && !screen.flagged) {
      log('route.decision', `codemod ${pre.kind} — no model call`, { routedBy: 'prefilter', model: null, costUsd: 0 });
      log('route.authorization', 'task-scoped: deterministic codemod, no provider spend', {});
      log('route.outcome', 'ok (prefilter)', { costUsd: 0, escalations: 0 });
      return { status: 'ok', output: pre.output, model: null, provider: null, tier: null, routedBy: 'prefilter', costUsd: 0, escalations: 0, taskId, bucket, complexity };
    }

    // DECISION — bandit pick within the approved candidate set.
    // A flagged task's candidate set is the frontier tier alone: the
    // governed brain, never a cheap lane (screenTaskText's recommendation).
    let candidates = models.filter((m) => approved.has(m.provider));
    if (namedModel) candidates = [namedModel];
    if (task?.provider) candidates = candidates.filter((m) => m.provider === task.provider);
    if (screen.flagged) {
      const frontierOnly = candidates.filter((m) => m.tier === 'frontier');
      if (frontierOnly.length > 0) candidates = frontierOnly;
    }
    if (candidates.length === 0) {
      log('route.decision', 'no approved candidate available', {});
      return { status: 'failed', reason: 'no approved candidate', taskId, bucket, complexity, costUsd: 0 };
    }
    const { pick, alternatives } = band.pick(bucket, candidates);
    let model = candidates.find((m) => m.id === pick.modelId);
    log('route.decision', `${model.id} (${model.tier}) for ${bucket} task — draw ${pick.theta.toFixed(3)} × affinity`, {
      model: model.id, provider: model.provider, tier: model.tier, routedBy: 'bandit',
      confidence: Math.round(pick.theta * 1000) / 1000, complexity,
      alternatives: alternatives.map((a) => a.modelId),
    });

    // AUTHORIZATION — task-scoped, inside the approved set. Recorded, not re-asked.
    log('route.authorization', `task-scoped: ${model.provider} is approved`, { provider: model.provider });

    // EXECUTION — runner → verifier → escalate on structural failure.
    // The runner gets a secret-scoped sandbox env (guardrails), built once
    // per task: only envScope names, nothing else from the host env.
    const sandbox = buildSandboxEnv({ scope: envScope, base: envBase, auditLog: audit });
    const tried = new Set();
    const attempts = [];
    let totalCost = 0;
    let escalations = 0;
    let finalOutput = null;
    let finalVerdict = null;

    for (;;) {
      tried.add(model.id);
      let output = null;
      let usage = null;
      let runError = null;
      try {
        const res = await runner({ task, model, provider: model.provider, attempt: attempts.length, env: sandbox.env });
        output = res?.output ?? '';
        usage = res?.usage ?? estimateUsage(text, output);
      } catch (e) {
        runError = e;
        usage = { inputTokens: 0, outputTokens: 0 };
      }
      const cost = costOf(model, usage);
      totalCost += cost;
      const verdict = runError
        ? { pass: false, reasons: [`runner error: ${runError.message}`], failedChecks: ['runner-error'] }
        : verifyOutput(output, { expect: task?.expect ?? 'text' });
      attempts.push({ model: model.id, tier: model.tier, costUsd: cost, verdict });

      if (verdict.pass) {
        band.recordOutcome({ bucket, modelId: model.id, tier: model.tier, outcome: 'success', task: text });
        finalOutput = output;
        finalVerdict = verdict;
        break;
      }
      // Failure teaches — but only from the verifier's word, never the model's.
      const canEscalate = escalations < maxEscalations;
      const next = canEscalate ? nextRung(model.tier, tried) : null;
      band.recordOutcome({ bucket, modelId: model.id, tier: model.tier, outcome: next ? 'escalated' : 'fail', task: text });
      if (!next) {
        finalVerdict = verdict;
        break;
      }
      escalations += 1;
      log('route.escalation', `${model.id} failed verifier (${verdict.failedChecks.join(', ')}) — climbing to ${next.id}`, {
        from: model.id, to: next.id, failedChecks: verdict.failedChecks,
      });
      model = next;
    }

    const ok = finalOutput !== null;
    log('route.outcome', ok ? `ok via ${model.id} after ${escalations} escalation(s)` : `failed: ${finalVerdict?.reasons.join('; ')}`, {
      status: ok ? 'ok' : 'failed', model: model.id, tier: model.tier, costUsd: totalCost, escalations,
      attempts: attempts.map((a) => ({ model: a.model, tier: a.tier, costUsd: a.costUsd, failedChecks: a.verdict.failedChecks })),
    });

    return {
      status: ok ? 'ok' : 'failed',
      output: finalOutput,
      model: model.id,
      provider: model.provider,
      tier: model.tier,
      routedBy: escalations > 0 ? 'bandit-escalated' : 'bandit',
      costUsd: totalCost,
      escalations,
      verdict: finalVerdict,
      taskId,
      bucket,
      complexity,
    };
  }

  return { route, audit, bandit: band, approvedProviders: [...approved] };
}
