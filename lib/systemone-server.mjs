// lib/systemone-server.mjs — the in-tree /v1/systemone endpoint (F-07 D1, the "build" option).
//
// The reflex layer's contract (lib/decision-router.mjs) is a POST to
// {baseUrl}/v1/systemone with { model, state, questions } answered by
// { answers: { [name]: { probabilities: { [option]: p } } } } — one
// forward pass over a FIXED answer space, no free text. Until now no
// in-tree server implemented that route: Ollama does not serve it for
// the registry's decision models on the target installs, so every
// decide() transport-failed and the layer lived on its reasoning
// fallback (safe, but inert — see LIGHT-UI-BUILD-REPORT §3).
//
// This module is the missing server, as an ADAPTER in front of Ollama:
// it takes the typed request in the in-tree dialect (a choice declares
// options: [..]; a score declares kind: 'score'), translates it into
// the contract dialect Ollama's native /v1/systemone speaks (every
// question carries instructions; a choice carries a criteria map; a
// score carries 2–10 level labels; contracts/decision-model.ts), makes
// ONE native call for all questions, and translates the answers back
// into the router's shape. The model doing the scoring is the registry
// model itself (tev1/laya/...), never a substitute brain; this file
// contains no decision logic of its own beyond translation, clamping
// to the declared answer space, and normalizing each map to sum 1.
//
// WHY TRANSLATION, NOT GENERATE (2026-11-13, measured live): the first
// cut of this adapter asked the model through Ollama's generate API
// with a JSON-schema-constrained reply. The registry's decision models
// are classifiers — Ollama answers `"laya" does not support generate`
// — so that path 503'd every call. Current Ollama (>= the registry's
// 0.35.0 floor; 0.40.16 measured) serves /v1/systemone natively, but
// only in the contract dialect: the router's in-tree questions get a
// 400 ("instructions must be provided"). The adapter's job is the
// dialect bridge; the scoring is the model's own forward pass either
// way — output_tokens: 0, no text generated.
//
// FAILURE POSTURE — the fallback is the contract, not an accident:
//   model not installed in Ollama  -> 503 (router: transport-failed)
//   Ollama unreachable             -> 503
//   native endpoint errors         -> 503 (the native error rides along)
//   a question's answer unusable   -> that question's answer is OMITTED
//                                     (router: "endpoint returned no
//                                     answer" -> transport-failed for
//                                     that question alone)
//   unregistered model requested   -> 400 (the registry is the license
//                                     gate, same as DecisionRouter's)
//   malformed request              -> 400
// Every failure mode lands the reflex layer on its reasoning fallback
// with the failure attached — exactly the pre-endpoint behavior, never
// a hard fail and never an invented verdict.
//
// SCORE QUESTIONS (kind: 'score'): the native endpoint rates over
// ordered level labels (2–10) and returns a probability per level; the
// adapter maps them back onto the labels, so the router's calibration
// bands read the top level's probability as the confidence (the
// contract's shape, contracts/decision-model.ts). An in-tree score
// question that declares no labels rides the default 1–5 rubric.
// (The pre-translation adapter instead asked the model for a lone
// {'score': 0..1} rating; the layer still accepts that shape from any
// endpoint that speaks it — lib/reflex-layer.mjs.)
//
// VERDICT QUESTIONS (type: 'noul'): the native endpoint returns a bare
// probability for the condition; the adapter expands it to the map
// {'true': p, 'false': 1-p} with answer = (p >= 0.5), the shape the
// router bands on.
//
// WIRING: the console starts this server on a loopback port fronting
// Ollama and points the router at it BY DEFAULT (lib/cli.mjs) — Ollama
// does not serve /v1/systemone for the registry models on the target
// installs, so a direct-by-default router transport-failed every
// decide() and the layer lived on its reasoning fallback. The opt-out
// is KINGMAKER_SYSTEMONE=ollama (or an off word: 0/off/false/no): the
// router talks to Ollama directly, byte for byte the pre-wire-up
// behavior. KINGMAKER_SYSTEMONE=local (or 1/true/on/yes) names the
// default explicitly. KINGMAKER_SYSTEMONE_PORT overrides the port
// (default 11435, beside Ollama's 11434).

