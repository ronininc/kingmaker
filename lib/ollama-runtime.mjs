// lib/ollama-runtime.mjs — the local brain's runtime, owned by Kingmaker itself.
//
// A fresh install used to dead-end here: the default brain is `local`, which needs Ollama
// answering on :11434 — but nothing in the unit installed, started, or provisioned it, so
// questions fell to a search lane that deflects and instructions fell to plan cards that
// execute nothing (Muse's 4.3 gauntlet, Check 8). The packaged unit now carries Ollama
// itself (brain/ollama in the install root; the packaging launcher points
// KINGMAKER_OLLAMA_BIN / KINGMAKER_OLLAMA_MODELS at it, and install.sh pulls the default
// models into that store through it). This module is the lifecycle for that runtime:
//
//   ensureOllama()      probe :11434; when it is silent and a binary is known (the bundled
//                       one first, then a system Ollama), start `ollama serve` detached,
//                       one model loaded, one request at a time, and record the pid in
//                       <state>/ollama-runtime.json so the stop is as owned as the start.
//   stopManagedOllama() stop exactly the server a Kingmaker process started (pid record +
//                       command-line proof, the same discipline as cmdStop's daemon check).
//
// A server the owner runs themselves is never adopted and never stopped: no record, no kill.
// A non-loopback OLLAMA_HOST is the owner's own arrangement and is only ever probed.

import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const OLLAMA_DEFAULT_BASE = 'http://127.0.0.1:11434';
/** The default local brain the unit's installer provisions (the server's own first-run tier). */
export const REQUIRED_BRAIN_MODELS = Object.freeze(['qwen3:0.6b', 'qwen3:1.7b']);
/** Everything the installer pulls for a fresh unit: the required tier + the coder + the intent embedder + the 8 GB profile's writer/router. */
export const DEFAULT_BRAIN_MODELS = Object.freeze([
  ...REQUIRED_BRAIN_MODELS,
  'qwen2.5-coder:1.5b',
  // The intent embedder's Ollama backend (solomon/server/src/runtime/intent-embedding-router.ts)
  // requests this model; unprovisioned, every such call 404s and the router silently degrades
  // to the static embedder (4.3 gauntlet receipt check). Provision it with the rest.
  'nomic-embed-text',
  'hf.co/mradermacher/Huihui-granite-4.1-3b-abliterated-i1-GGUF:i1-Q4_K_M',
]);

const base = (env = process.env) => String(env.OLLAMA_HOST || OLLAMA_DEFAULT_BASE).replace(/\/+$/, '');
const isLoopbackDefault = (env = process.env) => /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base(env)) && base(env).includes('11434');

