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
// it takes the typed request, asks the SAME registered decision model
// through Ollama's ordinary generate API — one batched call for all
// questions, a JSON-schema-constrained reply — and translates the
// model's probability map back into the endpoint's shape. The model
// doing the scoring is the registry model itself (tev1/laya/...), never
// a substitute brain; this file contains no decision logic of its own
// beyond parsing, clamping to the declared answer space, and
// normalizing each map to sum 1.
//
// FAILURE POSTURE — the fallback is the contract, not an accident:
//   model not installed in Ollama  -> 503 (router: transport-failed)
//   Ollama unreachable             -> 503
//   model output unparseable       -> that question's answer is OMITTED
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
// SCORE QUESTIONS (kind: 'score'): the model rates 0..1 and the rating
// rides the probabilities map under the single key 'score', so the
// router's calibration bands read as confidence in the rating (a 0.95
// rating auto-proceeds; a 0.3 rating escalates). No in-tree caller
// emits score questions today; the convention is the shim's, stated
// here so it is never a surprise.
//
// WIRING: the console points DecisionRouter at Ollama directly by
// default (unchanged). With KINGMAKER_SYSTEMONE=local it starts this
// server on a loopback port fronting Ollama and points the router at
// it instead (lib/cli.mjs). KINGMAKER_SYSTEMONE_PORT overrides the
// port (default 11435, beside Ollama's 11434).

import { createServer } from 'node:http';
import { DECISION_MODEL_REGISTRY } from './decision-router.mjs';

export const SYSTEMONE_DEFAULT_PORT = 11435;
const OFF_WORDS = new Set(['0', 'off', 'false', 'no']);

/** Pure: is the in-tree endpoint switched on? Env KINGMAKER_SYSTEMONE=local (or 1/true/on/yes). Default off. */
export function systemOneShimEnabled({ env = process.env } = {}) {
  const raw = env?.KINGMAKER_SYSTEMONE;
  if (raw === undefined) return false;
  const v = String(raw).trim().toLowerCase();
  if (OFF_WORDS.has(v)) return false;
  return v === 'local' || v === '1' || v === 'true' || v === 'on' || v === 'yes';
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
    if (!isChoice(q) && !isScore(q)) return { error: `question "${name}" has no fixed answer space (options: [..] or kind: 'score')` };
  }
  return { model, state: state && typeof state === 'object' ? state : {}, questions };
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

      let genRes;
      try {
        genRes = await fetchImpl(`${ollama}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: v.model,
            prompt: buildSystemOnePrompt(v),
            stream: false,
            format: systemOneResponseSchema(v.questions),
            options: { temperature: 0, num_ctx: 2048 },
          }),
        });
      } catch (err) {
        log('systemone_generate_unreachable', { error: String(err?.message ?? err).slice(0, 160) });
        return send(503, { error: `decision model call failed: ${String(err?.message ?? err)}` });
      }
      if (!genRes.ok) {
        log('systemone_generate_failed', { model: v.model, status: genRes.status });
        return send(503, { error: `decision model call returned HTTP ${genRes.status}` });
      }
      const gen = await genRes.json().catch(() => null);
      const answers = parseSystemOneAnswers(gen?.response, v.questions);
      log('systemone_answered', { model: v.model, questions: Object.keys(v.questions).length, answered: Object.keys(answers).length });
      return send(200, { answers });
    } catch (err) {
      log('systemone_error', { error: String(err?.message ?? err).slice(0, 160) });
      try { return send(500, { error: String(err?.message ?? err) }); } catch { return undefined; }
    }
  };
}

/** Start the adapter on a loopback port. Resolves { server, port, baseUrl } once listening. */
export function startSystemOneServer({ port = SYSTEMONE_DEFAULT_PORT, host = '127.0.0.1', ...deps } = {}) {
  const server = createServer(createSystemOneHandler(deps));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const actual = server.address().port;
      resolve({ server, port: actual, baseUrl: `http://${host}:${actual}` });
    });
  });
}