import { createServer as openLoopbackServer } from 'node:http';
import { DECISION_MODEL_REGISTRY } from './decision-router.mjs';

export const SYSTEMONE_DEFAULT_PORT = 11435;
const OFF_WORDS = new Set(['0', 'off', 'false', 'no']);

/** Pure: does the router talk to the in-tree endpoint? Default YES — see the WIRING note above.
 *  The only opt-outs are KINGMAKER_SYSTEMONE=ollama/direct (talk to Ollama's own route) and the
 *  off words (0/off/false/no), which meant direct before the wire-up and still do. */
export function systemOneShimEnabled({ env = process.env } = {}) {
  const raw = env?.KINGMAKER_SYSTEMONE;
  if (raw === undefined) return true;
  const v = String(raw).trim().toLowerCase();
  if (OFF_WORDS.has(v) || v === 'ollama' || v === 'direct') return false;
  return true;
}

/** Pure: where the router should point, and whether a shim must be started to serve it. */
export function resolveSystemOneRoute({ env = process.env, ollamaBaseUrl = 'http://127.0.0.1:11434' } = {}) {
  const ollama = String(ollamaBaseUrl).replace(/\/$/, '');
  if (!systemOneShimEnabled({ env })) return { baseUrl: ollama, shim: false, ollamaBaseUrl: ollama };
  const port = Number(env?.KINGMAKER_SYSTEMONE_PORT) || SYSTEMONE_DEFAULT_PORT;
  return { baseUrl: `http://127.0.0.1:${port}`, shim: true, ollamaBaseUrl: ollama, port };
}

const isChoice = (q) => Array.isArray(q?.options) && q.options.length >= 2 && q.options.every((o) => typeof o === 'string' && o.length > 0);
const isScore = (q) => (q?.kind ?? q?.type) === 'score';
const isNoul = (q) => (q?.kind ?? q?.type) === 'noul' && (typeof q?.condition === 'string' && q.condition.length > 0 || typeof q?.instructions === 'string' && q.instructions.length > 0);

/** Pure: validate an endpoint request body against the router contract. Returns { error } or { model, state, questions }. */
export function validateSystemOneRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'request body must be a JSON object' };
  const { model, state, questions } = body;
  if (typeof model !== 'string' || !model) return { error: 'model is required' };
  if (!DECISION_MODEL_REGISTRY.some((r) => r.name === model)) {
    return { error: `model "${model}" is not in the licensed decision registry — refusing to serve an unvetted decision model` };
  }
  if (!questions || typeof questions !== 'object' || Array.isArray(questions)) return { error: 'questions must be an object of named questions' };
  const entries = Object.entries(questions);
  if (entries.length === 0) return { error: 'at least one question is required' };
  if (entries.length > 64) return { error: `${entries.length} questions exceeds the endpoint cap of 64 per call` };
  for (const [name, q] of entries) {
    if (!isChoice(q) && !isScore(q) && !isNoul(q)) return { error: `question "${name}" has no fixed answer space (options: [..], kind: 'score', or type: 'noul' with a condition)` };
  }
  // The native endpoint accepts the state as a string or an object; pass both through untouched.
  return { model, state: typeof state === 'string' || (state && typeof state === 'object') ? state : {}, questions };
}

/** The rubric a score question rides when it declares no level labels of its own. */
export const DEFAULT_SCORE_LEVELS = ['1', '2', '3', '4', '5'];

/** Pure: the score question's level labels — its own criteria when they are 2–10 strings, else the default rubric. */
export function scoreLevels(q) {
  if (Array.isArray(q?.criteria) && q.criteria.length >= 2 && q.criteria.length <= 10 && q.criteria.every((c) => typeof c === 'string' && c)) return q.criteria;
  return DEFAULT_SCORE_LEVELS;
}

/**
 * Pure: translate one validated in-tree request into the contract dialect the native endpoint
 * speaks. Returns { request, levels } — levels maps each score question's name to the level
 * labels its answer probabilities come back over (the native endpoint keys them by index).
 */
