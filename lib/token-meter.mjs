// lib/token-meter.mjs — every model call Kingmaker makes, counted from what the provider itself reports: Ollama's
// eval_count/eval_duration (decode) and prompt_eval_* (prefill) for the local lanes; a cloud brain's own usage and cost
// (Claude Code's JSON reports both; what Codex and Grok print is taken as is, nothing guessed). For the Ronin launcher's
// machine card (GET /admin/metrics: the live rates) and its analytics (GET /admin/metrics/history, lib/metrics-history.mjs).
//
// recordTo(state) (the engine, at start) also appends each call to <state>/metrics/model-calls-YYYY-MM.jsonl (0600): the
// time, lane, kind, model, token counts, durations, outcome and reported cost. Never a prompt, an answer or a key.
// Recording starts the first time the engine runs this; nothing before it is backfilled (metrics/since.json).
// The engine's own model calls and keys are its business and are not seen here.
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { currentProfile, ROLES } from './mac-profiles.mjs';

const WINDOW = 10;        // the live rates are over the last few real answers
const MIN_TOKENS = 16;    // a router's one-word lane is too short to time
export const KINDS = Object.freeze(['turn', 'router', 'tool', 'connector', 'extension', 'nightly']);
const since = new Date().toISOString();
let generated = 0, prompt = 0, dir = null, profile = null, profileAt = 0;
const decode = [], prefill = [];

export const metricsDir = (state) => join(state, 'metrics');
export const callsFile = (state, d = new Date()) => join(metricsDir(state), `model-calls-${d.toISOString().slice(0, 7)}.jsonl`);
/** Dataset uses (which model, lane or job read which connected dataset): <state>/metrics/dataset-uses-YYYY-MM.jsonl. */
export const usesFile = (state, d = new Date()) => join(metricsDir(state), `dataset-uses-${d.toISOString().slice(0, 7)}.jsonl`);

/** Start writing calls to the data folder (the engine). Marks when recording began, once. */
export function recordTo(state) {
  dir = state;
  mkdirSync(metricsDir(state), { recursive: true, mode: 0o700 });
  const f = join(metricsDir(state), 'since.json');
  if (!existsSync(f)) writeFileSync(f, JSON.stringify({ recordedSince: new Date().toISOString() }), { mode: 0o600 });
}
/** For tests: stop writing and clear the live numbers. */
export function resetMeter() { generated = 0; prompt = 0; decode.length = 0; prefill.length = 0; dir = null; profile = null; }

/** The lane a local model serves on this Mac (its profile's pick), else 'other'. */
function laneOf(model) {
  if (!dir || !model) return 'other';
  if (!profile || Date.now() - profileAt > 300_000) { try { profile = currentProfile(dir); } catch { profile = null; } profileAt = Date.now(); }
  return ROLES.find((r) => profile?.[r] === model) ?? 'other';
}
const num = (v) => (v != null && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null);
const outcomeOf = (error) => (error?.name === 'AbortError' ? 'cancelled' : 'error');
function write(rec, file = callsFile) {
  if (!dir) return;
  try { appendFileSync(file(dir), `${JSON.stringify(rec)}\n`, { mode: 0o600 }); } catch { /* never breaks a turn */ }
}

/** One Ollama /api/chat or /api/generate answer (non-streamed). `lane` when the caller knows it; else by model. */
export function meter(j, { lane = null, kind = 'turn', model = null } = {}) {
  if (!j || typeof j !== 'object') return;
  const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
  const ec = n(j.eval_count), ed = n(j.eval_duration), pc = n(j.prompt_eval_count), pd = n(j.prompt_eval_duration);
  generated += ec; prompt += pc;
  if (ec >= MIN_TOKENS && ed) { decode.push([ec, ed]); if (decode.length > WINDOW) decode.shift(); }
  if (pc >= MIN_TOKENS && pd) { prefill.push([pc, pd]); if (prefill.length > WINDOW) prefill.shift(); }
  const m = String(j.model || model || '') || null;
  write({ at: new Date().toISOString(), provider: 'ollama', lane: lane || laneOf(m), kind, model: m, prompt: pc, generated: ec, promptNs: pd, evalNs: ed, outcome: 'ok' });
}
/** A local call that failed (or was cancelled): counted as a request with no tokens. */
export function meterFail({ lane = null, kind = 'turn', model = null, error = null } = {}) {
  write({ at: new Date().toISOString(), provider: 'ollama', lane: lane || laneOf(model), kind, model: model || null, prompt: 0, generated: 0, promptNs: 0, evalNs: 0, outcome: outcomeOf(error) });
}
/** One cloud-brain turn, from what its CLI reported. Unknown numbers stay null; cost only when the provider gives it. */
export function meterCloud({ provider, model = null, prompt: p = null, generated: g = null, costUsd = null, billing = null, outcome = 'ok', kind = 'turn' }) {
  write({ at: new Date().toISOString(), provider, lane: null, kind, model: model || provider, prompt: num(p), generated: num(g), costUsd: num(costUsd), billing, outcome });
}

/** One read of a connected dataset (its id from GET /admin/datasets) by a model, lane or job. Never its content. */
export function meterDataset({ dataset, model = null, lane = null, kind = 'turn' }) {
  if (!dataset) return;
  write({ at: new Date().toISOString(), dataset: String(dataset).slice(0, 120), model: model || null, lane: lane || null, kind }, usesFile);
}

const rate = (list) => {
  if (!list.length) return null;
  const tokens = list.reduce((s, [c]) => s + c, 0), ns = list.reduce((s, [, d]) => s + d, 0);
  return +(tokens / (ns / 1e9)).toFixed(1);
};
/** { decodeTokS, prefillTokS, generated, prompt, since }: the local rates, null until something ran. */
export const meterSnapshot = () => ({ decodeTokS: rate(decode), prefillTokS: rate(prefill), generated, prompt, since });
