// lib/tool-call.mjs — reliable tool calls from small local models: two short calls, each held to a JSON schema by Ollama.
//   1. PICK: which tool (or "none"). The reply is forced by `format` to {"tool": <one of the names or "none">}, so a
//      3–4B model can't invent a tool, misspell one or ramble.
//   2. ARGS: the chosen tool's arguments. The reply is forced by `format` to that tool's own JSON schema (its required
//      keys, types and enums).
// Prompt-only JSON ("answer ONLY JSON …") breaks on small models: they keep talking, wrap the JSON in prose, or drop a
// required key. Ollama's structured outputs constrain decoding to the schema, and splitting pick and args keeps each
// call short, which is what an 8 GB Mac needs (one small model, a 4k context). `native` is Ollama's own tool calling
// (the `tools` field) for models whose template supports it; `kingmaker models bench` measures both on every candidate.
// Nothing here runs a tool: the caller gets {name, arguments} and every send, payment or record change keeps its gate.

import { meter, meterFail } from './token-meter.mjs';

const BASE = () => process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
export const NO_TOOL = 'none';

/** Pure: an OpenAI/Ollama-style tool → { name, description, parameters }. */
const fn = (t) => t?.function ?? t;

/** Pure: the schema of the PICK reply: one of the tool names, or "none". */
export function pickSchema(tools) {
  return { type: 'object', properties: { tool: { type: 'string', enum: [...tools.map((t) => fn(t).name), NO_TOOL] } }, required: ['tool'] };
}

/** Pure: the system line for the PICK call: every tool in one line each, and when to say none. */
export function pickPrompt(tools) {
  const lines = tools.map((t) => `- ${fn(t).name}: ${fn(t).description}`).join('\n');
  return `Pick the one tool that does what the user asks next, or "${NO_TOOL}" when no tool fits (a question you can answer in words, or something none of these tools can do). Tools:\n${lines}\nReply as JSON: {"tool": "<name or ${NO_TOOL}>"}.`;
}

/** Pure: the system line for the ARGS call. */
export function argsPrompt(tool) {
  const f = fn(tool);
  const props = Object.entries(f.parameters?.properties ?? {}).map(([k, v]) => `- ${k}${(f.parameters.required ?? []).includes(k) ? ' (required)' : ''}: ${v.description ?? v.type}`).join('\n');
  return `Fill in the arguments of ${f.name} (${f.description}) from the conversation. Use only what the user said or a tool returned; copy names, numbers and dates exactly. Arguments:\n${props}\nReply as JSON with exactly these keys.`;
}

/** Pure: does a value fit a (flat) JSON schema? Required keys present, types and enums right. */
export function fitsSchema(value, schema) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  for (const key of schema?.required ?? []) if (value[key] === undefined || value[key] === null || value[key] === '') return false;
  for (const [key, spec] of Object.entries(schema?.properties ?? {})) {
    const v = value[key];
    if (v === undefined) continue;
    if (spec.enum && !spec.enum.includes(v)) return false;
    if (spec.type === 'number' && typeof v !== 'number') return false;
    if (spec.type === 'integer' && !Number.isInteger(v)) return false;
    if (spec.type === 'string' && typeof v !== 'string') return false;
    if (spec.type === 'boolean' && typeof v !== 'boolean') return false;
  }
  return true;
}

/** One /api/chat call. `think: false` keeps Qwen3-family models from reasoning out loud; a model with no thinking
 *  support that refuses the flag is asked again without it. */
export async function chat({ model, messages, format, tools, options = {}, base = BASE(), timeoutMs = 120_000, fetchImpl = fetch, keepAlive = '10m' }) {
  const send = async (think) => {
    const body = { model, messages, stream: false, keep_alive: keepAlive, options: { temperature: 0, ...options }, ...(format ? { format } : {}), ...(tools ? { tools } : {}), ...(think === undefined ? {} : { think }) };
    const r = await fetchImpl(`${base.replace(/\/$/, '')}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    const text = await r.text();
    let j = null; try { j = JSON.parse(text); } catch { /* below */ }
    return { ok: r.ok, status: r.status, j, text };
  };
  let res;
  try { res = await send(false); if (!res.ok && /think/i.test(res.text)) res = await send(undefined); } catch (error) { meterFail({ kind: 'tool', model, error }); throw error; }
  if (!res.ok) { meterFail({ kind: 'tool', model }); throw new Error(`${model} answered ${res.status}: ${String(res.j?.error ?? res.text).slice(0, 160)}`); }
  meter(res.j, { kind: 'tool', model });
  return res.j;
}

/** Pure: the JSON object in a reply. Measured on Ollama 0.31: `format` is not enforced for every model (qwen3.5 on
 *  Ollama's own engine wraps its answer in a ```json fence), so the first {...} is read and fitsSchema decides. */
export function parseReply(s) {
  const t = String(s ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  try { return JSON.parse(t); } catch { /* fenced or with prose */ }
  const start = t.indexOf('{');
  for (let end = t.lastIndexOf('}'); start >= 0 && end > start; end = t.lastIndexOf('}', end - 1)) {
    try { return JSON.parse(t.slice(start, end + 1)); } catch { /* shorter */ }
  }
  return null;
}
const parse = parseReply;

/**
 * TWO-STEP: pick the tool, then build its arguments, each held to a schema. Returns { name, arguments, ms } or
 * { name: 'none' } when no tool fits (or the args never fit the schema, after one retry). Never throws for a bad
 * reply: a reply that doesn't parse is "none", so a wrong guess does nothing.
 */
export async function twoStepCall({ model, messages, tools, options = {}, base, fetchImpl, timeoutMs }) {
  const t0 = Date.now();
  const convo = messages.filter((m) => m.role !== 'system');
  const picked = await chat({ model, base, fetchImpl, timeoutMs, options: { num_predict: 24, ...options }, format: pickSchema(tools), messages: [{ role: 'system', content: pickPrompt(tools) }, ...convo] });
  const name = parse(picked?.message?.content)?.tool;
  const tool = tools.find((t) => fn(t).name === name);
  if (!tool) return { name: NO_TOOL, ms: Date.now() - t0 };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const built = await chat({ model, base, fetchImpl, timeoutMs, options: { num_predict: 200, ...options }, format: fn(tool).parameters, messages: [{ role: 'system', content: argsPrompt(tool) }, ...convo] });
    const args = parse(built?.message?.content);
    if (fitsSchema(args, fn(tool).parameters)) return { name, arguments: args, ms: Date.now() - t0 };
  }
  return { name: NO_TOOL, why: 'arguments_did_not_fit', ms: Date.now() - t0 };
}

/** NATIVE: Ollama's own tool calling (the `tools` field). Returns the first call, or { name: 'none' }. */
export async function nativeCall({ model, messages, tools, options = {}, base, fetchImpl, timeoutMs }) {
  const t0 = Date.now();
  const r = await chat({ model, base, fetchImpl, timeoutMs, options: { num_predict: 256, ...options }, tools, messages });
  const call = r?.message?.tool_calls?.[0]?.function;
  if (!call?.name) return { name: NO_TOOL, ms: Date.now() - t0 };
  const args = typeof call.arguments === 'string' ? parse(call.arguments) : call.arguments;
  return { name: call.name, arguments: args ?? {}, ms: Date.now() - t0 };
}