export function buildNativeSystemOneRequest({ model, state, questions }) {
  const nativeQuestions = {};
  const levels = {};
  for (const [name, q] of Object.entries(questions)) {
    if (isChoice(q)) {
      const described = {};
      for (const o of q.options) described[o] = typeof q.criteria?.[o] === 'string' && q.criteria[o] ? q.criteria[o] : o;
      const extra = typeof q.criteria === 'string' && q.criteria ? ` ${q.criteria}` : '';
      nativeQuestions[name] = { type: 'choice', instructions: (typeof q.instructions === 'string' && q.instructions ? q.instructions : 'Choose the option that best fits the state.') + extra, criteria: described };
    } else if (isScore(q)) {
      const lv = scoreLevels(q);
      levels[name] = lv;
      nativeQuestions[name] = { type: 'score', instructions: typeof q.instructions === 'string' && q.instructions ? q.instructions : `Rate on a scale of ${lv[0]} to ${lv[lv.length - 1]}.`, criteria: lv };
    } else {
      nativeQuestions[name] = { type: 'noul', instructions: typeof q.instructions === 'string' && q.instructions ? q.instructions : q.condition, condition: typeof q.condition === 'string' && q.condition ? q.condition : q.instructions };
    }
  }
  return { request: { model, state, questions: nativeQuestions }, levels };
}

/**
 * Pure: translate the native endpoint's answers back into the router's shape. Choice maps are
 * clamped to the declared options and normalized to sum 1; score maps are re-keyed from level
 * indexes onto their labels (the native legend wins when present); a noul probability expands
 * to {'true': p, 'false': 1-p}. A question whose answer ends up empty is OMITTED — the router
 * reads an omitted answer as a per-question transport failure, never as a verdict.
 */
export function translateNativeAnswers(native, questions, levels = {}) {
  const raw = native?.answers;
  if (!raw || typeof raw !== 'object') return {};
  const clampMap = (pairs) => {
    const clean = {};
    let sum = 0;
    for (const [key, v] of pairs) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) { clean[key] = n; sum += n; }
    }
    if (sum <= 0) return null;
    const normalized = {};
    for (const [key, v] of Object.entries(clean)) normalized[key] = Math.round((v / sum) * 1e6) / 1e6;
    return normalized;
  };
  const answers = {};
  for (const [name, q] of Object.entries(questions)) {
    const a = raw[name];
    if (!a || typeof a !== 'object') continue;
    if (isChoice(q)) {
      const probs = a.probabilities && typeof a.probabilities === 'object'
        ? clampMap(q.options.map((o) => [o, a.probabilities[o]])) : null;
      if (probs) answers[name] = { ...(typeof a.choice === 'string' ? { answer: a.choice } : {}), probabilities: probs };
    } else if (isScore(q)) {
      const lv = levels[name] ?? scoreLevels(q);
      const legend = a.legend && typeof a.legend === 'object' ? a.legend : null;
      const probs = a.probabilities && typeof a.probabilities === 'object'
        ? clampMap(Object.entries(a.probabilities).map(([idx, v]) => [legend?.[idx] ?? lv[Number(idx)] ?? idx, v])) : null;
      if (probs) {
        const declared = Array.isArray(q.criteria) && q.criteria.length >= 2;
        if (declared) {
          // Caller declared the level labels: the distribution over them is the answer.
          const top = Object.entries(probs).sort((x, y) => y[1] - x[1])[0];
          answers[name] = { ...(top ? { answer: lv.indexOf(top[0]) } : {}), probabilities: probs };
        } else {
          // No declared criteria: the layer's contract for a bare score question is the
          // lone-rating shape { probabilities: { score: rating } } (see reflex-layer's
          // decisionAnswerProblem + the seam tests). The rating is the model's expected
          // level, normalized to [0,1]; the expected level index rides as the answer.
          let expected = 0;
          for (const [label, p] of Object.entries(probs)) expected += (lv.indexOf(label) ?? 0) * p;
          const rating = lv.length > 1 ? Math.round((expected / (lv.length - 1)) * 1e6) / 1e6 : expected;
          answers[name] = { answer: Math.round(expected), probabilities: { score: Math.min(1, Math.max(0, rating)) } };
        }
      }
    } else if (isNoul(q)) {
      const p = Number(a.noul);
      if (Number.isFinite(p) && p >= 0 && p <= 1) {
        answers[name] = { answer: p >= 0.5, probabilities: { true: Math.round(p * 1e6) / 1e6, false: Math.round((1 - p) * 1e6) / 1e6 } };
      }
    }
  }
  return answers;
}

