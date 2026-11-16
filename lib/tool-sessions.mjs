// lib/tool-sessions.mjs — Kingmaker's tool sessions: the state behind the lightweight per-tool reporting panel
// (2026-11-16). One session per tool Kingmaker starts. Each session reports, truthfully:
//   state     starting → running → completed | failed | cancelled | cancel-failed (never "done" until the process exited
//             and its exit was observed; never "dormant" until the process is verified gone)
//   activity  the latest meaningful output line (blank and progress-only lines skipped)
//   progress  a percentage ONLY when the tool's own output carries measurable progress (a parser per tool: Blender
//             "Sample n/N" / "Rendered n/N Tiles", generic "n/N" or "NN%"); otherwise null — never invented
//   output    every line, ordered, stream-tagged, secrets redacted (expandable in the panel)
// Input: send(id, text) writes to the tool's stdin only for sessions started interactive; otherwise it is refused.
// Cancel/dismiss: the panel goes away at once; Kingmaker requests cancellation (SIGTERM, then SIGKILL after a grace
// period) of the process group IT started, then verifies the pid is gone. Files are kept. Sessions the user started
// outside Kingmaker are never in this registry, so they can't be touched. A process that will not die is reported
// 'cancel-failed' with the pid, and the user is notified.
// Tools are resolved through the user's selected-tool registry (lib/tool-runner.mjs) — same allowlist, no shell,
// scrubbed environment; consequential runs still go through the caller's approval (the method lane's plan-first gate).
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { redact } from './tool-runner.mjs';

export const PROGRESS_PARSERS = Object.freeze({
  blender: (line) => { const m = /Sample (\d+)\/(\d+)/.exec(line) || /Rendered (\d+)\/(\d+) Tiles/.exec(line); return m ? Math.round((Number(m[1]) / Number(m[2])) * 100) : null; },
  generic: (line) => { const p = /(^|\s)(\d{1,3})%(\s|$)/.exec(line); if (p && Number(p[2]) <= 100) return Number(p[2]); const f = /\b(\d+)\s*\/\s*(\d+)\b/.exec(line); return f && Number(f[2]) > 0 && Number(f[1]) <= Number(f[2]) ? Math.round((Number(f[1]) / Number(f[2])) * 100) : null; },
  none: () => null,
});

