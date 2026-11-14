// lib/reflex-seat.mjs — the reflex seat: the one governed exception to one-model-at-a-time loading.
//
// Loads are cycled one at a time by default (a switch costs 1–5 s on the real M3, and residency is
// the scarce thing on a small machine). Read strictly, that rule also covers the decision model
// behind the reflex layer (lib/decision-router.mjs, served by Ollama at /v1/systemone): every reflex
// call would load the decision model, evict the worker, and pay the switch — and the next worker
// turn would pay it back. The reflex layer's whole point (~33–100 ms verdicts, no generation) dies
// in that churn.
//
// So the seat pins the decision model as a CAPPED, NON-EVICTABLE co-resident beside the one rotating
// worker — when the MEASURED arithmetic says the pair fits. The plan is computed from this device's
// measured free memory, the worker's declared size, and the registry's smallest sized decision
// model (DecisionRouter.pickDecisionModel — the same smallest-sufficient rule as every other pick;
// no device class is consulted):
//
//   • capped: the seat's planned footprint (the registry's download size + a measured runner
//     allowance) must fit what the measured free memory leaves beside the worker, and the seat
//     loads at a 2k context so its KV cache can never grow into a second worker (the
//     fast-route.mjs lesson: a small model at a default context holds gigabytes it has no use for);
//   • non-evictable: worker churn (load/unload cycles, stage swaps) never unloads the seat, and an
//     explicit unload of the seat is refused while it is pinned;
//   • pair-checked: a worker load whose declared footprint would push worker + seat over the
//     planned budget is refused with the arithmetic in the reason — never loaded on hope.
//
// The kill switch is the env KINGMAKER_REFLEX_PIN=off (also 0/false/no) or a config { on: false } —
// the same shape as the reflex layer's own switch. Off means the strict single slot, byte for byte:
// no pin, no extra loaded model, and the keeper's churn goes back to evicting whatever shares the
// slot, the decision model included. The plan is INACTIVE (reported, with the reason) whenever the
// pair does not fit the measured free memory — on any device, by arithmetic, not by tier.
//
// The keeper below is the enforcement object. It talks to Ollama through an injected client (a fake
// in tests); createOllamaSeatClient is the real one. Sizes are never invented in this module: the
// budget is measured free memory, the worker size is the caller's declared figure (defaulting to
// the floor worker's tabled size), the decision model's size comes from the decision registry —
// the only local constant is the runner allowance, measured on this tree's own evidence (below).
import { DecisionRouter, registryDownloadGb } from './decision-router.mjs';
import { FLOOR_ROLES, MODEL_GB } from './mac-profiles.mjs';

export { registryDownloadGb };

const OFF_WORDS = new Set(['0', 'off', 'false', 'no']);

/** The context the pinned seat loads with. A decision payload is a state plus at most 64 short questions
 *  (lib/decision-router.mjs calibration); the fast lane's router runs at the same 2k for the same reason —
 *  at Ollama's default context a small model holds gigabytes of KV it will never touch. */
export const REFLEX_SEAT_CONTEXT = 2048;

/** Planned resident allowance beyond a decision model's weights: KV at the seat context plus the runner.
 *  The tree's one measured point (lib/fast-route.mjs): the 0.6b router, 0.4 GB of weights, holds ~0.6 GB at
 *  a 2k context measured with /api/ps (2026-10-15) — weights + 0.2 GB. Planning uses that same +0.2. */
export const REFLEX_SEAT_OVERHEAD_GB = 0.2;

const round2 = (n) => Math.round(n * 100) / 100;

/** Pure: the kill switch for the pin. Env beats config; either one off disables the pin. Default on. */
export function reflexPinEnabled({ env = process.env, config = null } = {}) {
  const raw = env?.KINGMAKER_REFLEX_PIN;
  if (raw !== undefined && OFF_WORDS.has(String(raw).trim().toLowerCase())) return false;
  if (config === false) return false;
  if (config && typeof config === 'object' && config.on === false) return false;
  return true;
}

const installedHas = (installed, name) => installed.some((t) => t === name || String(t).startsWith(`${name}:`));

