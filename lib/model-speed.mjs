// lib/model-speed.mjs — a speed measurement that does not flatter the model.
//
// The existing bench (lib/model-bench.mjs) decides which model fills which role on each Mac class.
// This one answers a narrower question for one model on one host: how fast is it, really?
//
//   COLD AND WARM APART   The first request after a model is loaded pays the load. That run is
//                         reported by itself and kept out of the typical figures.
//   NO CACHE HELP         Ollama keeps the evaluated prompt and skips what it has seen. Every run
//                         gets a prompt that starts with a line no earlier run used, so each one
//                         evaluates its whole prompt.
//   TYPICAL, NOT BEST     The headline is the median of the warm runs, with the lowest and highest
//                         beside it.
//   MEASURED OR ABSENT    Time to first token is timed here, on this side of the wire. Token rates
//                         come from the host's own counters. A figure the host did not give is
//                         unavailable, never worked out from something else.

import { isUnavailable, measured, plain, unavailable } from './model-hosts.mjs';

export const SPEED_TOPICS = Object.freeze([
  'why a small shop should count its stock every week',
  'how to keep a delivery van running through winter',
  'what makes a good first day for a new employee',
  'how a bakery decides how much bread to bake',
  'why a restaurant should taste every dish before service',
  'how to set up a tidy workbench in a small garage',
  'what a landlord should check before a tenant moves in',
  'how a farm stand prices vegetables that will not keep',
]);

/** Run `i`'s prompt: a first line unlike any other run's, then the task. `seed` makes a whole session unlike the last. */
export function speedPrompt(i, seed) {
  const topic = SPEED_TOPICS[i % SPEED_TOPICS.length];
  return `Note ${seed}-${i + 1}.\nWrite a 150-word paragraph about ${topic}.`;
}

export function median(values) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
}

/** { median, min, max, of } over the runs that have this figure; unavailable when none does. */
export function spread(runs, key, digits = 1) {
  const v = runs.map((r) => r[key]).filter((x) => typeof x === 'number' && Number.isFinite(x));
  if (!v.length) return unavailable('no run reported it');
  const round = (x) => Number(x.toFixed(digits));
  return { median: round(median(v)), min: round(Math.min(...v)), max: round(Math.max(...v)), of: v.length };
}

const rate = (count, durationNs) => (Number.isFinite(count) && count > 0 && Number.isFinite(durationNs) && durationNs > 0 ? count / (durationNs / 1e9) : unavailable('the host did not report the count and time for it'));
const ms = (durationNs) => (Number.isFinite(durationNs) && durationNs >= 0 ? durationNs / 1e6 : unavailable('the host did not report it'));

/** One timed request. `client` is a host client (lib/model-hosts.mjs). */
export async function timeOneRun(client, { model, prompt, numPredict = 200, context = null, keepAlive = '10m', now = () => performance.now() }) {
  const t0 = now();
  let firstAt = null, tokensSeen = 0;
  const last = await client.generateStream(
    { model, prompt, keep_alive: keepAlive, think: false, options: { num_predict: numPredict, ...(context ? { num_ctx: context } : {}) } },
    { onLine: (l) => { if (l?.response) { tokensSeen += 1; if (firstAt == null) firstAt = now(); } } },
  );
  const end = now();
  const loadMs = ms(last?.load_duration);
  return {
    ttftMs: firstAt == null ? unavailable('the model produced no text') : Math.round(firstAt - t0),
    totalMs: Math.round(end - t0),
    loadMs: isUnavailable(loadMs) ? loadMs : Math.round(loadMs),
    genTokS: rate(last?.eval_count, last?.eval_duration),
    promptTokS: rate(last?.prompt_eval_count, last?.prompt_eval_duration),
    promptTokens: measured(last?.prompt_eval_count, 'the host did not report the prompt token count'),
    outputTokens: measured(last?.eval_count, 'the host did not report the output token count'),
    chunks: tokensSeen,
  };
}

/**
 * Measure one model on one host.
 *   runs     how many timed runs (1 to 20)
 *   warmup   load the model first, untimed, so every timed run is warm
 * → { model, host, runs: [...], cold: run|null, warm: { ttftMs, genTokS, promptTokS, totalMs }, memory, notes: [] }
 */