/** Pure: the single batched prompt. The state and every question's fixed answer space, and nothing else
 *  to decide with — the model scores; it does not get to editorialize. */
export function buildSystemOnePrompt({ state, questions }) {
  const lines = [
    'You are a System One decision model. Score each question over its FIXED answer space.',
    'Reply with JSON only, in exactly this shape:',
    '{"answers":{"<question>":{"probabilities":{"<option>":<0..1>}}}}',
    'Probabilities for one question must sum to 1. For a question of kind "score", reply {"probabilities":{"score":<0..1 rating>}}.',
    '',
    `STATE: ${JSON.stringify(state)}`,
    '',
    'QUESTIONS:',
  ];
  for (const [name, q] of Object.entries(questions)) {
    const spec = isChoice(q)
      ? `options: ${JSON.stringify(q.options)}`
      : 'kind: score (rate 0..1)';
    const extra = [q.instructions, q.criteria].filter((s) => typeof s === 'string' && s).join(' ');
    lines.push(`- ${name}: ${spec}${extra ? ` — ${extra}` : ''}`);
  }
  return lines.join('\n');
}

/** The JSON-schema constraint handed to Ollama's format parameter: the answers envelope, nothing else. */
export function systemOneResponseSchema(questions) {
  const perQuestion = {};
  for (const [name, q] of Object.entries(questions)) {
    perQuestion[name] = isChoice(q)
      ? {
          type: 'object',
          properties: { probabilities: { type: 'object', properties: Object.fromEntries(q.options.map((o) => [o, { type: 'number' }])), required: q.options, additionalProperties: false } },
          required: ['probabilities'],
        }
      : {
          type: 'object',
          properties: { probabilities: { type: 'object', properties: { score: { type: 'number' } }, required: ['score'], additionalProperties: false } },
          required: ['probabilities'],
        };
  }
  return {
    type: 'object',
    properties: { answers: { type: 'object', properties: perQuestion, required: Object.keys(questions), additionalProperties: false } },
    required: ['answers'],
  };
}

/**
 * Pure: parse a model reply into the endpoint's answers map. Accepts the
 * bare JSON object or JSON wrapped in prose/fences (first balanced {...}
 * wins). Each choice map is clamped to the declared options, negatives
 * and non-numbers dropped, and the remainder normalized to sum 1; a
 * question whose map ends up empty (or whose score is not a finite
 * 0..1 number) is OMITTED — the router reads an omitted answer as a
 * per-question transport failure, never as a verdict.
 */
export function parseSystemOneAnswers(text, questions) {
  if (typeof text !== 'string' || !text) return {};
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {
    const start = text.indexOf('{');
    if (start >= 0) {
      let depth = 0;
      for (let i = start; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}' && --depth === 0) {
          try { parsed = JSON.parse(text.slice(start, i + 1)); } catch {}
          break;
        }
      }
    }
  }
  const raw = parsed?.answers;
  if (!raw || typeof raw !== 'object') return {};
  const answers = {};
  for (const [name, q] of Object.entries(questions)) {
    const probs = raw[name]?.probabilities;
    if (!probs || typeof probs !== 'object') continue;
    if (isScore(q)) {
      const v = Number(probs.score);
      if (Number.isFinite(v) && v >= 0 && v <= 1) answers[name] = { probabilities: { score: v } };
      continue;
    }
    const clean = {};
    let sum = 0;
    for (const opt of q.options) {
      const v = Number(probs[opt]);
      if (Number.isFinite(v) && v > 0) { clean[opt] = v; sum += v; }
    }
    if (sum <= 0) continue;
    const normalized = {};
    for (const [opt, v] of Object.entries(clean)) normalized[opt] = Math.round((v / sum) * 1e6) / 1e6;
    answers[name] = { probabilities: normalized };
  }
  return answers;
}

