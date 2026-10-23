// lib/eviction-policy.mjs — ONE eviction policy for Kingmaker's own Ollama loads (runway §3.3).
//
// Before this module, every call site that loads a model on this Mac decided residency for itself:
// the fast router and the connector lane held their models with a literal keep_alive '30m', the write
// lane sent no keep_alive at all (Ollama's 5-minute default), the ad lane unloaded itself with
// keep_alive 0, and the image lane unloaded EVERYTHING it found — the pinned reflex seat included.
// The reflex seat's keeper (lib/reflex-seat.mjs, PR #117) governs the loads it makes, but the lanes
// never went through it, so on the 8 GB profile the pair cap was policy on paper: a lane could load a
// model that broke the budget, or evict the seat, without anything arithmetic objecting.
//
// This module is the discipline the lanes now share, and it is deliberately small:
//
//   • INTENT, not mechanics, at the call site. A site declares what a load IS — 'pin' (the reflex
//     seat: never expires), 'warm' (a working seat: stays resident for the next turn), 'transient'
//     (answer and leave) — and the one table below decides the keep_alive. The values are the tree's
//     own: -1 is the keeper's pin, '30m' is what the warm sites already used (and Track B's pre-warm
//     constant, MODEL_KEEP_ALIVE in the cold-start work), 0 is the ad lane's self-eviction.
//
//   • ADMISSION through the keeper. On a profile where the co-residency plan is active, a lane load
//     goes through the keeper's pair cap first (lib/reflex-seat.mjs loadWorker): over-budget loads
//     are refused with the keeper's arithmetic BEFORE any byte is sent to Ollama, worker churn evicts
//     the outgoing worker and never the pinned seat. A transient load is admitted the same way and
//     released through the keeper when its call ends, so every residency transition on an active
//     profile is the keeper's, not a call site's habit.
//
//   • LEGACY BY REFERENCE everywhere else. With no active plan (every larger profile, the kill
//     switch, no keeper) the policy is inert: admission returns the call site's own legacy keep_alive
//     untouched and touches no Ollama state, so each site's request bytes are exactly what they were
//     before this module existed. Call sites that run in one-shot processes with no console keeper
//     (kingmaker say, the bench and soak harnesses) simply never receive a policy — see the PR body
//     for the full inventory and each unrouted site's reason.
//
// A load's declared size is the tree's only per-model size table (MODEL_GB in lib/mac-profiles.mjs);
// a model the table doesn't know is declared at the profile's per-model ceiling — the same worst
// case the seat plan itself was built against — and a caller holding a measured resident size may
// declare it instead. On an active plan the seat's own traffic is never admitted against itself:
// the pin governs it.
import { MODEL_GB } from './mac-profiles.mjs';

/** The intents a load can declare. Sites say what a load IS; the table below says how it resides. */
export const EVICTION_INTENTS = Object.freeze(['pin', 'warm', 'transient']);

/** The one keep_alive table. pin: the reflex seat's -1 (lib/reflex-seat.mjs). warm: '30m', the value
 *  the fast router, the connector lane, the suggestion writer and the keeper's own worker loads
 *  already used. transient: 0, the ad lane's answer-and-unload. */
export const KEEP_ALIVE_BY_INTENT = Object.freeze({ pin: -1, warm: '30m', transient: 0 });

/** Pure: the keep_alive for an intent. An unknown intent is a programming error, never a default. */
export function keepAliveForIntent(intent) {
  if (!EVICTION_INTENTS.includes(intent)) throw new Error(`eviction-policy: unknown intent "${intent}" (one of ${EVICTION_INTENTS.join(', ')})`);
  return KEEP_ALIVE_BY_INTENT[intent];
}

/** Pure: a load's declared size in GB — MODEL_GB (the tree's per-model size table) when it knows the
 *  model, else the profile's per-model ceiling (the worst case the seat plan was built against),
 *  else null: the tree sizes nothing about this load and the policy will not invent a number. */
