// lib/tool-runner.mjs — runs a USER-SELECTED tool for the conductor's run-tool step (local-brain tool methods,
// 2026-11-16). The only way a method reaches a program on the user's machine:
//   · the tool must be in the user's selected-tool registry (<state>/abilities/tools.json), resolved to the absolute
//     path recorded when they selected it — a method cannot name an arbitrary binary;
//   · no shell: argv is passed as an array (no globbing, pipes, redirection or substitution);
//   · a scrubbed environment (PATH, LANG, HOME/TMPDIR = the work dir) — no tokens, keys or the user's env vars;
//   · cwd is the conduction's work dir; stdin is closed; a hard timeout; output capped;
//   · every step not marked readOnly needs approve({ tool, path, args }) to return true BEFORE it runs — the exact argv
//     is shown; no approver → refused;
//   · output streams line by line, in order, to onOutput(stream, line) as it arrives (stdout/stderr interleaved by
//     arrival), with secret-shaped strings redacted in both the stream and the stored result.
// Tool output is untrusted data: it is recorded and shown, never interpreted as an instruction.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const SECRET = [/\b(gh[pousr]_[A-Za-z0-9]{20,})/g, /\b(sk-[A-Za-z0-9_-]{20,})/g, /\b(AKIA[0-9A-Z]{16})\b/g, /\b(xox[abpr]-[A-Za-z0-9-]{10,})/g,
  /(-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----)/g, /((?:password|passwd|secret|token|api[_-]?key)\s*[=:]\s*)(\S+)/gi];
export function redact(text) {
  let t = String(text);
  for (const re of SECRET) t = t.replace(re, (m, a, b) => (b !== undefined && typeof b === 'string' ? `${a}[redacted]` : '[redacted]'));
  return t;
}

export function readToolRegistry(state) {
  try { return JSON.parse(readFileSync(join(state, 'abilities', 'tools.json'), 'utf8')); } catch { return { schema: 'kingmaker.selected-tools/1', tools: {} }; }
}

export function createToolRunner({ registry, approve = null, onOutput = () => {}, timeoutMs = 60_000, maxBytes = 1 << 20 } = {}) {
  const tools = registry?.tools ?? {};
  return async function runTool({ tool, args = [], readOnly = false, cwd }) {
    const entry = tools[tool];
    if (!entry?.path) return { refused: `"${tool}" is not one of the tools you selected for Kingmaker (kingmaker tools scan to add it)`, exitCode: null, ms: 0 };
    if (!readOnly) {
      const ok = typeof approve === 'function' ? await approve({ tool, path: entry.path, args }) : false;
      if (!ok) return { refused: `approval required to run ${tool} ${args.join(' ')} (not marked read-only)`, exitCode: null, ms: 0, needsApproval: { tool, args } };
    }
    const t0 = performance.now();
    const lines = [];
    let stdout = '', stderr = '', bytes = 0, truncated = false;
    const child = spawn(entry.path, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin', LANG: 'C', LC_ALL: 'C', HOME: cwd, TMPDIR: cwd } });
    const take = (stream) => {
      let buf = '';
      return (chunk) => {
        bytes += chunk.length; if (bytes > maxBytes) { if (!truncated) { truncated = true; child.kill('SIGTERM'); } return; }
        buf += chunk.toString('utf8');
        let i; while ((i = buf.indexOf('\n')) >= 0) { const line = redact(buf.slice(0, i)); buf = buf.slice(i + 1); lines.push({ ms: Math.round(performance.now() - t0), stream, line }); onOutput(stream, line); if (stream === 'stdout') stdout += `${line}\n`; else stderr += `${line}\n`; }
        child.__flush ??= {}; child.__flush[stream] = () => { if (buf) { const line = redact(buf); lines.push({ ms: Math.round(performance.now() - t0), stream, line }); onOutput(stream, line); if (stream === 'stdout') stdout += line; else stderr += line; buf = ''; } };
      };
    };
    child.stdout.on('data', take('stdout')); child.stderr.on('data', take('stderr'));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    const exitCode = await new Promise((res) => { child.on('error', (e) => { stderr += redact(e.message); res(127); }); child.on('close', (code, sig) => res(code ?? (sig ? 128 : 1))); });
    clearTimeout(timer);
    for (const f of Object.values(child.__flush ?? {})) f();
    return { exitCode, stdout, stderr, lines, ms: Math.round(performance.now() - t0), truncated, path: entry.path, argv: args };
  };
}
