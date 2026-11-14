// proof/transport.mjs — the two ways a proof stage can run, and the label that keeps them apart.
//
//   REAL      createOllamaTransport: talks to a live Ollama; token counts are the endpoint's own
//             report (prompt_eval_count / eval_count — the token-meter convention, never estimated).
//   SIMULATED createCountingTransport + createSimulatedSystemOneFetch: no endpoint at all. Counts
//             come from the workload's estimator and durations from a stated rate model, so a VM
//             run proves the harness (metering, verdicts, report) and NOTHING about hardware.
//             A simulated number is labeled simulated at every layer — stage, report, verdict.
//
// Simulated durations are returned per call (durationMs), and the runner schedules them over the
// concurrency pool with scheduledWallMs() — a deterministic model of parallel execution:
// calls fill pool slots greedily, the stage's wall is its fullest slot.

import { estimateTokens, textForTokens } from './workload.mjs';

const errText = (e) => String(e?.message ?? e).slice(0, 200);

/** Greedy list scheduling: the wall time of running `durations` (ms) over `width` parallel
 *  slots. Pure and deterministic — the simulated stage wall, and an upper-bound sanity model
 *  for real ones. */
export function scheduledWallMs(durations, width = 1) {
  const w = Math.max(1, Math.floor(width) || 1);
  const slots = new Array(w).fill(0);
  for (const d of durations) {
    let min = 0;
    for (let i = 1; i < w; i += 1) if (slots[i] < slots[min]) min = i;
    slots[min] += d;
  }
  return Math.max(...slots);
}

/** A clock a test (or a simulated run) drives by hand: now() reads it, advance() moves it. */
export function createManualClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; return t; } };
}

/**
 * The REAL transport: Ollama /api/generate, non-streamed, counts from the endpoint's report.
 * → generate({ model, prompt, genTokens }) ⇒ { promptTokens, generatedTokens, promptNs, evalNs, text, raw }
 */
export function createOllamaTransport({ baseUrl = 'http://127.0.0.1:11434', fetchImpl = globalThis.fetch, keepAlive = '30m' } = {}) {
  const base = String(baseUrl).replace(/\/$/, '');
  return {
    kind: 'real',
    async generate({ model, prompt, genTokens }) {
      const res = await fetchImpl(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model, prompt, stream: false, keep_alive: keepAlive,
          options: { num_predict: genTokens, use_mmap: true },
        }),
      });
      if (!res.ok) throw new Error(`ollama /api/generate HTTP ${res.status}`);
      const j = await res.json();
      return {
        promptTokens: Number(j.prompt_eval_count) || 0,
        generatedTokens: Number(j.eval_count) || 0,
        promptNs: Number(j.prompt_eval_duration) || 0,
        evalNs: Number(j.eval_duration) || 0,
        text: typeof j.response === 'string' ? j.response : '',
        raw: j,
      };
    },
  };
}

/** The simulated rate model, stated in one place so a simulated report can quote it: prefill is
 *  parallel and cheap, decode is sequential and dear — the doctrine, as numbers a fake honors. */
export const SIM_RATES = Object.freeze({ prefillTokS: 20000, decodeTokS: 400, reflexTokS: 50000 });

/**
 * The SIMULATED transport: counts with the workload estimator, "generates" an exact-token
 * completion, and reports the duration the rate model assigns. Never touches the network.
 * → generate({ model, prompt, genTokens }) ⇒ { ..., durationMs, simulated: true }
 */
export function createCountingTransport({ rates = SIM_RATES } = {}) {
  return {
    kind: 'simulated',
    rates,
    async generate({ prompt, genTokens }) {
      const promptTokens = estimateTokens(prompt);
      const generatedTokens = Math.max(0, Math.floor(genTokens) || 0);
      const durationMs = (promptTokens / rates.prefillTokS) * 1000 + (generatedTokens / rates.decodeTokS) * 1000;
      return {
        promptTokens,
        generatedTokens,
        promptNs: Math.round((promptTokens / rates.prefillTokS) * 1e9),
        evalNs: Math.round((generatedTokens / rates.decodeTokS) * 1e9),
        text: textForTokens(generatedTokens),
        durationMs,
        simulated: true,
      };
    },
  };
}

/**
 * The SIMULATED System One endpoint, as a fetchImpl for the real DecisionRouter: answers every
 * question with a confident, deterministic probability split and records the duration the rate
 * model assigns each call, for the runner to schedule. takeDurations() drains the record.
 */
export function createSimulatedSystemOneFetch({ rates = SIM_RATES } = {}) {
  const durations = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init?.body ?? '{}');
    const payloadTokens = estimateTokens(JSON.stringify({ state: body.state, questions: body.questions }));
    durations.push((payloadTokens / rates.reflexTokS) * 1000);
    const answers = {};
    for (const [name, q] of Object.entries(body.questions ?? {})) {
      const opts = Array.isArray(q?.options) && q.options.length ? q.options : ['yes', 'no'];
      const probabilities = {};
      opts.forEach((o, i) => { probabilities[o] = i === 0 ? 0.95 : 0.05 / (opts.length - 1 || 1); });
      answers[name] = { probabilities };
    }
    return { ok: true, status: 200, json: async () => ({ answers }) };
  };
  return { fetchImpl, rates, takeDurations: () => durations.splice(0, durations.length) };
}