/**
 * Pure: the co-residency plan for this device. Inputs are MEASURED or DECLARED numbers only:
 * `measured` = { freeGb, totalGb } (this device's memory, GB — the plan's budget is the free
 * figure), `workerGb` = the worker's declared resident size the seat must fit beside (default:
 * the starter floor worker's tabled size), `pick` resolves the decision model (the registry's
 * smallest sized model by default — injected in tests). `installed`, when given, is the host's
 * Ollama tag list, and a seat is only planned for a model that is actually there. Inactive plans
 * carry the reason and every number that was known, so status surfaces can say exactly why the
 * strict single-slot rule stands.
 */
export function reflexSeatPlan({ measured = null, workerGb = null, env = process.env, config = null, installed = null, pick = () => DecisionRouter.pickDecisionModel() } = {}) {
  const budgetGb = Number.isFinite(measured?.freeGb) ? round2(measured.freeGb) : null;
  const worker = Number.isFinite(workerGb) && workerGb > 0 ? workerGb : (MODEL_GB[FLOOR_ROLES.writer] ?? null);
  const base = {
    active: false, reason: null,
    model: null,
    seatGb: null, seatCapGb: null, workerGb: worker, pairGb: null,
    budgetGb,
    device: measured ? { freeGb: measured.freeGb ?? null, totalGb: measured.totalGb ?? null } : null,
    maxLoadedModels: 1,
  };
  if (!reflexPinEnabled({ env, config })) return { ...base, reason: 'kill switch off (KINGMAKER_REFLEX_PIN)' };
  if (budgetGb === null) return { ...base, reason: 'no measured free memory to plan against' };
  let entry = null;
  try { entry = pick(); } catch { entry = null; }
  if (!entry?.name) return { ...base, reason: 'no registered decision model with a known size' };
  const downloadGb = registryDownloadGb(entry);
  if (downloadGb === null) return { ...base, model: entry.name, reason: `the registry gives no size for ${entry.name} — a seat is never planned on an unknown size` };
  const seatGb = round2(downloadGb + REFLEX_SEAT_OVERHEAD_GB);
  const seatCapGb = round2(budgetGb - worker);
  const nums = { model: entry.name, seatGb, seatCapGb, workerGb: worker, pairGb: round2(worker + seatGb) };
  if (seatGb > seatCapGb) return { ...base, ...nums, reason: `${entry.name} would hold ${seatGb} GB as a seat; the measured free memory (${budgetGb} GB) leaves only ${seatCapGb} GB beside a ${worker} GB worker` };
  if (installed && !installedHas(installed, entry.name)) return { ...base, ...nums, reason: `the reflex model ${entry.name} is not installed on this Mac` };
  return { ...base, ...nums, active: true, maxLoadedModels: 2, reason: 'pinned: the pair fits the measured free memory' };
}

/** Pure: the one doctor/status line for a plan — the pinned seat and the pair total against the
 *  measured budget, or why the strict single-slot rule stands. */
export function reflexSeatLine(plan) {
  if (!plan) return 'reflex seat: no plan';
  if (!plan.active) return `reflex seat: not pinned — ${plan.reason} (the strict 1-model rule stands)`;
  return `reflex seat: ${plan.model} pinned beside the worker — seat ${plan.seatGb} GB + a worker up to ${plan.workerGb} GB = ${plan.pairGb} GB of the ${plan.budgetGb} GB measured free; ${plan.maxLoadedModels} models may stay loaded and the seat is never evicted`;
}

/**
 * The seat keeper: pins the plan's decision model and governs worker loads against the pair cap, through an
 * injected Ollama client ({ load(model, { keepAlive, numCtx }), unload(model), loaded() }). With an active
 * plan the seat is loaded once with keep_alive -1 (never expires) and no worker churn touches it; a worker
 * load that would break the budget is refused before anything is loaded or unloaded. With an inactive plan
 * (kill switch, no budget, no contention) the keeper is the legacy single slot: pinning is a no-op and a
 * worker load evicts whatever else is loaded — the decision model included, exactly as before this module.
 */
