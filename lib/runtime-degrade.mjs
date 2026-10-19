/**
 * Kingmaker — graceful degradation at runtime.
 *
 * The static tiering (per-Mac-class packs, triage-time fitting, the
 * compute governor's load plans) decides upfront. This module handles
 * what upfront planning cannot: mid-task resource exhaustion. Try the
 * full-fidelity tier; on resource exhaustion, fall back through
 * progressively lighter tiers; keep going until one works or none do.
 *
 * The rule: degrade ONLY on resource exhaustion (OOM, timeout, device
 * limits) — never on logic errors. A wrong answer is not a reason to
 * try a dumber model; an OOM is.
 *
 * Pure functions + injected deps. No I/O, no network. Every attempt is
 * auditable through the injected audit sink.
 */

/**
 * Classify whether a failure is resource exhaustion (degrade) or a
 * logic failure (propagate). The runner reports failures as
 * { ok: false, code, message }.
 */
export function isResourceExhaustion(failure) {
  if (!failure || typeof failure !== 'object') return false;
  const code = String(failure.code || '').toLowerCase();
  const message = String(failure.message || '').toLowerCase();
  return (
    code === 'oom' ||
    code === 'out-of-memory' ||
    code === 'timeout' ||
    code === 'resource-exhausted' ||
    code === 'device-limit' ||
    message.includes('out of memory') ||
    message.includes('memory pressure') ||
    message.includes('timed out')
  );
}

/**
 * Run a task through tiered fallbacks.
 *
 * @param {Object} args
 * @param {Array} args.tiers - ordered [{ name, describe }] — full fidelity first
 * @param {Function} args.run - injected runner: (tier) => { ok, result?, failure? }
 * @param {Object} args.deps - { appendAudit(event), now() }
 * @returns {Object} { ok, tierUsed, result?, degraded, attempts: [{ tier, ok, code? }] }
 */
export function attemptWithFallback({ tiers, run, deps }) {
  const attempts = [];
  const now = typeof deps.now === 'function' ? deps.now() : new Date().toISOString();

  for (const tier of tiers) {
    let outcome;
    try {
      outcome = run(tier);
    } catch (err) {
      outcome = {
        ok: false,
        failure: { code: 'threw', message: String((err && err.message) || err) },
      };
    }
    attempts.push({
      tier: tier.name,
      ok: outcome.ok === true,
      code: outcome.ok ? undefined : String((outcome.failure && outcome.failure.code) || 'unknown'),
    });

    if (outcome.ok === true) {
      const degraded = attempts.length > 1;
      deps.appendAudit({
        type: 'degrade/settled',
        tierUsed: tier.name,
        degraded,
        attempts: attempts.length,
        at: now,
      });
      return { ok: true, tierUsed: tier.name, result: outcome.result, degraded, attempts };
    }

    if (!isResourceExhaustion(outcome.failure)) {
      deps.appendAudit({
        type: 'degrade/propagated',
        tier: tier.name,
        code: attempts[attempts.length - 1].code,
        at: now,
      });
      return {
        ok: false,
        tierUsed: tier.name,
        failure: outcome.failure,
        degraded: false,
        attempts,
        reason: 'non-resource failure — not degraded, propagated',
      };
    }
    // Resource exhaustion: fall through to the next lighter tier.
  }

  deps.appendAudit({ type: 'degrade/exhausted', attempts: attempts.length, at: now });
  return {
    ok: false,
    tierUsed: null,
    degraded: false,
    attempts,
    reason: 'all tiers resource-exhausted',
  };
}
