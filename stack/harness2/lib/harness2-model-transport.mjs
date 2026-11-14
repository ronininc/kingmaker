/**
 * lib/harness2-model-transport.mjs (kingmaker-stack)
 *
 * The real-model wiring for Harness². harness2-governed.mjs deliberately
 * ships no model calls — editors and the runner are injected. This module
 * is the injector: an HTTP model client (Ollama native API or any
 * OpenAI-compatible /v1 endpoint — llama.cpp server, LM Studio, a cloud
 * gateway) plus the two factories that turn it into governed parts:
 *
 *   createModelEditor(client)  → an editor: shows the model the current
 *     harness + task, asks for ONE component edit as JSON. Unparseable
 *     output produces no candidate (the propose stage drops it) — the
 *     model never gets to write outside the eight components.
 *
 *   createModelRunner(client)  → a runner: executes the task under the
 *     TRIAL harness (its systemPrompt + guidance components as context),
 *     then scores the result with a judge call against a fixed rubric.
 *     The score is behavioral contrast, exactly the upstream method —
 *     evidence, not proof; adoption still needs the founder tap.
 *
 * No telemetry, no retries with side effects, temperature 0 throughout:
 * the same harness + task should draw the same edit and the same score.
 */

import { HARNESS_COMPONENTS } from './harness2-governed.mjs';

const DEFAULT_TIMEOUT_MS = 120_000;

function extractJson(text) {
  const t = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(t.slice(start, end + 1)); } catch { return null; }
}

/**
 * createModelClient({ protocol, baseUrl, model, fetchImpl, timeoutMs })
 *   protocol 'ollama' → POST {baseUrl}/api/chat
 *   protocol 'openai' → POST {baseUrl}/v1/chat/completions
 * Returns { chat({system, user}) → assistant text, protocol, model }.
 */
export function createModelClient({ protocol = 'ollama', baseUrl = 'http://127.0.0.1:11434', model, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!model) throw new Error('harness2-transport: a model name is required');
  if (!['ollama', 'openai'].includes(protocol)) throw new Error(`harness2-transport: unknown protocol "${protocol}"`);
  const doFetch = fetchImpl ?? fetch;
  const root = String(baseUrl).replace(/\/$/, '');

  async function chat({ system, user }) {
    const messages = [
      ...(system ? [{ role: 'system', content: String(system) }] : []),
      { role: 'user', content: String(user) },
    ];
    const url = protocol === 'ollama' ? `${root}/api/chat` : `${root}/v1/chat/completions`;
    const body = protocol === 'ollama'
      ? { model, messages, stream: false, options: { temperature: 0 } }
      : { model, messages, temperature: 0, stream: false };
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`harness2-transport: ${protocol} endpoint HTTP ${res.status}`);
    const json = await res.json();
    const text = protocol === 'ollama' ? json?.message?.content : json?.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw new Error('harness2-transport: endpoint returned no message content');
    return text;
  }
  return { chat, protocol, model };
}

const EDITOR_SYSTEM = [
  'You improve an agent harness. A harness has exactly these components:',
  HARNESS_COMPONENTS.join(', ') + '.',
  'Propose ONE edit: replace the whole content of ONE component.',
  'Answer with a single JSON object and nothing else:',
  '{"component": "<one of the components>", "content": "<the full new content>", "rationale": "<one sentence>"}',
].join('\n');

/** An editor backed by a real model. */
export function createModelEditor(client) {
  return async function modelEditor(harness, task) {
    const current = HARNESS_COMPONENTS
      .map((c) => `## ${c}\n${String(harness?.components?.[c] ?? '(empty)').slice(0, 1200)}`)
      .join('\n\n');
    const user = `Task: ${task?.title ?? task?.id ?? 'untitled'}\n${task?.prompt ?? task?.description ?? ''}\n\nCurrent harness:\n${current}\n\nYour one edit:`;
    const parsed = extractJson(await client.chat({ system: EDITOR_SYSTEM, user }));
    if (!parsed || !HARNESS_COMPONENTS.includes(parsed.component) || typeof parsed.content !== 'string') return [];
    return [{ component: parsed.component, content: parsed.content, rationale: String(parsed.rationale ?? '').slice(0, 500) }];
  };
}

const JUDGE_SYSTEM = [
  'You score how well an agent output accomplishes its task.',
  'Answer with a single JSON object and nothing else:',
  '{"score": <0 to 1>, "signal": "<one line: the strongest observed difference>"}',
  'Score 1 only when the task is fully accomplished. Be strict; a fluent',
  'answer that misses the task scores low.',
].join('\n');

/** A runner backed by a real model: execute under the trial harness, then judge. */
export function createModelRunner(client, { judgeClient } = {}) {
  const judge = judgeClient ?? client;
  return async function modelRunner(trialHarness, task) {
    const c = trialHarness?.components ?? {};
    const context = ['toolGuidance', 'memory', 'skills']
      .filter((k) => c[k])
      .map((k) => `[${k}]\n${c[k]}`)
      .join('\n\n');
    const output = await client.chat({
      system: [c.systemPrompt ?? '', context].filter(Boolean).join('\n\n'),
      user: String(task?.prompt ?? task?.description ?? task?.title ?? ''),
    });
    const judged = extractJson(await judge.chat({
      system: JUDGE_SYSTEM,
      user: `Task:\n${task?.prompt ?? task?.description ?? task?.title ?? ''}\n\nAgent output:\n${output.slice(0, 4000)}\n\nYour score:`,
    }));
    if (!judged || typeof judged.score !== 'number') {
      return { score: null, signal: 'judge returned no usable score' };
    }
    return { score: Math.max(0, Math.min(1, judged.score)), signal: String(judged.signal ?? '').slice(0, 500) };
  };
}