export function createReflexSeatKeeper({ plan, client, log = () => {} } = {}) {
  if (!client || typeof client.load !== 'function' || typeof client.unload !== 'function' || typeof client.loaded !== 'function') {
    throw new Error('reflex-seat: an Ollama client with load/unload/loaded is required (inject a fake in tests)');
  }
  const seatModel = plan?.model ?? null;
  let pinned = false;
  let worker = null;

  async function pin() {
    if (!plan?.active) return { pinned: false, reason: plan?.reason ?? 'no plan' };
    await client.load(seatModel, { keepAlive: -1, numCtx: REFLEX_SEAT_CONTEXT });
    pinned = true;
    log('reflex_seat_pinned', { model: seatModel, seatGb: plan.seatGb, budgetGb: plan.budgetGb });
    return { pinned: true, model: seatModel };
  }

  async function loadWorker(model, gb) {
    if (!Number.isFinite(gb) || gb <= 0) throw new Error('reflex-seat: a worker load must declare its resident size in GB');
    if (plan?.active && pinned) {
      const pairGb = round2(plan.seatGb + gb);
      if (pairGb > plan.budgetGb) {
        log('reflex_seat_refused_worker', { model, gb, pairGb, budgetGb: plan.budgetGb });
        return { ok: false, refused: true, pairGb, budgetGb: plan.budgetGb, reason: `${model} at ${gb} GB + the pinned reflex seat ${plan.seatGb} GB = ${pairGb} GB, over the plan's ${plan.budgetGb} GB budget of measured free memory — the load is refused, nothing was touched` };
      }
    }
    // Churn: the outgoing worker leaves (worker eviction policy is otherwise unchanged); with the seat
    // pinned, the seat is skipped — it is the one model worker churn never evicts.
    for (const m of await client.loaded()) {
      if (m === model) continue;
      if (plan?.active && pinned && m === seatModel) continue;
      await client.unload(m);
      if (worker?.model === m) worker = null;
    }
    await client.load(model, { keepAlive: '30m' });
    worker = { model, gb };
    return { ok: true, model, gb, ...(plan?.active && pinned ? { pairGb: round2(plan.seatGb + gb), budgetGb: plan.budgetGb } : {}) };
  }

  async function unload(model) {
    if (plan?.active && pinned && model === seatModel) {
      log('reflex_seat_eviction_refused', { model });
      return { ok: false, refused: true, reason: `${model} is the pinned reflex seat — worker churn never evicts it` };
    }
    await client.unload(model);
    if (worker?.model === model) worker = null;
    if (model === seatModel) pinned = false;
    return { ok: true, model };
  }

  /** What Ollama says is resident right now (the injected client's own list). The eviction policy
   *  (lib/eviction-policy.mjs) reads it through here so its free-all walks the keeper's client, never
   *  a second one of its own. */
  async function loaded() { return client.loaded(); }

  /** The live state for status surfaces: the pinned seat, the pair total, the budget, the headroom. The
   *  pair counts the live worker, or the profile's max-size worker when none is loaded (the planned pair). */
  function status() {
    const live = Boolean(plan?.active && pinned);
    const workerGb = worker?.gb ?? plan?.workerGb ?? null;
    return {
      active: Boolean(plan?.active), pinned, model: seatModel,
      seatGb: plan?.seatGb ?? null, worker,
      pairGb: live && workerGb !== null ? round2(plan.seatGb + workerGb) : (worker ? worker.gb : null),
      budgetGb: plan?.budgetGb ?? null,
      headroomGb: live && workerGb !== null ? round2(plan.budgetGb - plan.seatGb - workerGb) : null,
      maxLoadedModels: plan?.maxLoadedModels ?? null,
      reason: plan?.reason ?? null,
    };
  }

  return { pin, loadWorker, unload, loaded, status, plan };
}

/** The real Ollama client for the keeper: an empty generate loads a model (and keep_alive 0 unloads it);
 *  /api/ps lists what is resident. Same endpoints the decision router and the lanes already use. */
export function createOllamaSeatClient({ baseUrl = 'http://127.0.0.1:11434', fetchImpl = globalThis.fetch } = {}) {
  const base = String(baseUrl).replace(/\/$/, '');
  const generate = async (body) => {
    const r = await fetchImpl(`${base}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stream: false, prompt: '', ...body }) });
    if (!r.ok) throw new Error(`ollama /api/generate HTTP ${r.status}`);
  };
  return {
    async load(model, { keepAlive = '30m', numCtx = null } = {}) {
      await generate({ model, keep_alive: keepAlive, ...(numCtx ? { options: { num_ctx: numCtx } } : {}) });
    },
    async unload(model) { await generate({ model, keep_alive: 0 }); },
    async loaded() {
      const r = await fetchImpl(`${base}/api/ps`);
      if (!r.ok) throw new Error(`ollama /api/ps HTTP ${r.status}`);
      const j = await r.json();
      return (j?.models ?? []).map((m) => m.name);
    },
  };
}