/**
 * The request handler. Deps are injected for tests: `fetchImpl` and
 * `ollamaBaseUrl` address the Ollama the adapter fronts. Returns an
 * (req, res) listener for node:http; also usable standalone via
 * startSystemOneServer.
 */
export function createSystemOneHandler({ ollamaBaseUrl = 'http://127.0.0.1:11434', fetchImpl = globalThis.fetch, log = () => {} } = {}) {
  const ollama = String(ollamaBaseUrl).replace(/\/$/, '');
  const installedHas = (tags, model) => (tags?.models ?? []).some((t) => t.name === model || t.name === `${model}:latest`);

  return async function systemOneHandler(req, res) {
    const send = (code, obj) => {
      const bodyText = JSON.stringify(obj);
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(bodyText);
    };
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/health') return send(200, { ok: true, service: 'kingmaker-systemone-shim' });
      if (req.method !== 'POST' || url.pathname !== '/v1/systemone') return send(404, { error: 'not found' });

      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 1024 * 1024) return send(413, { error: 'request too large' });
      }
      let parsedBody;
      try { parsedBody = JSON.parse(body); } catch { return send(400, { error: 'request body is not JSON' }); }
      const v = validateSystemOneRequest(parsedBody);
      if (v.error) return send(400, { error: v.error });

      // Model presence: the fallback when models are absent is the
      // router's reasoning path, reached via a transport failure — so
      // an absent model is a 503 here, never a fabricated answer.
      let tags;
      try {
        const tagsRes = await fetchImpl(`${ollama}/api/tags`);
        if (!tagsRes.ok) throw new Error(`ollama /api/tags HTTP ${tagsRes.status}`);
        tags = await tagsRes.json();
      } catch (err) {
        log('systemone_ollama_unreachable', { error: String(err?.message ?? err).slice(0, 160) });
        return send(503, { error: `decision model host unreachable: ${String(err?.message ?? err)}` });
      }
      if (!installedHas(tags, v.model)) {
        log('systemone_model_absent', { model: v.model });
        return send(503, { error: `decision model "${v.model}" is not installed in Ollama — reflex falls back to reasoning` });
      }

      // The registry models are classifiers: they refuse /api/generate
      // ("does not support generate"). Ollama serves them natively at
      // /v1/systemone — one call for all questions, in the contract
      // dialect buildNativeSystemOneRequest translates into.
      const { request: nativeReq, levels } = buildNativeSystemOneRequest(v);
      let genRes;
      try {
        genRes = await fetchImpl(`${ollama}/v1/systemone`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(nativeReq),
        });
      } catch (err) {
        log('systemone_native_unreachable', { error: String(err?.message ?? err).slice(0, 160) });
        return send(503, { error: `decision model call failed: ${String(err?.message ?? err)}` });
      }
      if (!genRes.ok) {
        const nativeErr = await genRes.json().catch(() => null);
        log('systemone_native_failed', { model: v.model, status: genRes.status, error: String(nativeErr?.error ?? '').slice(0, 160) });
        return send(503, { error: `decision model call returned HTTP ${genRes.status}${nativeErr?.error ? `: ${nativeErr.error}` : ''}` });
      }
      const native = await genRes.json().catch(() => null);
      const answers = translateNativeAnswers(native, v.questions, levels);
      log('systemone_answered', { model: v.model, questions: Object.keys(v.questions).length, answered: Object.keys(answers).length });
      return send(200, { answers });
    } catch (err) {
      log('systemone_error', { error: String(err?.message ?? err).slice(0, 160) });
      try { return send(500, { error: String(err?.message ?? err) }); } catch { return undefined; }
    }
  };
}

/** Start the adapter on a loopback port. Resolves { server, port, baseUrl } once listening. */
export function startSystemOneServer({ port = SYSTEMONE_DEFAULT_PORT, ...deps } = {}) {
  const host = '127.0.0.1';
  const server = openLoopbackServer(createSystemOneHandler(deps));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server['listen'](port, host, () => {
      const actual = server.address().port;
      resolve({ server, port: actual, baseUrl: `http://${host}:${actual}` });
    });
  });
}