export async function ollamaAnswering(env = process.env, timeoutMs = 2_000) {
  try {
    const r = await fetch(`${base(env)}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return { up: false, models: [] };
    const j = await r.json().catch(() => null);
    return { up: true, models: ((j?.models ?? []).map((m) => m.name).filter(Boolean)) };
  } catch { return { up: false, models: [] }; }
}

/** The Ollama binary Kingmaker may start: the unit's bundled one (env from the launcher, or the
 *  install-root layout relative to this file), then a user/system Ollama. Null when there is none. */
export function findOllamaBinary(env = process.env, home = homedir(), exists = existsSync) {
  const libDir = dirname(fileURLToPath(import.meta.url));
  const installRoot = join(libDir, '..', '..');
  const candidates = [
    env.KINGMAKER_OLLAMA_BIN, env.SOLOMON_OLLAMA_BIN, env.OLLAMA_BIN,
    join(installRoot, 'brain', 'ollama', 'bin', 'ollama'),
    join(installRoot, 'brain', 'ollama', 'ollama.exe'),
    join(installRoot, 'brain', 'ollama', 'ollama'),
    '/Applications/Ollama.app/Contents/Resources/ollama',
    join(home, 'Applications', 'Ollama.app', 'Contents', 'Resources', 'ollama'),
    '/opt/homebrew/bin/ollama', '/usr/local/bin/ollama',
    ...String(env.PATH || '').split(':').filter(Boolean).map((d) => join(d, 'ollama')),
  ];
  for (const c of candidates) { if (c && exists(c)) return c; }
  return null;
}

const recordFile = (paths) => join(paths.state, 'ollama-runtime.json');
function readRecord(paths) { try { return JSON.parse(readFileSync(recordFile(paths), 'utf8')); } catch { return null; } }
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } };

/** Is this pid really the Ollama server the record names? (A reused pid must never be signalled.) */
function pidIsOllama(pid, bin) {
  if (process.platform === 'linux') {
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
      return cmd.includes('ollama') && (!bin || cmd.includes(bin) || /ollama serve/.test(cmd));
    } catch { return false; }
  }
  return true; // no cheap proof off Linux; the record is 0600 in the owner's own state dir
}

/**
 * Make sure the local brain's runtime answers. Starts the bundled/system Ollama when the
 * loopback endpoint is silent; never touches a non-loopback OLLAMA_HOST. Returns
 * { up, started, bin, modelsDir, models, reason? }.
 */
export async function ensureOllama({ paths, env = process.env, log = () => {}, timeoutMs = 60_000 } = {}) {
  const first = await ollamaAnswering(env);
  if (first.up) return { up: true, started: false, models: first.models };
  if (!isLoopbackDefault(env)) return { up: false, started: false, reason: 'remote-host' };
  // A server a previous Kingmaker started may still be coming up: wait for it before spawning another.
  const prior = readRecord(paths);
  if (prior?.pid && pidAlive(prior.pid) && pidIsOllama(prior.pid, prior.bin)) {
    const until = Date.now() + Math.min(timeoutMs, 15_000);
    while (Date.now() < until) {
      const p = await ollamaAnswering(env);
      if (p.up) return { up: true, started: false, models: p.models };
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  const bin = findOllamaBinary(env);
  if (!bin) return { up: false, started: false, reason: 'no-binary' };
  const modelsDir = String(env.KINGMAKER_OLLAMA_MODELS || env.OLLAMA_MODELS || '').trim() || null;
  mkdirSync(paths.logs, { recursive: true, mode: 0o700 });
  mkdirSync(paths.state, { recursive: true, mode: 0o700 });
  if (modelsDir) mkdirSync(modelsDir, { recursive: true });
  const fd = openSync(join(paths.logs, 'ollama.log'), 'a');
  const childEnv = {
    ...env,
    OLLAMA_HOST: '127.0.0.1:11434',
    ...(modelsDir ? { OLLAMA_MODELS: modelsDir } : {}),
    OLLAMA_MAX_LOADED_MODELS: String(env.OLLAMA_MAX_LOADED_MODELS || '1'),
    OLLAMA_NUM_PARALLEL: String(env.OLLAMA_NUM_PARALLEL || '1'),
  };
  let child;
  try {
    child = spawn(bin, ['serve'], { detached: true, stdio: ['ignore', fd, fd], env: childEnv, windowsHide: true });
  } finally { try { closeSync(fd); } catch { /* the child holds its own dup */ } }
  child.unref();
  try { writeFileSync(recordFile(paths), JSON.stringify({ pid: child.pid, bin, modelsDir, startedAt: new Date().toISOString(), startedBy: 'kingmaker' }, null, 2), { mode: 0o600 }); } catch { /* the record is bookkeeping; the server is the fact */ }
  log('ollama_started', { pid: child.pid, bin, modelsDir });
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const p = await ollamaAnswering(env);
    if (p.up) return { up: true, started: true, bin, modelsDir, models: p.models };
    if (!pidAlive(child.pid)) return { up: false, started: true, bin, modelsDir, reason: 'server-exited' };
    await new Promise((r) => setTimeout(r, 500));
  }
  return { up: false, started: true, bin, modelsDir, reason: 'server-slow' };
}

/** Stop the Ollama server a Kingmaker process started (and only that one). True when one was stopped. */
export async function stopManagedOllama({ paths } = {}) {
  const rec = readRecord(paths);
  if (!rec?.pid) return false;
  let stopped = false;
  if (pidAlive(rec.pid) && pidIsOllama(rec.pid, rec.bin)) {
    try { process.kill(rec.pid, 'SIGTERM'); stopped = true; } catch { /* already gone */ }
    const until = Date.now() + 5_000;
    while (stopped && Date.now() < until && pidAlive(rec.pid)) await new Promise((r) => setTimeout(r, 100));
    if (stopped && pidAlive(rec.pid)) { try { process.kill(rec.pid, 'SIGKILL'); } catch { /* gone */ } }
  }
  try { rmSync(recordFile(paths), { force: true }); } catch { /* fine */ }
  return stopped;
}
