// Grok as Kingmaker's brain (opt-in: `kingmaker brain grok`, or SOL_GHOST_BRAIN=grok).
//
// This lane uses xAI's official Grok Build CLI in headless mode. Authentication is the cached login created by
// `grok login`; ambient XAI/GROK API keys are removed so selecting this lane never silently starts metered API use.
// Grok sees only Kingmaker's MCP surface. Built-in shell, file and web tools stay unavailable; every Mac/CRM action
// remains a Kingmaker proposal under the same owner-approval rules as the other brains.

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mcpConfig, NEW_CONVERSATION, SEED_MEMORY, SYSTEM_PROMPT } from './claude-brain.mjs';
import { meterCloud } from './token-meter.mjs';

// Grok's file tools stay disabled, so its project instructions are durable context, not self-editing memory.
const GROK_SYSTEM_PROMPT = SYSTEM_PROMPT.replace(/ Self-learning:.*$/, '');
const GROK_MEMORY = SEED_MEMORY.replace('Kingmaker edits this file itself. Keep it short: one line per lesson, newest last, merge duplicates.', 'This file is read-only context supplied by Kingmaker.');

export const grokDir = (paths) => join(paths.state, 'grok-brain');
const sessionFile = (paths) => join(grokDir(paths), 'session.json');

/** The Grok Build binary: SOL_GHOST_GROK_BIN, usual installs, then `grok` on PATH. */
export function findGrok(env = process.env, exists = existsSync, home = env.HOME || homedir()) {
  if (String(env.SOL_GHOST_GROK_BIN ?? '').trim()) return String(env.SOL_GHOST_GROK_BIN).trim();
  return [join(home, '.grok', 'bin', 'grok'), join(home, '.local', 'bin', 'grok'), '/opt/homebrew/bin/grok', '/usr/local/bin/grok']
    .find((p) => exists(p)) ?? 'grok';
}

/** Cached `grok login` only: never inherit a metered API key by accident. */
export function grokEnv(env = process.env) {
  const out = { ...env };
  for (const key of ['XAI_API_KEY', 'GROK_API_KEY', 'GROK_CODE_XAI_API_KEY', 'ELECTRON_RUN_AS_NODE']) delete out[key];
  // Grok's own store only: by default Grok Build also loads every Claude and Cursor skill, rule, instruction file, MCP
  // and hook on this Mac into each call (~32k of ~45k input tokens, measured 2026-10-10). Kingmaker's MCP stays.
  for (const vendor of ['CLAUDE', 'CURSOR']) for (const cell of ['SKILLS', 'RULES', 'AGENTS', 'MCPS', 'HOOKS']) out[`GROK_${vendor}_${cell}_ENABLED`] = 'false';
  out.PATH = [...new Set(['/opt/homebrew/bin', '/usr/local/bin', join(env.HOME || homedir(), '.grok', 'bin'), ...String(env.PATH || '').split(':').filter(Boolean)])].join(':');
  return out;
}

/** One bounded headless turn. Only MCPTool is enabled; Kingmaker itself remains the action/approval boundary. */
export function grokArgs({ text, sessionId = null, model = null }) {
  return [
    '--no-auto-update', '-p', text, '--output-format', 'json',
    '--tools', 'MCPTool', '--disallowed-tools', 'Bash,Edit,Write,Read,Grep,Glob,WebFetch,WebSearch',
    '--always-approve', '--no-plan', '--no-subagents', '--disable-web-search', '--max-turns', '8',
    ...(model ? ['--model', model] : []),
    ...(sessionId ? ['--resume', sessionId] : []),
  ];
}

/** Grok Build JSON mode: {text, stopReason, sessionId, requestId}. */
export function parseGrokOutput(stdout) {
  let data;
  // Grok Build prints one pretty-printed JSON object (many lines); older builds printed JSON lines. Whole first, then the last line.
  const raw = String(stdout ?? '').trim();
  try { data = JSON.parse(raw); } catch {
    try { data = JSON.parse(raw.split('\n').filter(Boolean).pop()); } catch { return { ok: false, text: '', sessionId: null, stopReason: null }; }
  }
  const text = typeof data?.text === 'string' ? data.text.trim() : '';
  const stopReason = data?.stopReason == null ? null : String(data.stopReason);
  const stoppedNormally = !stopReason || /^(end_turn|stop|complete|completed)$/i.test(stopReason);
  return { ok: Boolean(text) && stoppedNormally, text, sessionId: data?.sessionId ?? null, stopReason };
}