export async function measureSpeed(client, { model, runs = 3, warmup = false, numPredict = 200, context = null, seed = Date.now().toString(36), now = undefined, log = () => {} } = {}) {
  if (!model) throw new Error('measureSpeed: a model name is needed');
  const count = Math.min(20, Math.max(1, Math.floor(Number(runs)) || 1));
  const notes = [];
  let residentBefore;
  try { residentBefore = (await client.ps()).some((m) => (m.name ?? m.model) === model || `${m.name ?? m.model}` === `${model}:latest` || `${model}` === `${m.name ?? m.model}:latest`); } catch { residentBefore = null; }
  if (warmup) {
    log('loading the model first (not timed)');
    await client.load(model, '10m');
  }
  const startsCold = warmup ? false : residentBefore === false;

  const all = [];
  for (let i = 0; i < count; i++) {
    const run = await timeOneRun(client, { model, prompt: speedPrompt(i, seed), numPredict, context, ...(now ? { now } : {}) });
    // A run is cold when it had to load the model: it is the first run on a model that was not loaded, or the host
    // itself reports a real load time for it.
    const loaded = !isUnavailable(run.loadMs) && run.loadMs >= 250;
    // The first run is only called warm on evidence: the model was seen loaded beforehand, a warm-up was done, or
    // the host reported a negligible load time. With none of those it is "unknown" and counts as neither.
    const firstUnknown = i === 0 && !warmup && residentBefore === null && isUnavailable(run.loadMs);
    run.cold = firstUnknown ? null : (i === 0 && startsCold) || loaded;
    run.n = i + 1;
    all.push(run);
    log(`run ${i + 1} of ${count}: ${run.cold === null ? 'cold or warm not known' : run.cold ? 'cold' : 'warm'}, first token ${isUnavailable(run.ttftMs) ? 'not seen' : `${run.ttftMs} ms`}`);
  }
  const warmRuns = all.filter((r) => r.cold === false);
  const coldRuns = all.filter((r) => r.cold === true);
  if (all.some((r) => r.cold === null)) notes.push('Run 1 is left out of the typical figures: it could not be told whether it had to load the model.');
  const numeric = (r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, isUnavailable(v) ? null : v]));
  const usable = warmRuns.map(numeric);
  const warm = usable.length
    ? { runs: usable.length, ttftMs: spread(usable, 'ttftMs', 0), genTokS: spread(usable, 'genTokS', 1), promptTokS: spread(usable, 'promptTokS', 1), totalMs: spread(usable, 'totalMs', 0) }
    : unavailable('no run is known to be a warm one', 'run it again with --warmup, or with more runs');
  if (usable.length === 1) notes.push('Only one warm run: its figures are that one run, not a typical value. Use --runs 3 or more.');
  if (coldRuns.length > 1) notes.push('More than one run had to load the model: something unloaded it between runs (memory pressure, or another program using the host).');

  let memory = unavailable('the host did not list the model as loaded after the runs');
  try {
    const row = (await client.ps()).find((m) => (m.name ?? m.model) === model || `${m.name ?? m.model}:latest` === model || (m.name ?? m.model) === `${model}:latest`);
    if (row) memory = { bytes: measured(row.size, 'the host did not report it', { allowZero: false }), gpuBytes: measured(row.size_vram, 'the host did not report it') };
  } catch (e) { memory = unavailable(e.message); }

  return { model, host: client.host.name, at: new Date().toISOString(), seed, asked: { runs: count, warmup, numPredict, context }, runs: all, cold: coldRuns[0] ?? null, warm, memory, notes };
}

/** The same result with every unavailable value written out as { unavailable: true, reason }. For --json. */
export function speedAsJson(result) {
  const walk = (v) => (isUnavailable(v) ? plain(v) : Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v);
  return walk(result);
}

/** Lines for a person. */
export function speedLines(result) {
  const sp = (s, unit) => (isUnavailable(s) ? `unavailable (${s.reason})` : s.of === 1 ? `${s.median} ${unit} (one run)` : `${s.median} ${unit} typical (lowest ${s.min}, highest ${s.max}, ${s.of} runs)`);
  const one = (v, unit) => (isUnavailable(v) ? `unavailable (${v.reason})` : `${typeof v === 'number' ? Number(v.toFixed(1)) : v} ${unit}`);
  const gb = (v) => (isUnavailable(v) ? `unavailable (${v.reason})` : `${(v / 2 ** 30).toFixed(2)} GB`);
  const lines = [`${result.model} on ${result.host}`];
  if (isUnavailable(result.warm)) lines.push(`  warm: unavailable (${result.warm.reason})${result.warm.fix ? `. ${result.warm.fix}` : ''}`);
  else {
    lines.push(`  first token (warm): ${sp(result.warm.ttftMs, 'ms')}`);
    lines.push(`  writing speed:      ${sp(result.warm.genTokS, 'tokens/s')}`);
    lines.push(`  reading speed:      ${sp(result.warm.promptTokS, 'tokens/s')}`);
    lines.push(`  whole reply:        ${sp(result.warm.totalMs, 'ms')}`);
  }
  if (result.cold) lines.push(`  cold start (run ${result.cold.n}, not in the figures above): first token ${one(result.cold.ttftMs, 'ms')}, of which loading ${one(result.cold.loadMs, 'ms')}`);
  else lines.push('  cold start: not measured (the model was already loaded). Unload it first to measure one.');
  lines.push(isUnavailable(result.memory) ? `  memory: unavailable (${result.memory.reason})` : `  memory while loaded: ${gb(result.memory.bytes)}, on the GPU: ${gb(result.memory.gpuBytes)}`);
  for (const n of result.notes) lines.push(`  note: ${n}`);
  return lines;
}
