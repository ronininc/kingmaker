/**
 * Kingmaker — Titan adaptation: gated self-iteration.
 *
 * Named for the Super Powereds concept: whatever puts it down, it
 * adapts to until it gets up immune. When the system encounters
 * something it cannot reason through — the machine is too heavy for
 * the task — it does two things, in order:
 *
 *   1. Tell the user honestly that it is not okay (no silent failure,
 *      no pretending). The blockage is recorded on the audit chain.
 *   2. In the background, exhaust every avenue of approach — decompose
 *      differently, re-route, condense further, search the skill
 *      library — until one works. The working avenue is saved as a
 *      learned pathway, so next time it is already okay.
 *
 * Gated: background adaptation runs only under an explicit approval
 * record. The user is told first; the learning happens second.
 * Self-iteration compounds over time, up to and including the
 * reasoning model itself (a learned pathway may be a routing change,
 * a condensed plan, or a fine-tune job — the module does not care,
 * it records what worked).
 *
 * Pure orchestration + injected deps. No I/O, no network.
 */

/**
 * Record a blockage and produce the honest user-facing message.
 * Nothing is hidden: the user hears "not okay" before any learning.
 */
export function reportBlockage({ task, reason, deps }) {
  const blockage = {
    id: `block-${deps.now()}`,
    task,
    reason,
    at: deps.now(),
  };
  deps.appendAudit({ type: 'titan/blockage', ...blockage });
  return {
    blockage,
    userMessage: `Not okay yet: ${reason}. Working every other angle in the background — I'll tell you when it's okay.`,
  };
}

/**
 * Exhaust avenues in the background until one works.
 *
 * @param {Object} args
 * @param {Object} args.blockage - from reportBlockage
 * @param {Array} args.avenues - ordered [{ name, describe }] alternative approaches
 * @param {Function} args.attempt - injected: (avenue) => { ok, result?, note? }
 * @param {Object} args.deps - { appendAudit, learnPathway(blockage, avenue, result), isApproved, now }
 * @returns {Object} { ok, avenue?, result?, tried: [names], learned: bool }
 */
export function exhaustAvenues({ blockage, avenues, attempt, deps }) {
  if (!deps.isApproved || !deps.isApproved('background-adaptation', blockage)) {
    deps.appendAudit({ type: 'titan/gate-denied', blockage: blockage.id, at: deps.now() });
    return { ok: false, tried: [], learned: false, reason: 'gate denied — no background adaptation without approval' };
  }

  const tried = [];
  for (const avenue of avenues) {
    tried.push(avenue.name);
    let outcome;
    try {
      outcome = attempt(avenue);
    } catch (err) {
      outcome = { ok: false, note: String((err && err.message) || err) };
    }
    deps.appendAudit({
      type: 'titan/avenue-tried',
      blockage: blockage.id,
      avenue: avenue.name,
      ok: outcome.ok === true,
      at: deps.now(),
    });

    if (outcome.ok === true) {
      deps.learnPathway(blockage, avenue, outcome.result);
      deps.appendAudit({
        type: 'titan/adapted',
        blockage: blockage.id,
        avenue: avenue.name,
        at: deps.now(),
      });
      return { ok: true, avenue: avenue.name, result: outcome.result, tried, learned: true };
    }
  }

  deps.appendAudit({ type: 'titan/still-blocked', blockage: blockage.id, tried, at: deps.now() });
  return { ok: false, tried, learned: false, reason: 'every avenue exhausted — still not okay, honestly reported' };
}
