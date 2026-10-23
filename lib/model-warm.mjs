// lib/model-warm.mjs — the weight-loading wins: no first use pays a full model load.
//
// Ollama loads a model's weights on the first request that names it, and unloads it when its
// keep_alive lapses. Before this module, both firsts landed on the owner: the first reflex decision
// paid the reflex seat's load inside the decision call, and the first governed turn paid the brain seat's
// multi-GB load inside the turn — the two slowest moments of a fresh session, disguised as thinking.
// The fix is staging, not magic:
//
//   1. PRE-WARM at engine start (background, never blocking the ready line): the reflex seat and
//      every installed brain seat are loaded into Ollama during startup, with keep_alive held open,
//      so by the time the owner speaks the weights are already resident.
//   2. MMAP, EXPLICIT: the load request pins use_mmap, so the weights are memory-mapped from disk
//      (the OS pages them in and can evict/re-page them under pressure) instead of copied into
//      anonymous memory — the difference between a page-in and a full read on an 8 GB Mac that is
//      already swapping.
//   3. ORDER: the reflex seat warms FIRST. It is the smallest class of seat and its whole job is
//      to be instant; the brain seats (GBs each) warm behind it and never delay it.
//
// Every pre-warm is best-effort by design: a seat that is not installed, or an Ollama that is not
// up yet, returns { ok: false } and the launch carries on — the first real use then pays the load
// exactly as it did before, and the log says the warm was missed.

import { DecisionRouter } from './decision-router.mjs';

export const OLLAMA_DEFAULT_BASE_URL = 'http://127.0.0.1:11434';

/** How long a pre-warmed seat stays resident in Ollama. The engine's own requests refresh it;
 *  this only has to bridge from engine start to the owner's first turns. */
export const MODEL_KEEP_ALIVE = '30m';

/** The reflex seat the pre-warm loads is the decision router's OWN pick for the host's Mac class
 *  (DecisionRouter.pickModelForMac) — never a second, hand-maintained choice: the warmed seat
 *  must be the seat the reflex layer will actually call, or the first decision pays the load
 *  anyway. At this registry revision the pick is tev1 (0.8B, 812 MB, Apache-2.0, 100 ms
 *  published latency) on every shipping class; laya (0.421B, ~450 MB, 33 ms) is the registry's
 *  next entry, not the router's pick. */

/** Pure: the Mac class the decision registry speaks, for a memory size in GB. */
export function macClassForGb(gb) {
  const g = Math.round(Number(gb) || 0);
  if (g <= 10) return '8gb';
  if (g <= 20) return '16gb';
  if (g <= 28) return '24gb';
  if (g <= 40) return '32gb';
  return '48gb+';
}

/** Pure: the reflex model to pre-warm on a Mac class — the decision router's own pick for the
 *  class, so the warmed seat is always the seat the reflex layer calls. */
export function reflexPrewarmModel(macClass) {
  return DecisionRouter.pickModelForMac(macClass).name;
}

/**
 * Pure: the Ollama load request for one seat. No prompt: /api/generate with only a model name is
 * Ollama's load call — it loads the weights and answers without generating. stream:false makes the
 * answer arrive when the load is DONE (not as it goes), which is what a pre-warm waits on.
 * keep_alive holds the seat resident; use_mmap pins the memory-mapped load (see the header).
 */
export function ollamaLoadBody(model, { keepAlive = MODEL_KEEP_ALIVE } = {}) {
  return { model, stream: false, keep_alive: keepAlive, options: { use_mmap: true } };
}

const errText = (e) => String(e?.message ?? e).slice(0, 160);

/**
 * Load one generative seat into Ollama now. Never throws.
 * → { model, ok, ms } | { model, ok: false, ms, error }
 */
export async function prewarmModel({ model, baseUrl = OLLAMA_DEFAULT_BASE_URL, fetchImpl = fetch, timeoutMs = 180_000, keepAlive = MODEL_KEEP_ALIVE, now = () => performance.now() } = {}) {
  const t = now();
  try {
    const res = await fetchImpl(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ollamaLoadBody(model, { keepAlive })),
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Drain the (small) load response so the socket is freed; its body is not the news, its status is.
    try { await res.text(); } catch { /* a load that answered is a load */ }
    const ms = now() - t;
    return res.ok ? { model, ok: true, ms } : { model, ok: false, ms, error: `HTTP ${res.status}` };
  } catch (error) {
    return { model, ok: false, ms: now() - t, error: errText(error) };
  }
}