export function createToolSessions({ registry, emit = () => {}, graceMs = 2000, now = () => Date.now() } = {}) {
  const sessions = new Map();
  const events = new EventEmitter();
  let seq = 0;
  const view = (s) => ({ id: s.id, tool: s.tool, label: s.label, state: s.state, activity: s.activity, progress: s.progress, exitCode: s.exitCode, signal: s.signal, startedAt: s.startedAt, endedAt: s.endedAt, lines: s.lines.length, visible: s.visible, cwd: s.cwd, note: s.note ?? null });
  const publish = (s, kind) => { const v = view(s); emit({ toolPanel: { kind, ...v } }); events.emit('update', kind, v); };
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

  function start({ tool, args = [], cwd, label = null, progress = 'generic', interactive = false }) {
    const entry = registry?.tools?.[tool];
    if (!entry?.path) throw new Error(`TOOL_NOT_SELECTED: "${tool}" is not one of the tools you selected for Kingmaker`);
    const id = `t${++seq}`;
    const s = { id, tool, label: label ?? `${tool} ${args.join(' ')}`.slice(0, 80), state: 'starting', activity: 'starting', progress: null, exitCode: null, signal: null, startedAt: now(), endedAt: null, lines: [], visible: true, cwd, interactive, child: null, parser: PROGRESS_PARSERS[progress] ?? PROGRESS_PARSERS.generic, cancelRequested: false };
    sessions.set(id, s);
    const child = spawn(entry.path, args, { cwd, shell: false, detached: true, stdio: [interactive ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin', LANG: 'C', LC_ALL: 'C', HOME: process.env.HOME ?? cwd, TMPDIR: cwd } });
    s.child = child; s.pid = child.pid;
    const t0 = performance.now();
    const take = (stream) => { let buf = ''; return (chunk) => {
      buf += chunk.toString('utf8');
      let i; while ((i = buf.search(/[\r\n]/)) >= 0) {
        const line = redact(buf.slice(0, i)); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        s.lines.push({ ms: Math.round(performance.now() - t0), stream, line });
        const p = s.parser(line); if (p != null) s.progress = p; else s.activity = line.slice(0, 160);
        if (s.state === 'starting') s.state = 'running';
        publish(s, 'output');
      }
    }; };
    child.stdout.on('data', take('stdout')); child.stderr.on('data', take('stderr'));
    child.on('spawn', () => { s.state = 'running'; s.activity = s.activity === 'starting' ? 'running' : s.activity; publish(s, 'state'); });
    child.on('error', (e) => { s.state = 'failed'; s.activity = `could not start: ${e.message}`; s.endedAt = now(); publish(s, 'state'); });
    child.on('close', (code, signal) => {
      s.exitCode = code; s.signal = signal; s.endedAt = now();
      if (s.cancelRequested) s.state = 'cancelled';
      else s.state = code === 0 ? 'completed' : 'failed';
      if (s.state === 'completed' && s.progress != null) s.progress = 100;
      publish(s, 'state');
    });
    publish(s, 'started');
    return view(s);
  }

  /** Route typed or spoken input to ONE tool. Refused unless that session was started interactive and is running. */
  function send(id, text) {
    const s = sessions.get(id);
    if (!s) return { ok: false, reason: 'no such tool session' };
    if (!s.interactive || s.state !== 'running') return { ok: false, reason: `${s.tool} is not accepting input (${s.interactive ? s.state : 'not interactive'})` };
    s.child.stdin.write(`${text}\n`); s.lines.push({ ms: null, stream: 'input', line: redact(text) }); publish(s, 'input');
    return { ok: true };
  }

  /** "I'm done with <tool>": hide the panel now; cancel what Kingmaker started; verify; report. */
  async function dismiss(id) {
    const s = sessions.get(id); if (!s) return { ok: false, reason: 'no such tool session' };
    s.visible = false; publish(s, 'dismissed');
    if (['completed', 'failed', 'cancelled'].includes(s.state)) return { ok: true, state: s.state, verifiedGone: !alive(s.pid) };
    s.cancelRequested = true;
    try { process.kill(-s.pid, 'SIGTERM'); } catch { try { process.kill(s.pid, 'SIGTERM'); } catch { /* already gone */ } }
    const waitGone = async (ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (!alive(s.pid)) return true; await new Promise((r) => setTimeout(r, 50)); } return !alive(s.pid); };
    let gone = await waitGone(graceMs);
    if (!gone) { s.note = `did not stop on SIGTERM within ${graceMs} ms; sent SIGKILL`; try { process.kill(-s.pid, 'SIGKILL'); } catch { try { process.kill(s.pid, 'SIGKILL'); } catch { /* gone */ } } gone = await waitGone(graceMs); }
    if (!gone) { s.state = 'cancel-failed'; s.note = `pid ${s.pid} is still running after SIGKILL — not dormant; Kingmaker will keep trying and tells you`; publish(s, 'cancel-failed'); return { ok: false, state: s.state, pid: s.pid }; }
    await new Promise((r) => setImmediate(r));
    if (s.state === 'running' || s.state === 'starting') { s.state = 'cancelled'; s.endedAt = now(); publish(s, 'state'); }
    return { ok: true, state: s.state, verifiedGone: true, note: s.note ?? null };
  }

  const wait = (id) => new Promise((resolve) => { const s = sessions.get(id); if (s && ['completed', 'failed', 'cancelled', 'cancel-failed'].includes(s.state)) return resolve(view(s)); const on = (kind, v) => { if (v.id === id && ['completed', 'failed', 'cancelled', 'cancel-failed'].includes(v.state)) { events.off('update', on); resolve(v); } }; events.on('update', on); });
  return { start, send, dismiss, wait, get: (id) => { const s = sessions.get(id); return s ? { ...view(s), output: s.lines } : null; }, list: () => [...sessions.values()].map(view), events };
}

/** The panel, rendered from session views with the user's bar settings (look black|system, accent, text size, font). */
export function renderToolPanels(views, { look = 'black', accent = '#4f9cff', textSize = 13, font = '-apple-system, BlinkMacSystemFont, sans-serif' } = {}) {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const bg = look === 'black' ? '#000' : 'Canvas', fg = look === 'black' ? '#eaeaea' : 'CanvasText';
  const badge = { running: accent, starting: accent, completed: '#3fb950', failed: '#f85149', cancelled: '#8b949e', 'cancel-failed': '#f85149' };
  return `<div class="km-tools" style="font:${textSize}px ${esc(font)};background:${bg};color:${fg}">${views.filter((v) => v.visible).map((v) => `
<section class="km-tool" data-id="${esc(v.id)}"><header><b>${esc(v.tool)}</b> <span style="color:${badge[v.state] ?? fg}">${esc(v.state)}</span>${v.progress != null ? ` <span>${v.progress}%</span>` : ''}</header>
<div class="activity">${esc(v.activity)}</div><details><summary>output (${v.lines} lines)</summary><pre data-output="${esc(v.id)}"></pre></details></section>`).join('')}</div>`;
}