/** What Grok Build printed about its own usage, if anything (null when it prints none; nothing is guessed). Pure. */
export function grokUsage(stdout) {
  let d = null; const raw = String(stdout ?? '').trim();
  try { d = JSON.parse(raw); } catch { try { d = JSON.parse(raw.split('\n').filter(Boolean).pop()); } catch { /* none */ } }
  const u = d?.usage ?? null, n = (...v) => { const x = v.find((y) => Number.isFinite(Number(y))); return x == null ? null : Number(x); };
  return { model: d?.model ?? null, prompt: u ? n(u.input_tokens, u.prompt_tokens) : null, generated: u ? n(u.output_tokens, u.completion_tokens) : null, costUsd: n(d?.total_cost_usd, d?.cost_usd) };
}

export function createGrokBrain({ paths, port, say, log = () => {}, env = process.env, run = execFile, timeoutMs = 180_000 }) {
  const dir = grokDir(paths);
  mkdirSync(dir, { recursive: true });
  const memory = join(dir, 'AGENTS.md');
  if (!existsSync(memory)) writeFileSync(memory, `${GROK_MEMORY}\n## Operating rules\n${GROK_SYSTEM_PROMPT}\n`);
  // Grok Build reads project .mcp.json files. This directory contains only Kingmaker's MCP and its instruction file.
  writeFileSync(join(dir, '.mcp.json'), `${JSON.stringify(mcpConfig({ port }), null, 2)}\n`);
  let sessionId = null;
  try { sessionId = JSON.parse(readFileSync(sessionFile(paths), 'utf8')).sessionId ?? null; } catch { /* first turn */ }
  const bin = findGrok(env);

  const ask = (text) => new Promise((resolve) => {
    run(bin, grokArgs({ text, sessionId, model: env.SOL_GHOST_GROK_MODEL || null }), {
      cwd: dir, env: grokEnv(env), timeout: timeoutMs, maxBuffer: 8 * 2 ** 20,
    }, (error, stdout, stderr) => {
      const parsed = parseGrokOutput(stdout);
      const used = grokUsage(stdout);
      meterCloud({ provider: 'xai', ...used, model: used.model || env.SOL_GHOST_GROK_MODEL || 'grok', billing: 'subscription', outcome: parsed.ok ? 'ok' : 'error' });
      if (!parsed.ok) log('grok_brain_error', { code: error?.code ?? null, stopReason: parsed.stopReason, stderr: String(stderr ?? '').slice(0, 500) });
      resolve({ ...parsed, error: error && !parsed.ok ? (error.code === 'ENOENT' ? 'not_installed' : 'failed') : parsed.ok ? null : 'failed' });
    });
  });

  async function runTurn(text) {
    if (NEW_CONVERSATION.test(String(text).trim())) {
      sessionId = null;
      rmSync(sessionFile(paths), { force: true });
      await say('Fresh conversation.');
      return { followUp: false, ok: true, route: 'grok' };
    }
    let result = await ask(text);
    // A pruned/expired session is retried once as a new conversation.
    if (!result.ok && sessionId && result.error === 'failed') { sessionId = null; result = await ask(text); }
    if (!result.ok) {
      await say(result.error === 'not_installed'
        ? 'Grok Build is not installed on this Mac. Install the official Grok CLI, run grok login once, then try again.'
        : 'Grok did not answer. Run grok login in Terminal once to check you are signed in.');
      return { followUp: false, ok: false, reason: `grok_${result.error}`, route: 'grok' };
    }
    if (result.sessionId && result.sessionId !== sessionId) {
      sessionId = result.sessionId;
      writeFileSync(sessionFile(paths), `${JSON.stringify({ sessionId })}\n`, { mode: 0o600 });
    }
    await say(result.text);
    return { followUp: /\?\s*$/.test(result.text), ok: true, route: 'grok', answerChars: result.text.length };
  }

  return { runTurn, memoryPath: memory, bin };
}