/** Load every seat in parallel (the reflex seat is warmed separately, first — see the header).
 *  Duplicates and blanks are dropped. Never throws; one result per seat, in input order. */
export async function prewarmModels({ models = [], ...opts } = {}) {
  const seats = [...new Set(models.map((m) => String(m ?? '').trim()).filter(Boolean))];
  return Promise.all(seats.map((model) => prewarmModel({ model, ...opts })));
}

/**
 * Warm the reflex seat through the decision endpoint itself: one throwaway decide() whose only job
 * is to make Ollama load the model and take the first forward pass before the owner's first real
 * question exists. The outcome is discarded; what matters is whether the endpoint answered at all
 * (a transport failure means the seat is not there to warm). Never throws.
 * → { model, ok, ms } | { model, ok: false, ms, error }
 */
export async function prewarmReflex({ model = null, baseUrl = OLLAMA_DEFAULT_BASE_URL, fetchImpl, timeoutMs = 120_000, now = () => performance.now(), router = null } = {}) {
  // The seat: the caller's explicit model, else the injected router's own model, else the
  // router's pick for the smallest class (the pick is the same on every class at this revision).
  const seat = model ?? router?.config?.model ?? reflexPrewarmModel('8gb');
  const t = now();
  try {
    const r = router ?? new DecisionRouter({
      model: seat,
      baseUrl,
      ...(fetchImpl ? { fetchImpl } : {}),
      // A decision's 2 s budget is for a WARM model; the warm-up call carries the load, so it gets
      // the load's budget instead. The calibration thresholds are unused for a discarded outcome.
      calibration: { timeoutMs },
    });
    const outcomes = await r.decide({
      state: 'kingmaker engine start: reflex pre-warm. No owner content; the answer is discarded.',
      questions: { warmup: { type: 'choice', prompt: 'Is the reflex layer awake?', options: ['awake', 'asleep'] } },
    });
    const ms = now() - t;
    const answered = Array.isArray(outcomes) && outcomes.length > 0 && outcomes.every((o) => o.kind !== 'transport-failed');
    return answered
      ? { model: seat, ok: true, ms }
      : { model: seat, ok: false, ms, error: outcomes?.[0]?.reason ?? 'the decision endpoint did not answer' };
  } catch (error) {
    return { model: seat, ok: false, ms: now() - t, error: errText(error) };
  }
}

/**
 * Pure: the startup stage plan — what a fresh session predictably needs, and which of it may block
 * the ready line. Blocking: only what the first turn's SAFETY depends on (the rules check is
 * fail-closed; the hands line names what the first turn may drive). Everything a first turn merely
 * benefits from — warm seats, the Chrome connector's freshness — is background: started at engine
 * start, finished whenever it finishes, logged either way.
 */
export function startupStagePlan({ reflexModel = reflexPrewarmModel('8gb'), brainModels = [], chromeSync = true } = {}) {
  const seats = [...new Set(brainModels.map((m) => String(m ?? '').trim()).filter(Boolean))];
  return [
    { id: 'rules-check', mode: 'blocking', why: 'fail closed: a core without its rules is stopped, not used' },
    { id: 'hands-warm', mode: 'blocking', why: 'the console line names the hands the first turn can drive' },
    { id: 'reflex-warm', mode: 'background', model: reflexModel, why: 'the first reflex decision must not pay the reflex seat\'s load' },
    ...seats.map((model) => ({ id: `brain-warm:${model}`, mode: 'background', model, why: 'the first governed turn must not pay this seat\'s load' })),
    ...(chromeSync ? [{ id: 'chrome-sync', mode: 'background', why: 'connector freshness is housekeeping; the first turn does not wait on it' }] : []),
  ];
}

/**
 * Start background stages now; they run concurrently with whatever the caller does next (the
 * blocking stages, the session opening). A stage that fails is an outcome, never an exception —
 * startup staging is an optimization, and an optimization must not be able to break the launch.
 * → { outcomes: Promise<[{ id, ok, ms, error? }]> } in stage order.
 */
export function runBackgroundStages(stages, { log = () => {}, now = () => performance.now() } = {}) {
  const outcomes = Promise.all(stages.map(async ({ id, run }) => {
    const t = now();
    try {
      await run();
      const ms = now() - t;
      log('startup_stage', { id, ok: true, ms: Math.round(ms) });
      return { id, ok: true, ms, error: null };
    } catch (error) {
      const ms = now() - t;
      log('startup_stage', { id, ok: false, ms: Math.round(ms), error: errText(error) });
      return { id, ok: false, ms, error: errText(error) };
    }
  }));
  return { outcomes };
}