export function declaredLoadGb(model, { profile = null } = {}) {
  const known = MODEL_GB[model];
  if (Number.isFinite(known) && known > 0) return known;
  return Number.isFinite(profile?.maxResidentGb) ? profile.maxResidentGb : null;
}

/**
 * The policy object the console builds once (from the reflex seat's plan + keeper) and hands to the
 * lanes. Inactive — no plan, an inactive plan, or no keeper — every method is the legacy behavior:
 * keepAlive returns the caller's legacy value, admit approves with that value and touches nothing,
 * freeAll returns null so the caller runs its own legacy free.
 */
export function createEvictionPolicy({ plan = null, keeper = null, profile = null, log = () => {} } = {}) {
  const active = Boolean(plan?.active && keeper);
  const seatModel = plan?.model ?? null;

  /** The keep_alive a call site should send: the table's value on an active plan, the site's own
   *  legacy value (which may be undefined — some sites send no keep_alive at all) everywhere else. */
  function keepAlive(intent, legacy) {
    keepAliveForIntent(intent);   // an unknown intent throws on every profile, active or not
    return active ? KEEP_ALIVE_BY_INTENT[intent] : legacy;
  }

  /**
   * Admit one lane load. → { ok: true, keepAlive, via } or { ok: false, refused: true, reason,
   * pairGb, budgetGb, keepAlive }. On an active plan a warm/transient load is routed through the
   * keeper's loadWorker (pair cap + churn + the load itself); a refusal comes back BEFORE the call
   * site sends anything, carrying the keeper's arithmetic. The seat's own model is admitted without
   * touching the keeper — the pin governs it. A load the tree cannot size is admitted unmeasured
   * (the keeper refuses unsized worker loads by design, and the policy plans nothing on an unknown
   * size — the same doctrine as the seat plan), with the fact logged.
   */
  async function admit({ model, intent = 'warm', gb = null, legacy = undefined } = {}) {
    const tabled = keepAlive(intent, legacy);
    if (!active) return { ok: true, active: false, via: 'legacy', keepAlive: tabled };
    if (model === seatModel) return { ok: true, active: true, via: 'seat', keepAlive: tabled };
    const size = gb ?? declaredLoadGb(model, { profile });
    if (size === null) {
      log('eviction_unmeasured_load', { model, intent });
      return { ok: true, active: true, via: 'unmeasured', keepAlive: tabled };
    }
    const r = await keeper.loadWorker(model, size);
    if (!r.ok) {
      log('eviction_refused', { model, intent, gb: size, pairGb: r.pairGb, budgetGb: r.budgetGb });
      return { ok: false, active: true, refused: true, reason: r.reason, pairGb: r.pairGb, budgetGb: r.budgetGb, keepAlive: tabled };
    }
    return { ok: true, active: true, via: 'keeper', pairGb: r.pairGb, budgetGb: r.budgetGb, keepAlive: tabled };
  }

  /** Release a load admitted through the keeper (a transient call that has ended). Best effort by
   *  design: bookkeeping for the keeper's worker record, never a reason to fail the caller's work —
   *  and the keeper itself refuses to unload the pinned seat, so releasing the wrong name is safe. */
  async function release(model) {
    if (!active) return { ok: true, via: 'legacy' };
    try { return await keeper.unload(model); } catch (err) { log('eviction_release_failed', { model, error: String(err?.message ?? err).slice(0, 160) }); return { ok: false, via: 'keeper' }; }
  }

  /** Free every resident model except the pinned seat — the image lane's unload-all, under the
   *  policy: on an active plan the seat is SPARED (the keeper's unload refuses it a second time
   *  over). Returns null on an inactive plan: the caller's legacy free runs, byte for byte. */
  async function freeAll() {
    if (!active) return null;
    const unloaded = [];
    for (const m of await keeper.loaded()) {
      if (m === seatModel) continue;
      const r = await keeper.unload(m);
      if (r.ok) unloaded.push(m);
    }
    log('eviction_free_all', { unloaded, spared: seatModel });
    return { unloaded, spared: seatModel };
  }

  return { active, plan, keepAlive, admit, release, freeAll };
}
